// PI session discovery + transcript reads (goal.md §6, M2-1): bucket
// scanning, metadata parsing/caching, transcript reads, rename, and the
// app-session registry mutations. Bodies were moved verbatim from
// electron/main/index.ts. No electron imports — bundled into
// out/daemon/index.cjs. The fs watcher lives in daemon/agent.ts (migrated
// with agent.start, its other caller); sessions.list re-applies main's old
// handler side effects (watcher switch + prewarm) via that module. NOTE:
// sessions.ts ↔ agent.ts import cycle is intentional and safe — every
// cross-module reference is a function called at request time, never at
// module-init time.
import { readFile, readdir, stat, open } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'
import type { SessionRecord } from '../src/types'
import type { DaemonServer } from './server'
import { loadProjects, loadAppSessions, saveAppSessions, trackAppSession, listAppSessions } from './projects'
import { notifySessionsChanged, watchProjectSessions, ensurePrewarm } from './agent'

// Exported for the agent watcher (daemon/agent.ts) and main's residual
// kanban/git validation until M2-3.
export function piSessionRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

// Mirrors PI's session bucket derivation (getDefaultSessionDirPath): strip one
// leading separator, map every remaining separator or ':' to '-', then wrap in
// '--' (e.g. /Users/me/app → --Users-me-app--).
export function sessionBucket(projectPath: string): string {
  const norm = projectPath.replace(/\/+$/, '').replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  return `--${norm}--`
}

// Path allowlist shared by session-file mutations: only session JSONL files
// directly inside PI's session root.
export function assertSessionFile(filePath: string): void {
  const root = piSessionRoot()
  if (filePath !== join(root, filePath.slice(root.length + 1)) || !filePath.endsWith('.jsonl')) {
    throw new Error('Not a PI session file.')
  }
}

interface ParsedSessionMeta {
  id: string
  title: string
  createdAt: string
  model?: string
  provider?: string
  thinkingLevel?: string
  messageCount: number
  preview?: string
  /** Timestamp of the last conversation message; opening a session must not bump this. */
  lastMessageAt?: string
}

async function parseSessionMeta(filePath: string): Promise<ParsedSessionMeta | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split('\n').filter(Boolean)
  if (!lines.length) return null
  let id = ''
  let createdAt = ''
  let sessionName: string | undefined
  let model: string | undefined
  let provider: string | undefined
  let thinkingLevel: string | undefined
  let messageCount = 0
  let preview: string | undefined
  let lastMessageAt: string | undefined
  for (const line of lines) {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const type = record.type as string | undefined
    if (type === 'session') {
      id = (record.id as string) ?? id
      createdAt = (record.timestamp as string) ?? createdAt
    } else if (type === 'model_change') {
      if (typeof record.modelId === 'string') model = record.modelId
      if (typeof record.provider === 'string') provider = record.provider
    } else if (type === 'thinking_level_change') {
      if (typeof record.thinkingLevel === 'string') thinkingLevel = record.thinkingLevel
    } else if (type === 'session_info') {
      // PI stores the display name in session_info.name; latest wins.
      if (typeof record.name === 'string' && record.name) sessionName = record.name
    } else if (type === 'message') {
      messageCount += 1
      if (typeof record.timestamp === 'string') lastMessageAt = record.timestamp
      if (!preview) {
        const message = record.message as { content?: Array<{ type: string; text?: string }> } | undefined
        const firstText = message?.content?.find((c) => c.type === 'text' && c.text)?.text
        if (firstText) preview = firstText.slice(0, 160)
      }
    }
  }
  if (!id) return null
  const title = sessionName ?? (preview ? preview.slice(0, 80) : `Session ${id.slice(0, 8)}`)
  return { id, title, createdAt, model, provider, thinkingLevel, messageCount, preview, lastMessageAt }
}

// Parsed metadata cache: sessions.list rescans the bucket on every
// sessions:changed (throttled to 500ms in main), and re-parsing every file
// each time costs hundreds of ms of synchronous JSON.parse on large buckets.
// Size+mtime invalidation means only the file that actually grew (usually
// the streaming session) is re-read.
const sessionMetaCache = new Map<string, { size: number; mtimeMs: number; meta: ParsedSessionMeta }>()

async function parseSessionMetaCached(filePath: string, st: { size: number; mtimeMs: number }): Promise<ParsedSessionMeta | null> {
  const hit = sessionMetaCache.get(filePath)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.meta
  const meta = await parseSessionMeta(filePath)
  if (meta) sessionMetaCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, meta })
  else sessionMetaCache.delete(filePath)
  return meta
}

async function listProjectSessions(projectPath: string): Promise<SessionRecord[]> {
  const bucket = sessionBucket(projectPath)
  const dir = join(piSessionRoot(), bucket)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const files = entries.filter((name) => name.endsWith('.jsonl'))
  // Drop cached metadata for files that left the bucket (archived/deleted).
  const present = new Set(files.map((name) => join(dir, name)))
  for (const key of sessionMetaCache.keys()) {
    if (key.startsWith(dir + sep) && !present.has(key)) sessionMetaCache.delete(key)
  }
  const records: SessionRecord[] = []
  for (const name of files) {
    const filePath = join(dir, name)
    const st = await stat(filePath).catch(() => null)
    if (!st) continue
    const meta = await parseSessionMetaCached(filePath, st)
    if (!meta) continue
    records.push({
      id: meta.id,
      filePath,
      projectPath,
      title: meta.title,
      createdAt: meta.createdAt,
      // "Last used" tracks the last conversation message; file mtime would
      // also move when PI merely opens a session and appends metadata records.
      updatedAt: meta.lastMessageAt || meta.createdAt || new Date(st.mtimeMs).toISOString(),
      status: 'idle',
      model: meta.model,
      provider: meta.provider,
      thinkingLevel: meta.thinkingLevel,
      messageCount: meta.messageCount,
      preview: meta.preview,
    })
  }
  records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return records
}

async function readSessionTranscript(filePath: string): Promise<{ messages: unknown[] }> {
  // Bound the read to avoid loading huge histories into the renderer; the
  // full transcript remains in the PI session file on disk.
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return { messages: [] }
  }
  const messages: unknown[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line)
      if (record.type === 'message') messages.push(record)
    } catch {
      /* skip malformed line */
    }
  }
  return { messages }
}

// Renaming appends a session_info record — the same record type PI itself
// writes on rename, so the JSONL stays a pure PI-managed append-only log.
async function renameSessionFile(filePath: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Session name must not be empty.')
  if (trimmed.length > 200) throw new Error('Session name is too long.')
  // Path allowlist: only session JSONL files inside PI's session root.
  assertSessionFile(filePath)
  const handle = await open(filePath, 'a')
  try {
    await handle.write(JSON.stringify({ type: 'session_info', name: trimmed }) + '\n')
  } finally {
    await handle.close()
  }
}

// Archiving = removing the file from this app's tracked registry, in whichever
// project bucket holds it. The session file itself stays untouched on disk.
// (Registry-change notification is the caller's job — the method broadcasts
// sessions.changed per touched project.)
async function archiveSessionFile(filePath: string): Promise<string[]> {
  assertSessionFile(filePath)
  const registry = await loadAppSessions()
  const touched: string[] = []
  for (const key of Object.keys(registry)) {
    const list = registry[key]
    if (list?.includes(filePath)) {
      registry[key] = list.filter((f) => f !== filePath)
      touched.push(key)
    }
  }
  if (touched.length) await saveAppSessions(registry)
  return touched
}

/** Validates + records a session as app-tracked (used by agent.start's
 * ownership-taking and the sessions.track method — body identical to the
 * old main handler). */
export async function trackSession(projectPath: string, filePath: string): Promise<void> {
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('projectPath must be a non-empty string')
  const projects = await loadProjects()
  if (!projects.some((p) => p.path === projectPath)) throw new Error('Not a registered project.')
  assertSessionFile(filePath)
  await trackAppSession(projectPath, filePath)
}

/** Archive + notify: what the old main handler did after daemon.call — the
 * per-project sessions.changed pushes now ride the daemon-side throttle
 * (previously main's), so both the fs watcher and registry mutations dedupe
 * into one renderer refresh. */
export async function archiveTrackedSession(filePath: string): Promise<string[]> {
  const touched = await archiveSessionFile(filePath)
  for (const projectPath of touched) notifySessionsChanged(projectPath)
  return touched
}

export function registerSessionMethods(server: DaemonServer): void {
  server.register('sessions.list', async (params) => {
    const { projectPath } = params as { projectPath: string }
    // Side effects the old main handler performed around the list call:
    // follow the bucket (watcher) and keep a prewarm ready.
    watchProjectSessions(projectPath)
    void ensurePrewarm(projectPath)
    return listProjectSessions(projectPath)
  })
  server.register('sessions.read', async (params) => {
    const { filePath } = params as { filePath: string }
    return readSessionTranscript(filePath)
  })
  server.register('sessions.tracked', async (params) => {
    const { projectPath } = params as { projectPath: string }
    return listAppSessions(projectPath)
  })
  server.register('sessions.rename', async (params) => {
    const { filePath, name } = params as { filePath: string; name: string }
    await renameSessionFile(filePath, name)
    return null
  })
  server.register('sessions.archive', async (params) => {
    const { filePath } = params as { filePath: string }
    // Notify every project whose tracked set changed so the sidebar moves
    // the file into its archive group (throttled with the watcher pushes).
    return archiveTrackedSession(filePath)
  })
  server.register('sessions.track', async (params) => {
    const { projectPath, filePath } = params as { projectPath: string; filePath: string }
    await trackSession(projectPath, filePath)
    return null
  })
}
