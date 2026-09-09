// Kanban projection: folds the append-only events.jsonl log into board cards.
//
// The fold is the single source of board state for BOTH sides of the app:
// main's KanbanStore replays the file through this module, and the purity
// suite (scripts/kanban-reducer.purity.test.mjs) pins its behavior. Copy-on-
// write like eventReducer — React StrictMode must be able to double-invoke
// an update built on top of it without duplicating notes or moves.
//
// Fold rules (docs/kanban-design.md §2):
// - card_created appends a card in status 'todo' (the board's working entry
//   column); a duplicate id is a no-op so replays stay idempotent.
// - card_updated patches only the fields present.
// - card_moved / card_assigned / note_added / card_archived apply to an
//   existing card; events for unknown card ids are skipped, not errors.
// - Unknown event types and malformed lines are skipped (forward compat).
import type { CardStatus, KanbanCard, KanbanEvent, KanbanNote } from '../types'

export const KANBAN_STATUSES: readonly CardStatus[] = ['todo', 'in_progress', 'review', 'done']

function isStatus(value: unknown): value is CardStatus {
  return typeof value === 'string' && KANBAN_STATUSES.includes(value as CardStatus)
}

function isActor(value: unknown): value is KanbanNote['source'] {
  return value === 'user' || value === 'agent' || value === 'system'
}

/**
 * Parses one events.jsonl line into a KanbanEvent, or null when the line is
 * malformed or of an unknown type — a broken line must never poison the
 * replay of the lines after it.
 */
export function parseKanbanEventLine(line: string): KanbanEvent | null {
  if (!line.trim()) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || typeof raw.type !== 'string') return null
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.ts !== 'string' || !raw.ts) return null
  switch (raw.type) {
    case 'card_created':
      if (typeof raw.title !== 'string' || !raw.title) return null
      return raw as unknown as KanbanEvent
    case 'card_updated':
      if (raw.title !== undefined && typeof raw.title !== 'string') return null
      if (raw.body !== undefined && typeof raw.body !== 'string') return null
      if (raw.acceptance !== undefined && !isStringArray(raw.acceptance)) return null
      return raw as unknown as KanbanEvent
    case 'card_moved':
      if (!isStatus(raw.to) || !isActor(raw.by)) return null
      return raw as unknown as KanbanEvent
    case 'card_assigned':
      if (raw.sessionFile !== undefined && typeof raw.sessionFile !== 'string') return null
      if (raw.model !== undefined && typeof raw.model !== 'string') return null
      if (raw.label !== undefined && typeof raw.label !== 'string') return null
      return raw as unknown as KanbanEvent
    case 'note_added': {
      const note = raw.note as KanbanNote | undefined
      if (!note || typeof note !== 'object') return null
      if (typeof note.id !== 'string' || !note.id) return null
      if (!isActor(note.source)) return null
      if (typeof note.text !== 'string') return null
      if (note.at !== undefined && typeof note.at !== 'string') return null
      if (note.sessionFile !== undefined && typeof note.sessionFile !== 'string') return null
      return raw as unknown as KanbanEvent
    }
    case 'card_archived':
      return raw as unknown as KanbanEvent
    default:
      return null
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Empty board state (parity with eventReducer's createTranscript). */
export function createKanbanCards(): KanbanCard[] {
  return []
}

function cloneCard(card: KanbanCard): KanbanCard {
  return {
    ...card,
    acceptance: card.acceptance ? [...card.acceptance] : undefined,
    assignee: card.assignee ? { ...card.assignee } : undefined,
    notes: card.notes.map((note) => ({ ...note })),
  }
}

/**
 * Applies one event to the board. Returns a NEW array; the changed card is a
 * fresh object, untouched cards keep their references. Never mutates inputs.
 */
export function applyKanbanEvent(cards: KanbanCard[], event: KanbanEvent): KanbanCard[] {
  const index = cards.findIndex((card) => card.id === event.id)
  switch (event.type) {
    case 'card_created': {
      // Idempotent replay: a duplicate create of an existing id is a no-op.
      if (index >= 0) return cards
      const card: KanbanCard = {
        id: event.id,
        title: event.title,
        body: event.body,
        acceptance: event.acceptance,
        status: 'todo',
        runState: 'idle',
        notes: [],
        archived: false,
        createdAt: event.ts,
        updatedAt: event.ts,
      }
      return [...cards, card]
    }
    case 'card_updated': {
      if (index < 0) return cards
      const card = cloneCard(cards[index])
      if (event.title !== undefined) card.title = event.title
      if (event.body !== undefined) card.body = event.body
      if (event.acceptance !== undefined) card.acceptance = event.acceptance
      card.updatedAt = event.ts
      const next = cards.slice()
      next[index] = card
      return next
    }
    case 'card_moved': {
      if (index < 0) return cards
      const card = cloneCard(cards[index])
      card.status = event.to
      card.updatedAt = event.ts
      const next = cards.slice()
      next[index] = card
      return next
    }
    case 'card_assigned': {
      if (index < 0) return cards
      const card = cloneCard(cards[index])
      const assignee: KanbanCard['assignee'] = {}
      if (event.sessionFile !== undefined) assignee.sessionFile = event.sessionFile
      if (event.model !== undefined) assignee.model = event.model
      if (event.label !== undefined) assignee.label = event.label
      card.assignee = Object.keys(assignee).length ? assignee : undefined
      card.updatedAt = event.ts
      const next = cards.slice()
      next[index] = card
      return next
    }
    case 'note_added': {
      if (index < 0) return cards
      const card = cloneCard(cards[index])
      // The note's "when": its own at wins (it survives cross-store
      // migration), otherwise the event ts — the write time — stands in.
      card.notes = [...card.notes, { ...event.note, at: event.note.at ?? event.ts }]
      card.updatedAt = event.ts
      const next = cards.slice()
      next[index] = card
      return next
    }
    case 'card_archived': {
      if (index < 0) return cards
      const card = cloneCard(cards[index])
      card.archived = true
      card.updatedAt = event.ts
      const next = cards.slice()
      next[index] = card
      return next
    }
    default:
      // Unknown future event type: skip, keep the board as-is.
      return cards
  }
}

/** Folds a full event log (already parsed) into the board projection. */
export function replayKanbanEvents(events: KanbanEvent[]): KanbanCard[] {
  let cards = createKanbanCards()
  for (const event of events) cards = applyKanbanEvent(cards, event)
  return cards
}

/**
 * Rebuilds the event sequence that reproduces a card's current state in
 * another store (cross-store migration: unassigned → project). Pure: folding
 * the returned events into a fresh board yields an equivalent card (same id,
 * title/body/acceptance, notes in order, status, assignee). A note's `at`
 * travels inside the note object and survives; the migration ts only stands
 * in for the event-level timestamps — content and order are preserved
 * exactly.
 */
export function cardToEvents(card: KanbanCard, ts: string): KanbanEvent[] {
  const events: KanbanEvent[] = [
    {
      v: 1,
      type: 'card_created',
      id: card.id,
      title: card.title,
      ...(card.body ? { body: card.body } : {}),
      ...(card.acceptance?.length ? { acceptance: card.acceptance } : {}),
      ts: card.createdAt || ts,
    },
  ]
  for (const note of card.notes) {
    events.push({ v: 1, type: 'note_added', id: card.id, note: { ...note }, ts })
  }
  if (card.status !== 'todo') {
    events.push({ v: 1, type: 'card_moved', id: card.id, to: card.status, by: 'system', ts })
  }
  if (card.assignee) {
    events.push({
      v: 1,
      type: 'card_assigned',
      id: card.id,
      ...(card.assignee.sessionFile ? { sessionFile: card.assignee.sessionFile } : {}),
      ...(card.assignee.model ? { model: card.assignee.model } : {}),
      ...(card.assignee.label ? { label: card.assignee.label } : {}),
      ts,
    })
  }
  return events
}
