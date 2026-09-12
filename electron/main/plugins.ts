// Settings Plugins page backend: community gallery fetch + in-app
// `pi install npm:<name> --no-approve`.
//
// Why this lives in main and not in the daemon: same reasoning as
// pi-install.ts — the registry fetch is a client-local network probe (like
// the GUI latest-release probe), install is an explicit machine-level user
// action, and adding daemon methods would touch the frozen v3 protocol.
//
// Install safety: explicit renderer action only, args array + shell:false,
// --no-approve keeps project-local resources untrusted (goal.md baseline).
import { spawn, type ChildProcess } from 'node:child_process'
import { ipcMain } from 'electron'
import { detectPi, safeChildEnvironment } from '../../daemon/pi-rpc'
import { IPC, type CommunityPackage, type UpdateProgressEvent } from '../../src/types'

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'
const FETCH_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 10 * 60 * 1000
const PAGE_SIZE = 100

// pi.dev/packages lists every npm package tagged `pi-package`; this is the
// same data via the registry's search API. Server-side text search narrows it.
async function fetchCommunity(query: string): Promise<CommunityPackage[]> {
  const text = query ? `keywords:pi-package ${query}` : 'keywords:pi-package'
  const res = await fetch(`${SEARCH_URL}?text=${encodeURIComponent(text)}&size=${PAGE_SIZE}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`npm search → HTTP ${res.status}`)
  const data = (await res.json()) as {
    objects?: { package?: { name?: unknown; version?: unknown; description?: unknown; date?: unknown; publisher?: { username?: unknown } } }[]
  }
  const out: CommunityPackage[] = []
  for (const obj of data.objects ?? []) {
    const p = obj.package
    if (typeof p?.name !== 'string') continue
    out.push({
      name: p.name,
      version: typeof p.version === 'string' ? p.version : null,
      description: typeof p.description === 'string' ? p.description : null,
      publisher: typeof p.publisher?.username === 'string' ? p.publisher.username : null,
      date: typeof p.date === 'string' ? p.date : null,
    })
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────
// Install: one at a time, streamed (same shape as the pi update runner).
// ──────────────────────────────────────────────────────────────────────────

let installChild: ChildProcess | null = null

// npm package names: plain or @scoped. We always prepend `npm:` ourselves,
// so nothing else (flags, urls, paths) can reach the child.
const NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

function pushLine(buffer: string, push: (e: UpdateProgressEvent) => void): string {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  for (const line of parts) {
    if (line.trim()) push({ running: true, line })
  }
  return rest
}

async function runInstall(name: string, progress: (e: UpdateProgressEvent) => void): Promise<{ started: boolean; error?: string }> {
  if (installChild) return { started: false, error: '已有安装在进行中' }
  if (!NAME_RE.test(name)) return { started: false, error: `invalid package name: ${name}` }
  const detected = await detectPi()
  if (!detected.path) return { started: false, error: '未检测到 pi,无法安装' }
  try {
    installChild = spawn(detected.path, ['install', `npm:${name}`, '--no-approve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeChildEnvironment(),
      windowsHide: true,
    })
  } catch (err) {
    installChild = null
    return { started: false, error: err instanceof Error ? err.message : String(err) }
  }
  const child = installChild
  for (const stream of [child.stdout, child.stderr]) {
    const buffer = { value: '' }
    stream?.on('data', (chunk: Buffer | string) => {
      buffer.value = pushLine(buffer.value + chunk.toString(), progress)
    })
    stream?.once('end', () => {
      if (buffer.value.trim()) progress({ running: true, line: buffer.value.trimEnd() })
      buffer.value = ''
    })
  }
  child.once('exit', (code) => {
    if (installChild === child) installChild = null
    progress({ running: false, done: true, code: code ?? -1 })
  })
  child.once('error', (err) => {
    if (installChild === child) installChild = null
    progress({ running: false, done: true, code: -1, error: err.message })
  })
  return { started: true }
}

/** Kills a running install (app quit). */
export function stopPluginInstall(): void {
  if (installChild) {
    installChild.kill('SIGTERM')
    installChild = null
  }
}

// ──────────────────────────────────────────────────────────────────────────

export function initPlugins(send: (channel: string, payload: unknown) => void): void {
  const cache = new Map<string, { at: number; packages: CommunityPackage[] }>()
  ipcMain.handle(IPC.PLUGINS_COMMUNITY, async (_e, query: unknown): Promise<CommunityPackage[]> => {
    const q = typeof query === 'string' ? query.trim().slice(0, 200) : ''
    const hit = cache.get(q)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.packages
    const packages = await fetchCommunity(q)
    cache.set(q, { at: Date.now(), packages })
    return packages
  })
  ipcMain.handle(IPC.PLUGINS_INSTALL, async (_e, name: unknown): Promise<{ started: boolean; error?: string }> => {
    if (typeof name !== 'string') throw new TypeError('name must be a string')
    return runInstall(name, (event) => send(IPC.PLUGINS_PROGRESS, event))
  })
}
