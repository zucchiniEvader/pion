// KanbanStore: per-project projection over <project>/.pion/kanban/events.jsonl.
//
// The event file is the only truth (docs/kanban-design.md §2): user actions
// (IPC handlers) and worker agents (kanban-bridge extension, terminal `pi -e`)
// all append single lines, and this store watches the file to converge its
// in-memory projection no matter who wrote. The directory is NOT created by
// load — only an explicit user action (create) materializes .pion/ in the
// user's project.
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { KanbanBoard, KanbanCard, KanbanEvent } from '../src/types'
import { applyKanbanEvent, parseKanbanEventLine, replayKanbanEvents } from '../src/lib/kanbanReducer'

const KANBAN_DIR = ['.pion', 'kanban'] as const
const EVENTS_FILE = 'events.jsonl'
// External writers (bridge tools during a worker run) may append bursts;
// coalesce watcher storms into at most one re-read per interval.
const RELOAD_THROTTLE_MS = 150
const MAX_NOTE_CHARS = 8_192
const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS = 32_768

export function newKanbanCardId(): string {
  return `k_${randomBytes(4).toString('hex')}`
}

export function newKanbanNoteId(): string {
  return `n_${randomBytes(4).toString('hex')}`
}

export function kanbanEventFile(projectPath: string): string {
  return join(projectPath, ...KANBAN_DIR, EVENTS_FILE)
}

export interface KanbanCreateInput {
  title: string
  body?: string
  acceptance?: string[]
}

export interface KanbanUpdateInput {
  title?: string
  body?: string
  acceptance?: string[]
}

export interface KanbanAssignInput {
  sessionFile: string
  model?: string
  label?: string
}

export class KanbanStore {
  /** Cards in creation (fold) order; runState is overlaid by the caller. */
  cards: KanbanCard[] = []
  /** False until an explicit user action created .pion/kanban in the project. */
  enabled = false
  private readonly file: string
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private reloadInFlight: Promise<void> = Promise.resolve()
  private fingerprint = '[]'
  // Serializes appends so concurrent IPC calls land as file lines in the
  // same order they are folded into memory; the throttled re-read from the
  // watcher converges any transient divergence.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly projectPath: string,
    private readonly onChange?: () => void,
    /**
     * Event file override: per-project stores derive <project>/.pion/kanban/
     * events.jsonl; the unassigned (global) store passes a userData path.
     */
    file: string = kanbanEventFile(projectPath),
  ) {
    this.file = file
  }

  /** Reads + replays the event log if it exists; never creates anything. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.cards = []
      this.enabled = false
      return
    }
    this.enabled = true
    const events: KanbanEvent[] = []
    for (const line of raw.split('\n')) {
      const event = parseKanbanEventLine(line)
      if (event) events.push(event)
    }
    this.cards = replayKanbanEvents(events)
    this.fingerprint = JSON.stringify(this.cards)
    this.startWatch()
  }

  board(): KanbanBoard {
    return { projectPath: this.projectPath, cards: this.cards }
  }

  card(cardId: string): KanbanCard {
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) throw new Error(`Card ${cardId} was not found.`)
    return card
  }

  private async append(event: KanbanEvent): Promise<void> {
    const task = this.queue.then(async () => {
      if (!this.enabled) {
        await mkdir(dirname(this.file), { recursive: true })
        this.enabled = true
        this.startWatch()
      }
      // Single open-append-close per line: one write() of one \n-terminated
      // line is atomic enough for local multi-writer appends.
      const handle = await open(this.file, 'a')
      try {
        await handle.write(JSON.stringify(event) + '\n')
      } finally {
        await handle.close()
      }
      this.cards = applyKanbanEvent(this.cards, event)
      this.fingerprint = JSON.stringify(this.cards)
      // Own writes push immediately; the watcher's later reload sees the same
      // fingerprint and stays quiet, so no double notification.
      this.onChange?.()
    })
    this.queue = task.catch(() => undefined)
    await task
  }

  private nowIso(): string {
    return new Date().toISOString()
  }

  async create(input: KanbanCreateInput): Promise<KanbanCard> {
    const title = input.title.trim()
    if (!title) throw new Error('Card title must not be empty.')
    if (title.length > MAX_TITLE_CHARS) throw new Error('Card title is too long.')
    if (input.body !== undefined && input.body.length > MAX_BODY_CHARS) throw new Error('Card body is too long.')
    const event: KanbanEvent = {
      v: 1,
      type: 'card_created',
      id: newKanbanCardId(),
      title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.acceptance?.length ? { acceptance: input.acceptance } : {}),
      ts: this.nowIso(),
    }
    await this.append(event)
    return this.card(event.id)
  }

  async update(cardId: string, patch: KanbanUpdateInput): Promise<KanbanCard> {
    this.card(cardId)
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) throw new Error('Card title must not be empty.')
      if (title.length > MAX_TITLE_CHARS) throw new Error('Card title is too long.')
    }
    if (patch.body !== undefined && patch.body.length > MAX_BODY_CHARS) throw new Error('Card body is too long.')
    const event: KanbanEvent = {
      v: 1,
      type: 'card_updated',
      id: cardId,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.acceptance !== undefined ? { acceptance: patch.acceptance } : {}),
      ts: this.nowIso(),
    }
    await this.append(event)
    return this.card(cardId)
  }

  async move(cardId: string, to: KanbanCard['status'], by: 'user' | 'agent' | 'system' = 'user'): Promise<KanbanCard> {
    this.card(cardId)
    await this.append({ v: 1, type: 'card_moved', id: cardId, to, by, ts: this.nowIso() })
    return this.card(cardId)
  }

  async assign(cardId: string, input: KanbanAssignInput): Promise<KanbanCard> {
    this.card(cardId)
    await this.append({
      v: 1,
      type: 'card_assigned',
      id: cardId,
      sessionFile: input.sessionFile,
      ...(input.model ? { model: input.model } : {}),
      ...(input.label ? { label: input.label } : {}),
      ts: this.nowIso(),
    })
    return this.card(cardId)
  }

  async addNote(cardId: string, source: KanbanCard['notes'][number]['source'], text: string, sessionFile?: string): Promise<KanbanCard> {
    this.card(cardId)
    const trimmed = text.trim()
    if (!trimmed) throw new Error('Note text must not be empty.')
    if (trimmed.length > MAX_NOTE_CHARS) throw new Error('Note is too long (max 8KB).')
    await this.append({
      v: 1,
      type: 'note_added',
      id: cardId,
      note: { id: newKanbanNoteId(), source, text: trimmed, ...(sessionFile ? { sessionFile } : {}) },
      ts: this.nowIso(),
    })
    return this.card(cardId)
  }

  async archive(cardId: string): Promise<void> {
    this.card(cardId)
    await this.append({ v: 1, type: 'card_archived', id: cardId, ts: this.nowIso() })
  }

  /** Called by main when the runtime pool changed: cards may need a push. */
  notifyExternalChange(): void {
    this.scheduleReload()
  }

  /** Appends a card's reconstructive event sequence (cross-store migration). */
  async importCardEvents(events: KanbanEvent[]): Promise<void> {
    for (const event of events) await this.append(event)
  }

  private startWatch(): void {
    if (this.watcher) return
    const dir = join(this.file, '..')
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.scheduleReload())
      this.watcher.on('error', () => {
        // Directory removed out from under us; stop watching, keep memory state.
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      this.watcher = null
    }
  }

  // Watcher fires for OUR appends too; a full re-read + re-fold is cheap at
  // board scale and converges memory to the file (the truth) regardless of
  // which writer moved it. A trailing send guarantees the last append lands.
  private scheduleReload(): void {
    if (this.reloadTimer) return
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      this.reloadInFlight = this.reload()
    }, RELOAD_THROTTLE_MS)
    this.reloadTimer.unref?.()
  }

  private async reload(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    const events: KanbanEvent[] = []
    for (const line of raw.split('\n')) {
      const event = parseKanbanEventLine(line)
      if (event) events.push(event)
    }
    const cards = replayKanbanEvents(events)
    const fingerprint = JSON.stringify(cards)
    if (fingerprint === this.fingerprint) return
    this.cards = cards
    this.fingerprint = fingerprint
    this.onChange?.()
  }

  /** Stops the watcher (app quit / project removal). The event file stays. */
  stop(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  /** Removes the whole .pion/kanban directory (project removal cleanup). */
  static async destroy(projectPath: string): Promise<void> {
    await rm(join(projectPath, ...KANBAN_DIR), { recursive: true, force: true })
  }
}
