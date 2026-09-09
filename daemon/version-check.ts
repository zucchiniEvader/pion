// Version check: upgrade availability for pi itself and installed extensions
// (docs/version-check-contract.md). Runs async at startup — never blocks and
// never rejects to a crash; every failure mode collapses into the result's
// `error` field or a null `latest`. Results cache in userData for 24h.
// (M2-3: hosted by pion-daemon. The only Electron dependency was
// app.getPath('userData') for the cache file — now the --user-data boot
// argument; app.getVersion() was never used here. Pushes become
// server.broadcast on the frozen event channels.)
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { detectPi, safeChildEnvironment } from './pi-rpc'
import type { UpdateCheckEntry, UpdateCheckResult, UpdateProgressEvent } from '../src/types'
import type { DaemonServer } from './server'

const CACHE_FILE = 'version-check.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PER_REQUEST_TIMEOUT_MS = 8_000
const OVERALL_TIMEOUT_MS = 30_000

// Minimal semver comparison (x[.y[.z]]): prerelease segments are ignored —
// `1.2.3-beta` counts as 1.2.3. No `semver` dependency for this.
function semverGt(a: string, b: string): boolean {
  const core = (v: string): [number, number, number] => {
    const m = v.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0]
  }
  const pa = core(a)
  const pb = core(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i]
  }
  return false
}

interface PkgInfo {
  name: string
  version: string | null
}

async function readPackageJson(file: string): Promise<{ name?: string; version?: string } | null> {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as { name?: string; version?: string }
  } catch {
    return null
  }
}

// Pi's own package identity: realpath of the executable points into the
// package (e.g. …/dist/bundle/cli.js for a global npm install). Walk up to
// the nearest package.json with a name — that is the package root whether pi
// sits at three levels deep or in another layout.
async function piPackage(): Promise<PkgInfo | null> {
  const detected = await detectPi()
  if (!detected.path) return null
  let dir: string
  try {
    dir = dirname(await realpath(detected.path))
  } catch {
    return null
  }
  for (let i = 0; i < 8; i++) {
    const pkg = await readPackageJson(join(dir, 'package.json'))
    if (pkg?.name) return { name: pkg.name, version: pkg.version ?? null }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// Installed extensions: `packages` in ~/.pi/agent/settings.json holds entries
// like "npm:<name>". Only npm: entries are checkable (git sources are skipped);
// versions come from the package.json under ~/.pi/agent/npm/node_modules.
async function installedExtensions(): Promise<PkgInfo[]> {
  let raw: string
  try {
    raw = await readFile(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8')
  } catch {
    return []
  }
  let packages: unknown
  try {
    packages = (JSON.parse(raw) as { packages?: unknown }).packages
  } catch {
    return []
  }
  if (!Array.isArray(packages)) return []
  const out: PkgInfo[] = []
  for (const entry of packages) {
    if (typeof entry !== 'string' || !entry.startsWith('npm:')) continue
    const name = entry.slice(4)
    if (!name) continue
    const pkg = await readPackageJson(join(homedir(), '.pi', 'agent', 'npm', 'node_modules', name, 'package.json'))
    out.push({ name, version: pkg?.version ?? null })
  }
  return out
}

// Latest version per package from the npm registry, concurrently. Each
// request has its own timeout inside an overall deadline; failures record
// latest: null instead of interrupting the batch. Scoped names need the
// registry's escaped form (@scope%2Fname).
async function latestVersions(names: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>(names.map((name) => [name, null]))
  if (names.length === 0) return result
  const overall = AbortSignal.timeout(OVERALL_TIMEOUT_MS)
  await Promise.allSettled(
    names.map(async (name) => {
      const escaped = encodeURIComponent(name).replace(/^%40/, '@')
      const signal = AbortSignal.any([AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS), overall])
      try {
        const res = await fetch(`https://registry.npmjs.org/${escaped}/latest`, { signal })
        if (!res.ok) return
        const data = (await res.json()) as { version?: unknown }
        if (typeof data.version === 'string') result.set(name, data.version)
      } catch {
        /* offline or timed out: latest stays null */
      }
    }),
  )
  return result
}

function buildEntries(pi: PkgInfo | null, extensions: PkgInfo[], latest: Map<string, string | null>): UpdateCheckEntry[] {
  const entry = (kind: UpdateCheckEntry['kind'], pkg: PkgInfo): UpdateCheckEntry => {
    const fresh = latest.get(pkg.name) ?? null
    return {
      kind,
      name: pkg.name,
      installed: pkg.version,
      latest: fresh,
      outdated: fresh != null && pkg.version != null && semverGt(fresh, pkg.version),
    }
  }
  // Fixed order: pi first, then extensions in settings.json order.
  return [...(pi ? [entry('pi', pi)] : []), ...extensions.map((pkg) => entry('extension', pkg))]
}

// ──────────────────────────────────────────────────────────────────────────
// Cache + public surface
// ──────────────────────────────────────────────────────────────────────────

let lastResult: UpdateCheckResult | null = null
let inFlight: Promise<UpdateCheckResult> | null = null

function finalize(entries: UpdateCheckEntry[], error?: string): UpdateCheckResult {
  return {
    checkedAt: Date.now(),
    entries,
    outdatedCount: entries.filter((e) => e.outdated).length,
    ...(error !== undefined ? { error } : {}),
  }
}

async function runCheck(): Promise<UpdateCheckResult> {
  try {
    const [pi, extensions] = await Promise.all([piPackage(), installedExtensions()])
    // Whole check could not run: no pi and nothing installed to compare.
    if (!pi && extensions.length === 0) {
      return finalize([], 'pi 未检测到且没有已安装的扩展，无法检查更新')
    }
    const latest = await latestVersions([pi?.name ?? '', ...extensions.map((e) => e.name)].filter(Boolean))
    // Even an all-failed registry sweep gets cached so every startup does not
    // hit the network; outdatedCount simply stays 0.
    return finalize(buildEntries(pi, extensions, latest))
  } catch {
    return finalize([], '检查更新失败')
  }
}

async function cachedResult(): Promise<UpdateCheckResult | null> {
  try {
    const raw = await readFile(join(userData, CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as UpdateCheckResult
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.checkedAt !== 'number' || !Array.isArray(parsed.entries)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function persist(result: UpdateCheckResult): Promise<void> {
  try {
    const file = join(userData, CACHE_FILE)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(result, null, 2), 'utf8')
  } catch {
    /* best-effort cache */
  }
}

/**
 * Startup entry point: push the cached result if it is under 24h old,
 * otherwise run a fresh check in the background. Either way the renderer
 * receives exactly one `version-check:result` push.
 */
export async function initVersionCheck(push: (result: UpdateCheckResult) => void): Promise<void> {
  const cached = await cachedResult()
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    lastResult = cached
    push(cached)
    return
  }
  inFlight = runCheck()
  const result = await inFlight
  inFlight = null
  lastResult = result
  await persist(result)
  push(result)
}

/** Latest known result, or null until the first check has completed. */
export function currentVersionCheckResult(): UpdateCheckResult | null {
  return lastResult
}

/** Force a fresh check ignoring the cache; resolves (and pushes) the result. */
export async function recheckVersionCheck(push: (result: UpdateCheckResult) => void): Promise<UpdateCheckResult | null> {
  if (!inFlight) inFlight = runCheck()
  try {
    const result = await inFlight
    lastResult = result
    await persist(result)
    push(result)
    return result
  } catch {
    return null
  } finally {
    inFlight = null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// In-app update: `pi update --all --no-approve`
// Only ever started by an explicit renderer action (button click) — never
// automatically. --no-approve keeps project-local files untrusted, matching
// the goal.md safety baseline. Output streams to the renderer; on success a
// fresh check runs so the badge reflects post-update state.
// ──────────────────────────────────────────────────────────────────────────

let updateChild: ChildProcess | null = null

function pushLine(buffer: string, push: (e: UpdateProgressEvent) => void): string {
  // Emit complete lines; keep the trailing partial in the buffer.
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  for (const line of parts) {
    if (line.trim()) push({ running: true, line })
  }
  return rest
}

function pipeStream(
  stream: NodeJS.ReadableStream | null,
  bufferRef: { value: string },
  push: (e: UpdateProgressEvent) => void,
): void {
  stream?.on('data', (chunk: Buffer | string) => {
    bufferRef.value += chunk.toString()
    bufferRef.value = pushLine(bufferRef.value, push)
  })
}

/** Starts the update unless one is already running. */
export async function runPiUpdate(
  progress: (e: UpdateProgressEvent) => void,
  pushResult: (result: UpdateCheckResult) => void,
): Promise<{ started: boolean; error?: string }> {
  if (updateChild) return { started: false, error: '已有更新在进行中' }
  const detected = await detectPi()
  if (!detected.path) return { started: false, error: '未检测到 pi,无法更新' }
  try {
    updateChild = spawn(detected.path, ['update', '--all', '--no-approve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeChildEnvironment(),
      windowsHide: true,
    })
  } catch (err) {
    updateChild = null
    return { started: false, error: err instanceof Error ? err.message : String(err) }
  }
  const out = { value: '' }
  const errOut = { value: '' }
  pipeStream(updateChild.stdout, out, progress)
  pipeStream(updateChild.stderr, errOut, progress)
  const child = updateChild
  child.once('exit', (code) => {
    updateChild = null
    // Flush whatever partial lines remain on both streams.
    for (const buffer of [out, errOut]) {
      if (buffer.value.trim()) progress({ running: true, line: buffer.value.trimEnd() })
      buffer.value = ''
    }
    progress({ running: false, done: true, code: code ?? -1 })
    // Refresh the badge from a real re-check after a successful update.
    if (code === 0) void recheckVersionCheck(pushResult)
  })
  child.once('error', (err) => {
    if (updateChild === child) updateChild = null
    progress({ running: false, done: true, code: -1, error: err.message })
  })
  return { started: true }
}

/** True while an in-app update is running. */
export function piUpdateRunning(): boolean {
  return updateChild !== null
}

/** Kills a running update (app quit). */
export function stopPiUpdate(): void {
  if (updateChild) {
    updateChild.kill('SIGTERM')
    updateChild = null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Method registrations + startup check (M2-3)
// ──────────────────────────────────────────────────────────────────────────

let userData = ''

export function registerVersionCheckMethods(server: DaemonServer, userDataDir: string): void {
  userData = userDataDir
  const pushResult = (result: UpdateCheckResult): void => {
    server.broadcast('version-check.result', result)
  }
  const pushProgress = (event: UpdateProgressEvent): void => {
    server.broadcast('version-check.progress', event)
  }
  server.register('version-check.result', () => currentVersionCheckResult())
  server.register('version-check.recheck', () => recheckVersionCheck(pushResult))
  server.register('version-check.update', () => runPiUpdate(pushProgress, pushResult))

  // Startup semantics unchanged: one non-blocking check at boot — cached
  // result broadcast immediately when under 24h, otherwise a fresh sweep
  // whose completion broadcasts exactly once. The renderer also pulls
  // version-check.result on mount, so both orderings (check before/after
  // window load) stay covered. Frame ordering vs hello_ok is safe: the
  // check's first step is an fs read, while serveStdio writes hello_ok
  // synchronously when daemon boot calls it right after registration.
  void initVersionCheck(pushResult)
}
