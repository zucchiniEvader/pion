// Agent runtime host (goal.md §6, M2-2): the pooled `pi --mode rpc` children,
// prewarm pool, LRU eviction, and the session-bucket watcher. Bodies were
// moved verbatim from electron/main/index.ts; the only semantic change is
// that runtime events now leave via server.broadcast('agent.event') instead
// of sendToRenderer. No electron imports — bundled into out/daemon/index.cjs.
//
// §4 invariants preserved: synchronous eviction slot reservation, pending-start
// serialization per session file, single-writer session mapping, adopt/bind
// prewarm fast path, agent_settled as the stable idle boundary.
import { rm, stat } from 'node:fs/promises'
import { watch, existsSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentStartOptions, PiEvent, PiEventEnvelope, RpcCommand, RuntimeInfo } from '../src/types'
import { PiRpcRuntime, detectPi, invalidatePiDetection, isExtensionLoadFailure } from './pi-rpc'
import { piSessionRoot, sessionBucket, trackSession } from './sessions'
import { DaemonRpcError, type DaemonServer } from './server'

const runtimes = new Map<string, PiRpcRuntime>()
// Session file → owning runtime, so at most one writable runtime per session.
const sessionRuntimeByFile = new Map<string, string>()
// Runtime pool: switching sessions re-attaches to live runtimes instead of
// respawning PI; the session JSONL on disk stays the source of truth for
// whatever happened while a runtime ran in the background.
const RUNTIME_POOL_LIMIT = 4
const runtimeLastUsedAt = new Map<string, number>()
const pendingStarts = new Map<string, Promise<RuntimeInfo>>()

// Pion's always-on bundled extension (resources/pion-commands.ts): carries the
// `/reload` command, which pi's TUI keeps built-in and RPC mode never sees.
// Resolved once at boot from the --resources dir; missing file = run without it.
let pionCommandsPath: string | null = null

/** Stops the least-recently-used pooled runtimes over the limit. */
function evictIdleRuntimes(keepId: string): void {
  // Reserve eviction slots SYNCHRONOUSLY: stop() is async and the exit
  // handler removes the runtime later, so a size-based loop condition would
  // see a stale count and evict every idle runtime (the "eviction storm"
  // that also killed mid-start children). Only `excess` victims may go.
  let excess = runtimes.size - RUNTIME_POOL_LIMIT
  if (excess <= 0) return
  // `prompt` acks immediately, so a runtime mid-run looks idle by wall clock.
  // Never evict (and thereby abort) one that is still streaming.
  const byOldest = [...runtimes.entries()]
    .filter(([id]) => id !== keepId)
    .filter(([, rt]) => !rt.snapshot().isStreaming)
    .sort(([, a], [, b]) => (runtimeLastUsedAt.get(a.runtimeId) ?? 0) - (runtimeLastUsedAt.get(b.runtimeId) ?? 0))
  for (const [id, rt] of byOldest) {
    if (excess <= 0) break
    // Drop from the pool now; the exit handler's own cleanup is a no-op and
    // its session mapping still guards against a racing reopen until exit.
    runtimes.delete(id)
    void rt.stop()
    excess--
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Prewarm pool
// ──────────────────────────────────────────────────────────────────────────

// A blank `pi --mode rpc` per recently-used project, booted ahead of the
// first session open: binding a session is then one switch_session round
// trip (~350ms incl. session load) instead of a ~1.1s cold boot. A prewarm
// holds no user conversation; pi creates its scratch session file lazily and
// it is never written to, so it is deleted on bind, eviction, or quit.
interface Prewarm {
  runtime: PiRpcRuntime
  projectPath: string
  scratchFile: string | null
  // Events from an unbound prewarm would materialize a ghost session in the
  // renderer pool; forwarding is gated on this until the runtime is adopted.
  bound: boolean
  // Statuses the boot published while unbound, keyed by statusKey and replayed
  // on adopt. Status is idempotent state (pi-mcp-adapter announces its server
  // inventory this way, ponytail its mode), so a session that adopts a prewarm
  // must end up exactly as informed as a cold-spawned one — otherwise the
  // extension's chip silently never appears. Notices are NOT buffered: they are
  // events about a boot the user never watched, and replaying one minutes later
  // reads as a fresh message.
  pendingStatuses: Map<string, PiEvent>
  // Wall-clock spawn time. pi snapshots settings.json (default model
  // included) and auth.json (credentials) once per process at boot, so a
  // prewarm born before either change would serve the old default model or an
  // unavailable provider; see piConfigChangedSince.
  bornAt: number
}

// True when a file pi reads once per process was written after `bornAt` —
// settings.json (default model) or auth.json (credentials, written by
// settings.authSetKey / settings.authRemove): the prewarm's in-process view is
// stale and it must not be adopted. pi has no RPC command to re-read either
// file, so a cold spawn is the only refresh.
const PI_CONFIG_PATHS = [
  join(homedir(), '.pi', 'agent', 'settings.json'),
  join(homedir(), '.pi', 'agent', 'auth.json'),
]
async function piConfigChangedSince(bornAt: number): Promise<boolean> {
  for (const path of PI_CONFIG_PATHS) {
    try {
      if ((await stat(path)).mtimeMs > bornAt) return true
    } catch {
      // file not there: nothing to go stale
    }
  }
  return false
}
const prewarmed = new Map<string, Prewarm>() // runtimeId → prewarm
const PREWARM_LIMIT = 2
const prewarmInFlight = new Set<string>()

// Runtime-lifecycle couplings that live in daemon/kanban.ts (failed marking,
// settled tap, board refresh). Registered via onAgentEvent so this module
// stays kanban-free and the dependency stays one-directional (kanban → agent).
type AgentEventListener = (envelope: PiEventEnvelope) => void
const agentEventListeners = new Set<AgentEventListener>()

export function onAgentEvent(listener: AgentEventListener): () => void {
  agentEventListeners.add(listener)
  return () => agentEventListeners.delete(listener)
}

let broadcastAgentEvent: ((envelope: PiEventEnvelope) => void) | null = null

function forwardRuntimeEvent(envelope: PiEventEnvelope): void {
  // A streaming run issues no further RPC commands after the prompt ack, so
  // its LRU stamp would go stale and invite eviction mid-run. Activity
  // boundaries keep it marked fresh until the run settles.
  if (envelope.event.type === 'agent_start' || envelope.event.type === 'agent_settled') {
    runtimeLastUsedAt.set(envelope.runtimeId, Date.now())
  }
  // Kanban runState rides the same event stream (settled tap / failed
  // marking / board refresh) — listeners run before the wire push, matching
  // the old main-process ordering.
  for (const listener of agentEventListeners) listener(envelope)
  broadcastAgentEvent?.(envelope)
}

function handleRuntimeExit(rt: PiRpcRuntime): void {
  prewarmed.delete(rt.runtimeId)
  runtimes.delete(rt.runtimeId)
  for (const [file, rid] of sessionRuntimeByFile) {
    if (rid === rt.runtimeId) sessionRuntimeByFile.delete(file)
  }
}

async function discardPrewarm(id: string): Promise<void> {
  const entry = prewarmed.get(id)
  prewarmed.delete(id)
  if (!entry) return
  void entry.runtime.stop()
  if (entry.scratchFile) await rm(entry.scratchFile, { force: true }).catch(() => undefined)
}

/** Boots a blank prewarm for the project if none is waiting (fire-and-forget). */
export async function ensurePrewarm(projectPath: string): Promise<void> {
  for (const [, p] of prewarmed) if (p.projectPath === projectPath) return
  if (prewarmInFlight.has(projectPath)) return
  prewarmInFlight.add(projectPath)
  try {
    const detected = await detectPi()
    if (!detected.path) return
    while (prewarmed.size >= PREWARM_LIMIT) {
      const oldestId = prewarmed.keys().next().value
      if (oldestId === undefined) break
      await discardPrewarm(oldestId)
    }
    const entry: Prewarm = {
      runtime: null as unknown as PiRpcRuntime,
      projectPath,
      scratchFile: null,
      bound: false,
      pendingStatuses: new Map(),
      bornAt: Date.now(),
    }
    const spawned = await spawnRuntime(detected.path, { projectPath }, {
      onEvent: (envelope) => {
        if (entry.bound) {
          forwardRuntimeEvent(envelope)
          return
        }
        if (envelope.event.type === 'extension_ui_request' && envelope.event.method === 'setStatus') {
          entry.pendingStatuses.set(String(envelope.event.statusKey ?? ''), envelope.event)
        }
      },
      onExit: handleRuntimeExit,
    })
    entry.runtime = spawned.runtime
    entry.scratchFile = spawned.info.sessionFile ?? null
    prewarmed.set(entry.runtime.runtimeId, entry)
  } catch {
    /* pi missing or broken: session opens fall back to the cold path */
  } finally {
    prewarmInFlight.delete(projectPath)
  }
}

function buildStartArgs(options: AgentStartOptions, noExtensions = false): string[] {
  const args = ['--mode', 'rpc']
  // Retry mode (spawnRuntime below): turn off extension DISCOVERY — whatever the
  // user installed globally — while the explicit -e flags at the bottom keep
  // loading. A broken or version-incompatible global extension is fatal to pi,
  // and Pion neither controls nor needs those.
  if (noExtensions) args.push('--no-extensions')
  // pi has no --cwd flag; the session bucket derives from the child process
  // working directory, which the runtime sets to the project path.
  if (options.sessionPath) args.push('--session', options.sessionPath)
  if (options.modelId) {
    if (options.provider) args.push('--provider', options.provider)
    args.push('--model', options.modelId)
  }
  if (options.thinking) args.push('--thinking', options.thinking)
  // Always-on app extension (every runtime incl. prewarm, so pooled children
  // answer /reload too). Loaded before any caller-requested extensions.
  if (pionCommandsPath) args.push('-e', pionCommandsPath)
  // App-bundled extensions (kanban dispatch): the renderer can never inject
  // these — the AGENT_START trust boundary in Electron main strips the field.
  for (const ext of options.extensions ?? []) args.push('-e', ext)
  return args
}

interface SpawnCallbacks {
  onEvent: (envelope: PiEventEnvelope) => void
  onExit: (runtime: PiRpcRuntime) => void
}

/**
 * Creates a runtime and completes its handshake, retrying once with extension
 * discovery disabled when pi died loading an extension.
 *
 * Why retry: pi treats a failed extension as fatal — it exits before answering,
 * so without this every session on that machine dies as "PI RPC exited (1)"
 * (measured: pi 0.74.2 plus an extension declaring >= 0.84.0). Discovery covers
 * whatever the user has installed globally, which Pion can neither fix nor rely on.
 *
 * The first attempt's events are buffered rather than forwarded: a probe that is
 * about to be replaced must leave no trace, or the renderer materialises a
 * phantom crashed session for a runtime it never knew (useSessionPool keys an
 * unknown runtimeId through defaultSessionState). They are released only once the
 * handshake proves this runtime is the keeper — which also preserves the status
 * events pi emits during startup (e.g. an extension's setStatus).
 */
async function spawnRuntime(
  executable: string,
  options: AgentStartOptions,
  callbacks: SpawnCallbacks,
): Promise<{ runtime: PiRpcRuntime; info: RuntimeInfo }> {
  const attempt = (noExtensions: boolean) => {
    let passthrough = false
    const buffered: PiEventEnvelope[] = []
    const runtime = new PiRpcRuntime(executable, options.projectPath, buildStartArgs(options, noExtensions), {
      onEvent: (envelope) => (passthrough ? callbacks.onEvent(envelope) : buffered.push(envelope)),
      onExit: (exited) => {
        if (passthrough) callbacks.onExit(exited)
      },
    })
    return {
      runtime,
      async settle(): Promise<{ runtime: PiRpcRuntime; info: RuntimeInfo }> {
        const info = await runtime.handshake()
        passthrough = true
        for (const envelope of buffered) callbacks.onEvent(envelope)
        buffered.length = 0
        return { runtime, info }
      },
    }
  }

  const first = attempt(false)
  try {
    return await first.settle()
  } catch (error) {
    // Never leave a half-alive child behind (the handshake may have timed out
    // rather than the child having exited).
    void first.runtime.stop()
    if (!isExtensionLoadFailure(error)) throw error
    console.log('[daemon] pi failed to load an extension; retrying with --no-extensions')
    return await attempt(true).settle()
  }
}

export async function startRuntime(options: AgentStartOptions): Promise<RuntimeInfo> {
  // Follow the bucket this runtime writes to so its session list stays live.
  watchProjectSessions(options.projectPath)
  // Serialize concurrent starts for the same session (double-click, rapid
  // switching) so the second caller attaches instead of spawning a duplicate.
  const pending = options.sessionPath ? pendingStarts.get(options.sessionPath) : undefined
  if (pending) return pending
  const task = performStart(options)
  const sessionPath = options.sessionPath
  if (sessionPath) {
    pendingStarts.set(sessionPath, task)
    task.finally(() => pendingStarts.delete(sessionPath)).catch(() => undefined)
  }
  return task
}

async function performStart(options: AgentStartOptions): Promise<RuntimeInfo> {
  const detected = await detectPi()
  if (!detected.path) throw new Error('PI executable was not found. Install pi and try again.')
  if (options.sessionPath) {
    // Dispatch (extensions requested) needs a bridge-carrying runtime; a
    // pooled runtime started without -e can never report, so it is not reused.
    const existingId = sessionRuntimeByFile.get(options.sessionPath)
    const existing = existingId && !options.extensions?.length ? runtimes.get(existingId) : undefined
    if (existing) {
      // Re-attach: PI has kept running this session in the background. A
      // fresh get_state is the authoritative streaming/model snapshot — the
      // cached event flags can go stale around aborts.
      try {
        const info = await existing.handshake()
        runtimeLastUsedAt.set(existingId!, Date.now())
        // A live session is a working session: clear any crash marking.
        onSessionRestarted(options.sessionPath)
        return info
      } catch {
        runtimes.delete(existingId!)
        runtimeLastUsedAt.delete(existingId!)
        sessionRuntimeByFile.delete(options.sessionPath)
      }
    } else {
      sessionRuntimeByFile.delete(options.sessionPath)
    }
  }
  // Same session file may only have one writable runtime.
  if (options.sessionPath) {
    const existing = sessionRuntimeByFile.get(options.sessionPath)
    if (existing) {
      const runtime = runtimes.get(existing)
      if (runtime) throw new Error('That session already has an active runtime.')
    }
  }
  // Fast path: adopt or bind a prewarmed blank runtime instead of a ~1s cold
  // spawn. Without sessionPath (new-task draft) the prewarm is adopted as-is;
  // with sessionPath it is bound via switch_session. Model/thinking overrides
  // AND dispatch extensions keep the cold path so spawned-with-flags
  // semantics stay exact — a prewarm carries no bridge.
  if (!options.modelId && !options.thinking && !options.extensions?.length) {
    const binding = options.sessionPath != null
    let entry = [...prewarmed.values()].find((p) => p.projectPath === options.projectPath)
    // A prewarm carries the default model and credentials pi read at its own
    // boot; if either changed since, retire the prewarm and cold-spawn so the
    // new session actually uses them.
    if (entry && (await piConfigChangedSince(entry.bornAt))) {
      void discardPrewarm(entry.runtime.runtimeId)
      entry = undefined
    }
    if (entry) {
      prewarmed.delete(entry.runtime.runtimeId)
      try {
        if (binding) {
          const switched = await entry.runtime.command({ type: 'switch_session', sessionPath: options.sessionPath! })
          if ((switched.data as { cancelled?: boolean } | undefined)?.cancelled === true) {
            throw new Error('switch_session was cancelled')
          }
        }
        const info = await entry.runtime.handshake()
        // A bind must have landed on the requested session; anything else
        // falls back to a cold spawn below.
        if (info.sessionFile && (!binding || info.sessionFile === options.sessionPath)) {
          entry.bound = true
          // Replay what the boot published while this prewarm was invisible, so
          // an adopted session ends up with the same extension state as a
          // cold-spawned one. Synchronous: frames arriving from here on take
          // the direct path above and must not overtake these older ones.
          for (const event of entry.pendingStatuses.values()) {
            forwardRuntimeEvent({ runtimeId: entry.runtime.runtimeId, event })
          }
          entry.pendingStatuses.clear()
          runtimes.set(entry.runtime.runtimeId, entry.runtime)
          sessionRuntimeByFile.set(info.sessionFile, entry.runtime.runtimeId)
          onSessionRestarted(info.sessionFile)
          runtimeLastUsedAt.set(entry.runtime.runtimeId, Date.now())
          await trackSession(options.projectPath, info.sessionFile)
          // In the bind case the prewarm's scratch session is no longer this
          // runtime's session; remove it. In the adopt case the scratch path
          // is where the first message will land — it must stay.
          if (binding && entry.scratchFile) void rm(entry.scratchFile, { force: true }).catch(() => undefined)
          watchProjectSessions(options.projectPath)
          evictIdleRuntimes(entry.runtime.runtimeId)
          void ensurePrewarm(options.projectPath)
          return info
        }
      } catch {
        /* runtime state is unknown after a failed bind; retire it below */
      }
      void entry.runtime.stop()
      if (binding && entry.scratchFile) void rm(entry.scratchFile, { force: true }).catch(() => undefined)
    }
  }
  // Cold spawn: the prewarm could not serve this request (no prewarm, a changed
  // default model, or a dispatch carrying extensions).
  let spawned: { runtime: PiRpcRuntime; info: RuntimeInfo }
  try {
    spawned = await spawnRuntime(detected.path, options, {
      onEvent: forwardRuntimeEvent,
      onExit: handleRuntimeExit,
    })
  } catch (e) {
    invalidatePiDetection()
    throw e
  }
  const { runtime, info } = spawned
  runtimes.set(runtime.runtimeId, runtime)
  runtimeLastUsedAt.set(runtime.runtimeId, Date.now())
  if (info.sessionFile) {
    sessionRuntimeByFile.set(info.sessionFile, runtime.runtimeId)
    onSessionRestarted(info.sessionFile)
    // A start through this app is the act of taking ownership: fresh tasks
    // and user-opened history both land in the sidebar registry.
    await trackSession(options.projectPath, info.sessionFile)
  }
  // The handshake created the session file, and with it the bucket directory
  // itself for a project's first session; retry the watch that had to skip.
  watchProjectSessions(options.projectPath)
  evictIdleRuntimes(runtime.runtimeId)
  // Refill so the next session open of this project takes the fast path.
  void ensurePrewarm(options.projectPath)
  return info
}

// "A live session is a working session: clear any crash marking" — the
// kanbanFailedFiles marking lives in daemon/kanban.ts; hooked here so this
// module stays kanban-free (see onAgentEvent).
let sessionRestartedHook: ((sessionFile: string) => void) | null = null

function onSessionRestarted(sessionFile: string): void {
  sessionRestartedHook?.(sessionFile)
}

// ──────────────────────────────────────────────────────────────────────────
// Session directory watcher (bucket file changes → sessions.changed push)
// ──────────────────────────────────────────────────────────────────────────

let sessionWatcher: FSWatcher | null = null
let watchedProjectPath: string | null = null
// PI appends to the session file continuously while streaming; coalesce the
// resulting watcher storms into at most one push per interval, with a
// trailing send so the final append is never dropped. (Moved from main with
// the throttle state intact: one global window, exactly as before.)
const SESSION_CHANGE_THROTTLE_MS = 500
let lastChangeSentAt = 0
let pendingChangeTimer: NodeJS.Timeout | null = null
let broadcastSessionsChanged: ((projectPath: string) => void) | null = null

export function notifySessionsChanged(projectPath: string): void {
  const send = (): void => {
    lastChangeSentAt = Date.now()
    broadcastSessionsChanged?.(projectPath)
  }
  const elapsed = Date.now() - lastChangeSentAt
  if (elapsed >= SESSION_CHANGE_THROTTLE_MS) {
    send()
    return
  }
  if (pendingChangeTimer) return
  pendingChangeTimer = setTimeout(() => {
    pendingChangeTimer = null
    send()
  }, SESSION_CHANGE_THROTTLE_MS - elapsed)
}

export function watchProjectSessions(projectPath: string): void {
  if (watchedProjectPath === projectPath && sessionWatcher) return
  sessionWatcher?.close()
  watchedProjectPath = projectPath
  const dir = join(piSessionRoot(), sessionBucket(projectPath))
  try {
    sessionWatcher = watch(dir, { persistent: false }, () => {
      notifySessionsChanged(projectPath)
    })
  } catch {
    // The bucket may not exist yet (project's first session); startRuntime
    // re-watches once the runtime handshake has created it.
    sessionWatcher = null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Method registration
// ──────────────────────────────────────────────────────────────────────────

/** Runtime state for a session file (kanban runState projection + review
 * forwarding). Undefined when no runtime is bound to the session. */
export function runtimeForSessionFile(sessionFile: string): PiRpcRuntime | undefined {
  const runtimeId = sessionRuntimeByFile.get(sessionFile)
  return runtimeId ? runtimes.get(runtimeId) : undefined
}

export function getRuntime(runtimeId: string): PiRpcRuntime | undefined {
  return runtimes.get(runtimeId)
}

/** Session file bound to a runtime (kanban's settled tap / failed marking
 * resolve the session a lifecycle event belongs to; was the in-place reverse
 * scan of sessionRuntimeByFile in main's forwardRuntimeEvent). */
export function sessionFileForRuntime(runtimeId: string): string | undefined {
  return [...sessionRuntimeByFile.entries()].find(([, rid]) => rid === runtimeId)?.[0]
}

/** Stops every runtime and prewarm, removes scratch files, closes the bucket
 * watcher. Mirrors the old main before-quit ladder; the daemon runs it when
 * its stdin closes (owner gone) or on SIGTERM. */
export async function shutdownAgent(): Promise<void> {
  sessionWatcher?.close()
  const all = [...runtimes.values(), ...[...prewarmed.values()].map((p) => p.runtime)]
  await Promise.allSettled(all.map((rt) => rt.stop()))
  await Promise.allSettled(
    [...prewarmed.values()].map((p) => (p.scratchFile ? rm(p.scratchFile, { force: true }) : Promise.resolve())),
  )
  runtimes.clear()
  prewarmed.clear()
}

export function registerAgentMethods(server: DaemonServer, resources?: string): void {
  broadcastAgentEvent = (envelope) => server.broadcast('agent.event', envelope)
  if (resources) {
    const candidate = join(resources, 'pion-commands.ts')
    if (existsSync(candidate)) pionCommandsPath = candidate
  }
  broadcastSessionsChanged = (projectPath) => server.broadcast('sessions.changed', { projectPath })

  // Params arrive pre-cleaned from the AGENT_START trust boundary in
  // Electron main (extensions are main-internal; the renderer cannot attach).
  server.register('agent.start', async (params) => startRuntime(params as AgentStartOptions))
  server.register('agent.command', async (params) => {
    const { runtimeId, command } = params as { runtimeId: string; command: RpcCommand }
    const runtime = runtimes.get(runtimeId)
    if (!runtime) throw new Error('Runtime is no longer available')
    // v3: with multiple clients the daemon is the authority on the
    // send-while-running guard (the renderer's draftDecision only sees its
    // own UI). steer/follow_up/abort keep their while-running semantics.
    if (command.type === 'prompt' && runtime.snapshot().isStreaming) {
      throw new DaemonRpcError('conflict', 'runtime is busy (agent still streaming)')
    }
    runtimeLastUsedAt.set(runtimeId, Date.now())
    // extension_ui_response must reach PI verbatim (its `id` keys the
    // extension's pending request) and PI answers without an RPC envelope,
    // so it goes out fire-and-forget with a synthetic success.
    if (command.type === 'extension_ui_response') {
      await runtime.notify(command)
      return { type: 'response', id: String(command.id ?? ''), command: command.type, success: true }
    }
    return runtime.command(command)
  })
  server.register('agent.stop', async (params) => {
    const { runtimeId } = params as { runtimeId: string }
    const runtime = runtimes.get(runtimeId)
    if (!runtime) return false
    return runtime.stop()
  })
  server.register('agent.list', async () => [...runtimes.values()].map((rt) => rt.snapshot()))
}

/** Kanban hooks (daemon/kanban.ts): crash-marking reset when a session
 * restarts. Registered at boot, before any call is served. */
export function setSessionRestartedHook(hook: (sessionFile: string) => void): void {
  sessionRestartedHook = hook
}
