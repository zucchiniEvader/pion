// pion-daemon boot: shared by both entry shapes — the legacy spawn/dial-home
// invocation (daemon/index.ts parseArgs, frozen arg surface: Electron main's
// LocalConnection spawns bare `--user-data/--resources` stdio JSONL; the
// pairing one-liner uses --connect) and the standalone CLI (`pion-daemon
// serve`, daemon/cli.ts). Owns no GUI APIs (goal.md §5.6 — it must always be
// able to run headless).
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { createWriteStream, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { DAEMON_PROTOCOL_VERSION } from '../contracts/daemon-protocol'
import { DaemonServer } from './server'
import { pionLink, renderConnectQr, lanHosts } from './connect-info'
import { registerProjectMethods, setProjectRemovalHook, loadProjects } from './projects'
import { registerSessionMethods } from './sessions'
import { registerAgentMethods, shutdownAgent, ensurePrewarm } from './agent'
import { registerKanbanMethods, stopKanbanStore, shutdownKanban } from './kanban'
import { registerGitMethods } from './git'
import { registerVersionCheckMethods, stopPiUpdate } from './version-check'
import { registerSettingsMethods } from './settings'
import { registerCronMethods } from './cron'
import { registerTerminalMethods, killAllTerminals } from './terminal'

export const DAEMON_VERSION = '0.1.0'
// stop() rungs are SIGTERM(2s)+SIGKILL(1.5s) per pi child; parallel across
// children this bounds graceful shutdown well under the owner's ladder.
const SHUTDOWN_TIMEOUT_MS = 8_000

export function fail(message: string): never {
  // fs.writeSync(2) — not console.error: piped stderr is an async stream in
  // Node, and process.exit() immediately after would truncate the message.
  try {
    writeSync(2, `[daemon] fatal: ${message}\n`)
  } catch {
    /* stderr gone — still exit below */
  }
  process.exit(1)
}

export interface BootOptions {
  userData: string
  resources?: string
  listen?: { host: string; port: number }
  listenWs?: { host: string; port: number }
  connect?: { host: string; port: number }
  token?: string
  stayResident: boolean
  /** Opt OUT of the derived WS listener (daemon defaults to dual-port since
   * the iOS client: a bare --listen also opens WS on port+1). */
  noListenWs?: boolean
  /** Resident mode keeps serving the stdio owner channel (the desktop app
   * spawns its local daemon this way: pipe = credential, plus a WS listener
   * for phone-class peers). stdin EOF still triggers the shutdown ladder. */
  ownerStdio?: boolean
}

// Headless process: ALL logs go to <userData>/daemon.log only — stdout is
// the protocol frame channel and must stay pristine (a stray console.log
// here would corrupt the owner client's frame stream).
async function redirectLogging(userData: string): Promise<void> {
  await mkdir(userData, { recursive: true })
  const stream = createWriteStream(join(userData, 'daemon.log'), { flags: 'a' })
  for (const method of ['log', 'error', 'warn'] as const) {
    console[method] = (...args: unknown[]): void => {
      stream.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n')
    }
  }
}

/** Boot marker for diagnostics: who we are, what booted, and the protocol
 * version this bundle speaks. */
async function writeBootInfo(userData: string): Promise<void> {
  const file = join(userData, 'daemon.json')
  const info = { pid: process.pid, protocolVersion: DAEMON_PROTOCOL_VERSION, startedAt: new Date().toISOString() }
  try {
    const previous = JSON.parse(await readFile(file, 'utf8')) as { bootCount?: number }
    await writeFile(file, JSON.stringify({ ...info, bootCount: (previous.bootCount ?? 0) + 1 }), { mode: 0o600 })
  } catch {
    await mkdir(userData, { recursive: true })
    await writeFile(file, JSON.stringify({ ...info, bootCount: 1 }), { mode: 0o600 })
  }
}

// Boot-time warmup (moved from main's prewarmLatestProject): prewarm the most
// recently opened project while the renderer is still on its boot splash, so
// the first session open or new-task draft takes the warm path instead of a
// ~1.1s cold boot. Best-effort, never blocks serving.
async function prewarmLatestProject(): Promise<void> {
  try {
    const projects = await loadProjects()
    const latest = projects
      .filter((p) => typeof p.path === 'string' && p.path)
      .sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1))[0]
    if (latest) await ensurePrewarm(latest.path)
  } catch {
    /* best-effort; session opens fall back to the cold path */
  }
}

let shuttingDown = false

/** Owner gone (stdin closed) or SIGTERM: stop every runtime child (graceful
 * ladder per pi-rpc stop()), drop prewarm scratch files, stop watchers, exit.
 * If this cannot complete within the bound, exit anyway — pi children die on
 * their own stdin EOF when the daemon disappears (pipe stdio binding). */
function shutdown(reason: string, userData?: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[daemon] ${reason}, shutting down`)
  if (userData) void unlink(join(userData, 'daemon.pid')).catch(() => undefined)
  const timer = setTimeout(() => {
    console.log('[daemon] shutdown timed out, forcing exit')
    process.exit(0)
  }, SHUTDOWN_TIMEOUT_MS)
  timer.unref?.()
  // A running `pi update` child is not a session runtime — stop it first so
  // the agent ladder below only has session runtimes left to drain.
  stopPiUpdate()
  killAllTerminals()
  void shutdownAgent()
    .then(() => shutdownKanban())
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer)
      // stdin EOF lands the moment the owner goes away, while result frames
      // for in-flight calls may still be buffered on stdout. Give the write
      // side a short drain window before exiting so a graceful quit never
      // truncates a frame the owner is still reading.
      setTimeout(() => process.exit(0), 200).unref()
    })
}

/** Boots the daemon with pre-parsed options. Resolves (then exits) when the
 * stdio owner disconnects; never resolves in resident mode. */
export async function runDaemon(opts: BootOptions): Promise<void> {
  const { userData, listen, listenWs, connect, token, stayResident } = opts
  // Hand-run default: the bundle lives at <repo>/out/daemon/index.cjs, so
  // resources/ is two levels up. Electron main and `serve` always pass
  // --resources explicitly (dev = repo resources/, packaged = the app's
  // resourcesPath, CLI install = <userData>/share/resources).
  const resources = opts.resources || resolve(dirname(process.argv[1] ?? ''), '..', '..', 'resources')
  await redirectLogging(userData)

  const server = new DaemonServer({ daemonVersion: DAEMON_VERSION })
  // M2-1: projects/sessions registries; M2-2: runtime pool + kanban host;
  // M2-3: git + version-check (the full method table is now served).
  registerProjectMethods(server, userData)
  registerSessionMethods(server)
  registerAgentMethods(server, resources)
  registerKanbanMethods(server, userData, resources)
  registerGitMethods(server)
  registerVersionCheckMethods(server, userData)
  registerSettingsMethods(server)
  registerCronMethods(server, userData)
  registerTerminalMethods(server)
  setProjectRemovalHook((id) => stopKanbanStore(id))
  // v2: daemon.shutdown replies ok, then triggers the same graceful ladder.
  server.setShutdownHook(() => shutdown('daemon.shutdown', userData))
  void writeBootInfo(userData)
  void prewarmLatestProject()

  // stdin close = the owner process is gone; SIGTERM = the owner's stop
  // ladder reached the signal rung. Both run the same graceful teardown.
  process.on('SIGTERM', () => shutdown('SIGTERM', userData))

  if (stayResident) {
    // Resident mode (④ remote): stdin is NOT a control channel and its EOF
    // never ends the process — UNLESS --owner-stdio (desktop-spawned local
    // daemon: the pipe stays the owner control channel alongside listeners).
    // The single control client arrives over a listener (TCP JSONL for Pion
    // main, WS for phone-class clients), over the owner pipe, OR the daemon
    // dials home to the pairing listener itself (--connect).
    process.on('SIGINT', () => shutdown('SIGINT', userData))
    await writeFile(join(userData, 'daemon.pid'), String(process.pid), { mode: 0o600 }).catch(() => undefined)
    if (listen) {
      await server.startJsonlListener({ host: listen.host, port: listen.port, token: token! })
    }
    // Dual-port default: a bare --listen also opens WS on port+1 (phone
    // clients; the TCP JSONL carrier only serves the desktop GUI). An
    // explicitly chosen port is used verbatim — it failing surfaces, while a
    // DERIVED port walks up past a busy neighbor (the desktop reads the
    // actual port back via daemon.info, so a shift is observable everywhere
    // that matters). port 0 = pick an ephemeral port (GUI-spawned daemon).
    let wsAddr = listenWs
    let wsDerived = false
    if (!wsAddr && listen && !opts.noListenWs) {
      wsAddr = { host: listen.host, port: listen.port + 1 }
      wsDerived = true
    }
    if (wsAddr) {
      for (let attempt = 0; ; attempt++) {
        try {
          await server.startListener({ host: wsAddr.host, port: wsAddr.port, token: token! })
          break
        } catch (err) {
          const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          // Derived ports walk up past busy neighbors; so does the desktop's
          // built-in default (owner-stdio) — a human-chosen --listen-ws must
          // still fail loudly.
          const walkable = wsDerived || !!opts.ownerStdio
          if (!walkable || wsAddr.port === 0 || !busy || attempt >= 7) throw err
          wsAddr = { host: wsAddr.host, port: wsAddr.port + 1 }
        }
      }
    }
    if (connect) {
      server.dialHome({ host: connect.host, port: connect.port, token: token!, clientId: 'pion-daemon-dial' })
    }
    const boundWs = server.info().listeners.find((l) => l.kind === 'ws')
    if (opts.ownerStdio) {
      void server.serveStdio().then(() => shutdown('stdin closed', userData))
    }
    const carriers = [
      listen ? `tcp on ${listen.host}:${listen.port}` : null,
      boundWs ? `ws on ${boundWs.host}:${boundWs.port}` : null,
      connect ? `dial-home → ${connect.host}:${connect.port}` : null,
      opts.ownerStdio ? 'stdio owner' : null,
    ].filter(Boolean).join(', ')
    console.log(`[daemon] pid ${process.pid}, protocol v${DAEMON_PROTOCOL_VERSION}, resident, ${carriers || 'no listener'}`)
    // The scannable link goes to the log for every WS-bearing boot, and as a
    // terminal QR when a human launched this interactively (a piped stdout —
    // the desktop spawn — must stay free of frame-channel noise).
    if (boundWs && token) {
      const host = lanHosts().find((h) => h !== hostname()) ?? '127.0.0.1'
      const link = pionLink(host, boundWs.port, token)
      console.log(`[daemon] connect link (WS, token inside): ${link}`)
      if (process.stdout.isTTY) {
        const q = renderConnectQr(host, boundWs.port, token)
        try {
          process.stdout.write(`\nScan with the Pion iOS app (${host}:${boundWs.port}):\n\n${q}\n\n`)
        } catch {
          /* stdout gone — the log line above still carries the link */
        }
      }
    }
    // A never-resolving promise alone holds no event-loop handle; the
    // listener holds one, but listenerless resident mode needs its own.
    if (!listen && !boundWs && !opts.ownerStdio) setInterval(() => undefined, 60_000)
    await new Promise<void>(() => undefined)
    return
  }

  console.log(`[daemon] pid ${process.pid}, protocol v${DAEMON_PROTOCOL_VERSION}, serving owner client on stdio`)
  await server.serveStdio()
  shutdown('stdin closed', userData)
}
