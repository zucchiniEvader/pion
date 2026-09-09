// Projects + app-session registries (goal.md §6, M2-1): the daemon owns
// projects.json and app-sessions.json under --user-data. Electron main keeps
// only the native pick dialog and forwards everything else over the wire.
// Bodies were moved verbatim from electron/main/index.ts — same validation,
// same error messages, same file formats. No electron imports: this module
// is bundled into out/daemon/index.cjs (scripts/build-daemon.mjs).
import { readFile, writeFile, readdir, mkdir, stat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectRecord } from '../src/types'
import type { RuntimeAttachment } from '../contracts/daemon-protocol'
import type { DaemonServer } from './server'
import { piSessionRoot } from './sessions'

// Set once at registration (daemon/index.ts boot, before any call is served).
let userData = ''

function userDataFile(name: string): string {
  return join(userData, name)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

const PROJECTS_FILE = 'projects.json'

async function loadProjects(): Promise<ProjectRecord[]> {
  return readJson<ProjectRecord[]>(userDataFile(PROJECTS_FILE), [])
}

async function saveProjects(projects: ProjectRecord[]): Promise<void> {
  await writeJson(userDataFile(PROJECTS_FILE), projects)
}

async function addProject(path: string): Promise<ProjectRecord & RuntimeAttachment> {
  const projects = await loadProjects()
  const existing = projects.find((p) => p.path === path)
  if (existing) {
    existing.lastOpenedAt = new Date().toISOString()
    await saveProjects(projects)
    return { ...existing, runtime: 'local' }
  }
  const record: ProjectRecord = {
    id: path,
    name: path.split('/').pop() || path,
    path,
    lastOpenedAt: new Date().toISOString(),
  }
  projects.push(record)
  await saveProjects(projects)
  return { ...record, runtime: 'local' }
}

/** File names of the project's own PI extensions, if any. */
async function listProjectExtensions(projectPath: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectPath, '.pi', 'extensions'))
    return entries.filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

// Registry of sessions this app is responsible for showing: created through
// the app, or opened through it (an explicit user selection). Everything else
// on disk — e.g. sessions from terminal pi runs — stays out of the sidebar
// unless the user opts in via "显示全部". Keyed by project path. Shared with
// daemon/sessions.ts (track/archive mutate it, projects.remove prunes it).
const APP_SESSIONS_FILE = 'app-sessions.json'

async function loadAppSessions(): Promise<Record<string, string[]>> {
  return readJson<Record<string, string[]>>(userDataFile(APP_SESSIONS_FILE), {})
}

async function trackAppSession(projectPath: string, filePath: string): Promise<void> {
  const registry = await loadAppSessions()
  const list = registry[projectPath]
  if (list?.includes(filePath)) return
  if (list) list.push(filePath)
  else registry[projectPath] = [filePath]
  await writeJson(userDataFile(APP_SESSIONS_FILE), registry)
}

async function listAppSessions(projectPath: string): Promise<string[]> {
  return (await loadAppSessions())[projectPath] ?? []
}

/** Persists the app-session registry (used by sessions.archive in daemon/sessions.ts). */
async function saveAppSessions(registry: Record<string, string[]>): Promise<void> {
  await writeJson(userDataFile(APP_SESSIONS_FILE), registry)
}

/** Post-removal hook (kanban store teardown, wired by daemon/index.ts so
 * this module stays kanban-free). */
let onProjectRemoved: ((id: string) => void) | null = null

export function setProjectRemovalHook(hook: (id: string) => void): void {
  onProjectRemoved = hook
}

// ── v2: projects.discover (goal.md §9 add-remote-project flow) ──
// Enumerate candidate project dirs on THIS machine: PI session buckets under
// ~/.pi/agent/sessions/<bucket>/ hold per-project sessions; each session
// file's first `session` record carries its cwd — read it back for a
// lossless path recovery (bucket names map separators to '-', irreversible).
// Buckets without a readable cwd are skipped, not guessed.

async function readSessionCwd(file: string): Promise<string | null> {
  const fh = await open(file).catch(() => null)
  if (!fh) return null
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buf, 0, 8192, 0)
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as { type?: string; cwd?: string }
        if (record.type === 'session' && typeof record.cwd === 'string' && record.cwd) return record.cwd
      } catch {
        /* partial last line or malformed record: skip */
      }
    }
    return null
  } finally {
    await fh.close()
  }
}

async function discoverProjects(): Promise<string[]> {
  const root = piSessionRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const found: Array<{ path: string; mtimeMs: number }> = []
  for (const name of entries) {
    if (!/^--.+--$/.test(name)) continue
    const dir = join(root, name)
    const dirStat = await stat(dir).catch(() => null)
    if (!dirStat?.isDirectory()) continue
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'))
    let newest: { file: string; mtimeMs: number } | null = null
    for (const f of files) {
      const fs = await stat(join(dir, f)).catch(() => null)
      if (!fs) continue
      if (!newest || fs.mtimeMs > newest.mtimeMs) newest = { file: join(dir, f), mtimeMs: fs.mtimeMs }
    }
    if (!newest) continue
    const cwd = await readSessionCwd(newest.file)
    if (cwd) found.push({ path: cwd, mtimeMs: newest.mtimeMs })
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return [...new Set(found.map((f) => f.path))]
}

export function registerProjectMethods(server: DaemonServer, userDataDir: string): void {
  userData = userDataDir
  server.register('projects.list', async () =>
    (await loadProjects()).map((p) => ({ ...p, runtime: 'local' as const })),
  )
  server.register('projects.add', async (params) => {
    const { path } = params as { path: string }
    return addProject(path)
  })
  server.register('projects.remove', async (params) => {
    const { id } = params as { id: string }
    const projects = (await loadProjects()).filter((p) => p.id !== id)
    await saveProjects(projects)
    // Drop the removed project's session registry so it cannot resurface.
    const registry = await loadAppSessions()
    if (registry[id]) {
      delete registry[id]
      await writeJson(userDataFile(APP_SESSIONS_FILE), registry)
    }
    // Stop the kanban watcher of the removed project; .pion/ in the user's
    // project stays untouched (hook → daemon/kanban.ts stopKanbanStore).
    onProjectRemoved?.(id)
    return null
  })
  server.register('projects.extensions', async (params) => {
    const { projectPath } = params as { projectPath: string }
    return listProjectExtensions(projectPath)
  })
  server.register('projects.discover', () => discoverProjects())
}

export { loadProjects, loadAppSessions, saveAppSessions, trackAppSession, listAppSessions }
