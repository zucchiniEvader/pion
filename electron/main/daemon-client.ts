// Electron main ↔ pion-daemon clients (goal.md §5.1): main is the only
// party that talks to daemons; the renderer keeps using the existing
// allowlisted IPC.
//
// ④ R2-A: two connection kinds behind one interface (DaemonConnection):
// - LocalConnection — spawn + stdio JSONL owner client (pipe = credential;
//   no hello/token). Since the iOS client it ALSO spawns the daemon with
//   --stay-resident --owner-stdio --listen-ws 0.0.0.0:4971 --token: the owner
//   pipe semantics are unchanged (stdin EOF still shuts the daemon down) and
//   the daemon additionally serves a WS carrier phone clients can attach to
//   (default port 4971 so scanned QRs survive restarts; busy walks up, the
//   actual port is read back via daemon.info for the QR).
// - RemoteConnection — TCP JSONL carrier (protocol v2, daemon --listen):
//   connect, send hello {protocol, token}, wait for hello_ok; one
//   LF-terminated JSON frame per line, same discipline as stdio. NOT
//   WebSocket: Electron main's Node event loop stalls after a client-side
//   WS upgrade (goal.md v3 §5.2 M1 finding, reconfirmed in R2-A against a
//   resident peer — node-client repro works, Electron-main client hangs).
//
// Both fail per-call and reconnect per-connection with exponential backoff
// (1/2/5/10s): an unreachable runtime rejects its own calls and never
// blocks other runtimes (goal.md §9 offline semantics).
//
// Project → runtime routing lives in this module too: `registerProjects`
// (from projects.list merges) + `resolve` (used by the IPC layer). The
// local runtime answers every project until remotes register theirs.
import { app, safeStorage } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { PairingManager } from './pairing'
import type {
  DaemonEventChannel,
  DaemonEventMap,
  DaemonFrame,
  DaemonMethodMap,
  DaemonMethodName,
} from '../../contracts/daemon-protocol'
import { DAEMON_PROTOCOL } from '../../contracts/daemon-protocol'

const SPAWN_WAIT_MS = 6_000
const CALL_TIMEOUT_MS = 15_000
const HELLO_TIMEOUT_MS = 8_000
const RESPAWN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000]
// The daemon's own shutdown ladder (SIGTERM 2s + SIGKILL 1.5s per pi child,
// in parallel) finishes well inside this bound.
const GRACEFUL_STOP_WAIT_MS = 8_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

type AnyEventHandler = (payload: unknown) => void

// ──────────────────────────────────────────────────────────────────────────
// Shared frame plumbing: pending-call map + event fan-out
// ──────────────────────────────────────────────────────────────────────────

class FramePump {
  private pending = new Map<string, Pending>()
  private eventHandlers = new Map<DaemonEventChannel, Set<AnyEventHandler>>()

  onEvent<C extends DaemonEventChannel>(channel: C, handler: (payload: DaemonEventMap[C]) => void): void {
    const set = this.eventHandlers.get(channel) ?? new Set<AnyEventHandler>()
    this.eventHandlers.set(channel, set)
    set.add(handler as AnyEventHandler)
  }

  call<M extends DaemonMethodName>(
    send: (frame: unknown) => void,
    method: M,
    params: unknown,
  ): Promise<DaemonMethodMap[M]['result']> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`daemon call timed out: ${method}`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      send({ type: 'call', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  onFrame(frame: DaemonFrame, onHelloOk?: (frame: Extract<DaemonFrame, { type: 'hello_ok' }>) => void, onHelloError?: (frame: Extract<DaemonFrame, { type: 'hello_error' }>) => void): void {
    if (frame.type === 'hello_ok') {
      onHelloOk?.(frame)
      return
    }
    if (frame.type === 'hello_error') {
      onHelloError?.(frame)
      return
    }
    if (frame.type === 'result') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.ok) p.resolve(frame.value)
      // §5.8: the daemon's message is thrown verbatim — today's handlers
      // surfaced the same strings and the renderer maps err.* codes from
      // the message prefix, so no proxy-side decoration.
      else p.reject(new Error(frame.error.message))
      return
    }
    if (frame.type === 'event') {
      const handlers = this.eventHandlers.get(frame.channel)
      if (handlers) for (const handler of handlers) handler(frame.payload)
      return
    }
  }

  failAll(message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Connection interface
// ──────────────────────────────────────────────────────────────────────────

interface DaemonConnection {
  readonly id: string
  readonly kind: 'local' | 'remote'
  readonly name: string
  readonly connected: boolean
  call<M extends DaemonMethodName>(method: M, ...args: DaemonMethodMap[M]['params'] extends Record<string, never> ? [] : [params: DaemonMethodMap[M]['params']]): Promise<DaemonMethodMap[M]['result']>
  onEvent<C extends DaemonEventChannel>(channel: C, handler: (payload: DaemonEventMap[C]) => void): void
  /** Fires on every readiness AFTER the first connect (reconnect recovery). */
  onReady(cb: () => void): void
}

export type { DaemonConnection }

// ──────────────────────────────────────────────────────────────────────────
// Local connection: spawn + stdio (owner client, v1-frozen behavior)
// ──────────────────────────────────────────────────────────────────────────

class LocalConnection implements DaemonConnection {
  readonly id = 'local'
  readonly kind = 'local' as const
  readonly name = 'local'
  private child: ChildProcess | null = null
  private pump = new FramePump()
  private readyListeners = new Set<() => void>()
  private everBooted = false
  private quitting = false
  private respawnAttempt = 0
  private booted: ((err?: Error) => void) | null = null

  /** Extra daemon argv injected by the registry (the WS carrier for phone
   * clients). A getter, not a static list: the persisted per-install token
   * is only readable after the credentials file has loaded. */
  constructor(private readonly extraArgs: () => string[] = () => []) {}

  onReady(cb: () => void): void {
    this.readyListeners.add(cb)
  }

  onEvent<C extends DaemonEventChannel>(channel: C, handler: (payload: DaemonEventMap[C]) => void): void {
    this.pump.onEvent(channel, handler)
  }

  call<M extends DaemonMethodName>(method: M, ...args: DaemonMethodMap[M]['params'] extends Record<string, never> ? [] : [params: DaemonMethodMap[M]['params']]): Promise<DaemonMethodMap[M]['result']> {
    const child = this.child
    if (!child || !child.stdin || !this.isAlive(child)) {
      return Promise.reject(new Error('daemon is not running'))
    }
    return this.pump.call(
      (frame) => child.stdin!.write(JSON.stringify(frame) + '\n'),
      method,
      args[0],
    )
  }

  get connected(): boolean {
    return this.child !== null && this.isAlive(this.child)
  }

  private isAlive(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null
  }

  /** Spawns the daemon and waits for its hello_ok. Never throws: every
   * failure is logged and the app keeps working daemon-less. */
  async start(): Promise<void> {
    try {
      await this.spawnDaemon()
      console.log('[daemon] ready')
      const pong = await this.call('ping')
      console.log(`[daemon] ping ok: ${JSON.stringify(pong)}`)
    } catch (err) {
      console.log(`[daemon] unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async stop(): Promise<void> {
    this.quitting = true
    this.pump.failAll('daemon client stopped')
    const child = this.child
    if (!child) return
    this.child = null
    // stdin close is the daemon's graceful-shutdown trigger (it stops every
    // pi child itself); give it time to finish before the signal ladder.
    await new Promise<void>((resolve) => {
      const exited = new Promise<void>((onExit) => child.once('exit', () => onExit()))
      child.stdin?.end()
      const giveUp = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 2_000).unref()
        resolve()
      }, GRACEFUL_STOP_WAIT_MS)
      giveUp.unref?.()
      void exited.then(() => {
        clearTimeout(giveUp)
        resolve()
      })
    })
  }

  private spawnDaemon(): Promise<void> {
    // Packaged: spawn the extraResources copy — the asar-resident bundle is
    // UNLOADABLE by the ELECTRON_RUN_AS_NODE child (asar support is off in
    // plain-node mode), which killed the local daemon in packaged builds.
    // Dev: the real file under out/.
    const packagedBundle = join(process.resourcesPath, 'pion-daemon.cjs')
    const bundle = app.isPackaged && existsSync(packagedBundle)
      ? packagedBundle
      : join(import.meta.dirname, '../daemon/index.cjs')
    if (!existsSync(bundle)) {
      return Promise.reject(new Error(`daemon bundle missing: ${bundle} (run npm run build)`))
    }
    return new Promise((resolve, reject) => {
      console.log('[daemon] spawning daemon process')
      // Resources dir for the bundled bridge (dev = repo resources/,
      // packaged = extraResources → process.resourcesPath) — the daemon
      // resolves resource paths from this, never from Electron APIs.
      const devResources = join(app.getAppPath(), 'resources')
      const resourcesDir = existsSync(join(devResources, 'kanban-bridge.ts')) ? devResources : process.resourcesPath
      const child = spawn(process.execPath, [bundle, '--user-data', app.getPath('userData'), '--resources', resourcesDir, ...this.extraArgs()], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      const failTimer = setTimeout(() => {
        this.booted = null
        reject(new Error(`daemon did not announce readiness within ${SPAWN_WAIT_MS}ms`))
      }, SPAWN_WAIT_MS)
      this.booted = (err) => {
        clearTimeout(failTimer)
        this.booted = null
        err ? reject(err) : resolve()
      }

      child.on('error', (err) => {
        console.log(`[daemon] child error: ${err.message}`)
        this.failBoot(new Error(`daemon spawn failed: ${err.message}`))
        this.scheduleRespawn()
      })
      child.on('exit', (code, signal) => {
        console.log(`[daemon] process exited (code ${code}, signal ${signal})`)
        this.failBoot(new Error('daemon exited before announcing readiness'))
        this.child = null
        this.scheduleRespawn()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        console.log(`[daemon:stderr] ${chunk.toString().trim()}`)
      })

      // Frame pump: one JSON frame per line (same strict-LF discipline as
      // pi-rpc's stdout parser).
      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
      rl.on('line', (line) => {
        if (!line.trim()) return
        let frame: DaemonFrame
        try {
          frame = JSON.parse(line) as DaemonFrame
        } catch {
          console.log('[daemon] dropping unparseable frame from daemon stdout')
          return
        }
        this.pump.onFrame(frame, () => this.onHelloOk())
      })
      rl.on('close', () => {
        /* exit handler owns respawn */
      })
    })
  }

  private onHelloOk(): void {
    this.booted?.()
    // M3 reconnect re-hydrate (goal.md §5.3): a respawn means the event
    // stream may have gaps; the only recovery is a full re-hydrate.
    if (this.everBooted) {
      for (const cb of this.readyListeners) {
        try {
          cb()
        } catch (err) {
          console.log(`[daemon] ready listener failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    this.everBooted = true
  }

  private failBoot(err: Error): void {
    this.booted?.(err)
    this.booted = null
  }

  private scheduleRespawn(): void {
    if (this.quitting) return
    const delay = RESPAWN_DELAYS_MS[Math.min(this.respawnAttempt, RESPAWN_DELAYS_MS.length - 1)]
    this.respawnAttempt += 1
    console.log(`[daemon] will respawn in ${delay}ms (attempt ${this.respawnAttempt})`)
    setTimeout(() => {
      if (this.quitting) return
      this.spawnDaemon()
        .then(() => {
          this.respawnAttempt = 0
          console.log('[daemon] respawned and ready')
        })
        .catch((err) => console.log(`[daemon] respawn failed: ${err instanceof Error ? err.message : String(err)}`))
    }, delay).unref()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Remote connection: WS carrier + hello/token handshake (protocol v2)
// ──────────────────────────────────────────────────────────────────────────

class RemoteConnection implements DaemonConnection {
  readonly kind = 'remote' as const
  private sock: Socket | null = null
  private pump = new FramePump()
  private readyListeners = new Set<() => void>()
  private everConnected = false
  private reconnectAttempt = 0
  private disposed = false
  private connecting = false
  private connectPromise: Promise<void> | null = null
  private ready = false

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
    private readonly onStateChange: (id: string, connected: boolean) => void,
    /** Dial-home (R3-2): the remote daemon dials INTO us; there is no
     * outbound dial and no reconnect scheduling — a dropped socket waits
     * for the daemon to redial. */
    private readonly options?: { dialIn?: boolean },
  ) {}

  /** Liveness for settings badges + the routing layer: handshake completed
   * and the socket still open. */
  get connected(): boolean {
    return this.ready && this.sock !== null && !this.sock.destroyed
  }

  get hostAddress(): string {
    return this.host
  }

  get portNumber(): number {
    return this.port
  }

  /** R3-2: dial-home runtimes dial INTO the pairing listener (persisted as
   * `dial: 'in'`; they never dial out). */
  get dialIn(): boolean {
    return this.options?.dialIn === true
  }

  onReady(cb: () => void): void {
    this.readyListeners.add(cb)
  }

  onEvent<C extends DaemonEventChannel>(channel: C, handler: (payload: DaemonEventMap[C]) => void): void {
    this.pump.onEvent(channel, handler)
  }

  call<M extends DaemonMethodName>(method: M, ...args: DaemonMethodMap[M]['params'] extends Record<string, never> ? [] : [params: DaemonMethodMap[M]['params']]): Promise<DaemonMethodMap[M]['result']> {
    const sock = this.sock
    if (!this.ready || !sock || sock.destroyed) {
      return Promise.reject(new Error(`Runtime "${this.name}" is offline`))
    }
    return this.pump.call((frame) => sock.write(JSON.stringify(frame) + '\n'), method, args[0])
  }

  /** Connects and handshakes. Resolves on hello_ok, rejects with a readable
   * error on hello_error (bad token, version mismatch) or timeout. Concurrent
   * callers share one dial (a backoff timer firing mid-reconnectNow must not
   * open a second socket on the same connection). */
  async connect(): Promise<void> {
    if (this.disposed) throw new Error(`Runtime "${this.name}" was removed`)
    if (this.connectPromise) return this.connectPromise
    this.connecting = true
    this.connectPromise = this.openSocket().finally(() => {
      this.connecting = false
      this.connectPromise = null
    })
    return this.connectPromise
  }

  /** User-requested reconnect (settings button): dial NOW instead of waiting
   * for the backoff ladder, and reset the attempt counter so the next drop
   * starts from the short delays again. No-op when already connected. */
  async reconnectNow(): Promise<void> {
    if (this.disposed) throw new Error(`Runtime "${this.name}" was removed`)
    if (this.connected) return
    this.reconnectAttempt = 0
    await this.connect()
  }

  /** Disconnects permanently (settings.removeRemote): no more reconnects. */
  dispose(): void {
    this.disposed = true
    this.pump.failAll(`Runtime "${this.name}" was removed`)
    const sock = this.sock
    this.sock = null
    this.ready = false
    sock?.destroy()
  }

  /** Attaches an already-handshaked inbound socket (dial-home, R3-2):
   * the pairing listener consumed the hello; this runtime takes over the
   * socket. A redial replaces the stale socket (same runtime, new line).
   * Re-attach fires ready listeners → re-hydrate (goal.md §5.3). */
  attach(sock: Socket): void {
    if (this.disposed) {
      sock.destroy()
      return
    }
    const old = this.sock
    this.sock = null
    old?.destroy()
    this.ready = true
    this.sock = sock
    this.wireSocket(sock, null)
    this.onStateChange(this.id, true)
    if (this.everConnected) {
      for (const cb of this.readyListeners) {
        try {
          cb()
        } catch (err) {
          console.log(`[daemon:${this.name}] ready listener failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    this.everConnected = true
  }

  /** Shared socket wiring: LF frame parsing → FramePump, plus close/error
   * state transitions. `handshake` is set on outbound dials (openSocket)
   * and null on accepted dial-home sockets (hello already validated). */
  private wireSocket(sock: Socket, handshake: ((err?: Error) => void) | null): void {
    const helloTimer = handshake
      ? setTimeout(() => {
          handshake(new Error(`Runtime "${this.name}" handshake timed out`))
          sock.destroy()
        }, HELLO_TIMEOUT_MS)
      : null
    let buffer = ''
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        let frame: DaemonFrame
        try {
          frame = JSON.parse(line) as DaemonFrame
        } catch {
          console.log(`[daemon:${this.name}] dropping unparseable frame`)
          continue
        }
        this.pump.onFrame(
          frame,
          () => {
            if (helloTimer) clearTimeout(helloTimer)
            handshake?.()
            this.onHelloOk()
          },
          (helloError) => {
            if (helloTimer) clearTimeout(helloTimer)
            handshake?.(new Error(`${helloError.error.code}: ${helloError.error.message}`))
            sock.destroy()
          },
        )
      }
    })
    sock.on('error', (err) => {
      if (helloTimer) clearTimeout(helloTimer)
      handshake?.(new Error(`Runtime "${this.name}" connection failed: ${err.message}`))
    })
    sock.on('close', () => {
      if (helloTimer) clearTimeout(helloTimer)
      this.ready = false
      this.pump.failAll(`Runtime "${this.name}" disconnected`)
      if (this.sock === sock) this.sock = null
      this.onStateChange(this.id, false)
      // Dial-home runtimes never dial out — they wait for the daemon to
      // redial (R3-2).
      if (!this.options?.dialIn) this.scheduleReconnect()
    })
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new Socket()
      this.sock = sock
      let handshake: ((err?: Error) => void) | null = (err) => {
        handshake = null
        err ? reject(err) : resolve()
      }
      sock.on('connect', () => {
        sock.write(JSON.stringify({ type: 'hello', protocol: DAEMON_PROTOCOL, token: this.token, clientId: 'pion-main' }) + '\n')
      })
      this.wireSocket(sock, handshake)
      sock.connect(this.port, this.host)
    })
  }

  private onHelloOk(): void {
    this.ready = true
    this.onStateChange(this.id, true)
    if (this.everConnected) {
      // M3-equivalent re-hydrate for the remote carrier (goal.md §5.3).
      for (const cb of this.readyListeners) {
        try {
          cb()
        } catch (err) {
          console.log(`[daemon:${this.name}] ready listener failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    this.everConnected = true
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.connecting) return
    const delay = RESPAWN_DELAYS_MS[Math.min(this.reconnectAttempt, RESPAWN_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    console.log(`[daemon:${this.name}] will reconnect in ${delay}ms`)
    setTimeout(() => {
      if (this.disposed || this.connected) return
      this.connect()
        .then(() => {
          this.reconnectAttempt = 0
          console.log(`[daemon:${this.name}] reconnected and ready`)
        })
        .catch(() => undefined)
    }, delay).unref()
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Registry: local + remote connections, credentials, project routing
// ──────────────────────────────────────────────────────────────────────────

const CREDENTIALS_FILE = 'remote-runtimes.json'
const DEFAULT_LISTEN_PORT = 4970

interface StoredRuntime {
  id: string
  name: string
  host: string
  port: number
  tokenEncrypted: string
  /** R3-2 dial-home runtimes: the remote daemon dials into our pairing
   * listener; there is nothing to connect out to. */
  dial?: 'in'
}

interface CredFile {
  listener?: { enabled: boolean; port: number }
  runtimes: StoredRuntime[]
  /** Per-install secret handed to the LOCAL daemon's --listen-ws carrier
   * (spawn args come from localWsArgs()). Stable across restarts so a
   * scanned QR keeps working; encrypted like every other token. */
  localWsTokenEncrypted?: string
}

class DaemonRegistry {
  private local = new LocalConnection(() => this.localWsArgs())
  private remotes = new Map<string, RemoteConnection>()
  private tokens = new Map<string, string>() // id → plaintext (main-only)
  /** Local daemon WS-carrier secret; generated once, persisted, reused so
   * scanned QRs survive app restarts. */
  private localWsTokenValue: string | null = null
  /** projectPath → runtimeId; populated from merged projects.list results. */
  private projectRuntime = new Map<string, string>()
  /** runtimeId (a daemon process's pi child) → owning connection id. Runtime-
   * level calls (agent.command/stop) carry no projectPath, so without this
   * map they would always land on the local daemon and every remote send /
   * model switch would die with "Runtime is no longer available". Populated
   * on agent.start replies and refreshed by the merged agent.list sweep;
   * entries die naturally with their daemon (unknown id → owner lookup miss
   * → local fallback → the daemon's own readable error). */
  private runtimeOwner = new Map<string, string>()
  private stateListeners = new Set<(id: string, connected: boolean) => void>()
  private readyListeners = new Set<(runtimeId: string) => void>()
  private listenerEnabled = false
  private listenerPort: number | null = null
  /** Dial-home pairing listener (R3-2): accept inbound dials from remote
   * daemons; one-time pairing tokens mint fresh runtimes, stored tokens
   * re-attach existing ones. */
  private pairing = new PairingManager({
    runtimeIdByToken: (token) => this.runtimeIdByToken(token),
    attachDialIn: (id, sock) => this.attachDialIn(id, sock),
    pairInNew: (token, sock, remoteAddr) => this.pairInNew(token, sock, remoteAddr),
    notifyState: (id, connected) => this.notifyState(id, connected),
    daemonBundlePath: () => this.daemonBundleFile,
  })

  /** Single-file daemon bundle served over the pairing port (④ R3 bootstrap);
   * refreshed by settings.pairing.start before each pairing window. */
  private daemonBundleFile: string | null = null

  setDaemonBundleFile(path: string): void {
    this.daemonBundleFile = path
  }

  private runtimeIdByToken(token: string): string | undefined {
    const target = Buffer.from(token, 'utf8')
    for (const [id, stored] of this.tokens) {
      const b = Buffer.from(stored, 'utf8')
      if (b.length === target.length && timingSafeEqual(b, target)) return id
    }
    return undefined
  }

  /** A paired dial-home runtime redialed: attach the fresh socket to its
   * existing connection (new line replaces the stale one). */
  private attachDialIn(id: string, sock: Socket): void {
    const conn = this.remotes.get(id)
    if (!conn) {
      sock.destroy()
      return
    }
    conn.attach(sock)
  }

  /** A one-time pairing token dialed in: mint the runtime entry, attach the
   * socket, persist. */
  private pairInNew(token: string, sock: Socket, remoteAddr: string): void {
    const id = `remote-${randomUUID().slice(0, 8)}`
    const conn = new RemoteConnection(id, remoteAddr, remoteAddr, 0, token, (rid, connected) => this.notifyState(rid, connected), { dialIn: true })
    conn.onReady(() => this.notifyReady(id))
    this.remotes.set(id, conn)
    this.tokens.set(id, token)
    this.announceConnection(conn)
    conn.attach(sock)
    void this.persist()
  }

  /** Starts (or reuses) the dial-home listener + opens a one-time pairing
   * window. Bind failures surface readable errors to settings UI. */
  async startPairing(port?: number): Promise<{ port: number; token: string; expiresAt: string }> {
    if (!this.pairing.enabled) {
      try {
        await this.setListener(true, port ?? DEFAULT_LISTEN_PORT)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!this.pairing.enabled) {
          // Boot-race reuse: a stored listener is already bound — fine.
          // Default-port collision (another Pion instance holds it): fall
          // back to an ephemeral port so pairing still works; the command
          // carries the actual port. An explicitly pinned port surfaces its
          // error instead.
          if (port !== undefined || !message.includes('EADDRINUSE')) throw err
          await this.setListener(true, 0)
          console.log('[pairing] default port busy; bound ephemeral port')
        }
      }
    }
    const { token, expiresAt } = this.pairing.startPairing()
    return { port: this.pairing.port!, token, expiresAt }
  }

  cancelPairing(): void {
    this.pairing.cancelPairing()
  }

  async setListener(enabled: boolean, port?: number): Promise<void> {
    if (enabled) {
      const target = port ?? this.listenerPort ?? DEFAULT_LISTEN_PORT
      if (this.pairing.enabled && this.pairing.port !== target) {
        this.pairing.stopListener()
      }
      if (!this.pairing.enabled) await this.pairing.startListener(target)
      this.listenerEnabled = true
      this.listenerPort = this.pairing.port
    } else {
      this.pairing.stopListener()
      this.listenerEnabled = false
    }
    await this.persist()
  }

  settingsStatus(): { listenerEnabled: boolean; listenerPort: number | null; pairing: { active: true; token: string; expiresAt: string } | null } {
    const info = this.pairing.pairingInfo()
    return {
      listenerEnabled: this.pairing.enabled,
      listenerPort: this.pairing.port,
      pairing: info ? { active: true, token: info.token, expiresAt: info.expiresAt } : null,
    }
  }

  /** Non-internal IPv4 addresses, for the dial command preview. */
  lanHosts(): string[] {
    const out: string[] = []
    for (const infos of Object.values(networkInterfaces())) {
      for (const i of infos ?? []) {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address)
      }
    }
    return out.length ? out : ['127.0.0.1']
  }

  /** 'local' wins ties (registered first); a remote registering the same
   * path later does not re-home an already-known project. */
  registerProjects(runtimeId: string, paths: string[]): void {
    for (const path of paths) {
      if (!this.projectRuntime.has(path)) this.projectRuntime.set(path, runtimeId)
    }
  }

  /** Routes a projectPath to its owning connection. Defaults to local for
   * unregistered paths (all pre-④ data is local; the owning daemon errors
   * verbatim for paths it doesn't know). */
  resolve(projectPath?: string): DaemonConnection {
    if (projectPath) {
      const runtimeId = this.projectRuntime.get(projectPath)
      if (runtimeId) {
        const conn = this.connection(runtimeId)
        if (conn) return conn
      }
    }
    return this.local
  }

  /** Routing owner of a project path, if registered. */
  ownerOf(projectPath: string): string | undefined {
    return this.projectRuntime.get(projectPath)
  }

  /** Paths registered to a runtime (④: offline stub records in projects.list). */
  registeredPaths(runtimeId: string): string[] {
    const paths: string[] = []
    for (const [path, rid] of this.projectRuntime) if (rid === runtimeId) paths.push(path)
    return paths
  }

  connection(runtimeId: string): DaemonConnection | undefined {
    return runtimeId === 'local' ? this.local : this.remotes.get(runtimeId)
  }

  getConnection(runtimeId: string): DaemonConnection | undefined {
    return this.connection(runtimeId)
  }

  /** Remembers which connection owns a pi runtime (agent.start reply time). */
  rememberRuntimeOwner(runtimeId: string, connId: string): void {
    this.runtimeOwner.set(runtimeId, connId)
  }

  /** The connection that owns a pi runtime, by runtimeId. Undefined when no
   * daemon has reported it — callers fall back to local (whose daemon then
   * answers with its own readable "Runtime is no longer available"). */
  connectionByRuntime(runtimeId: string): DaemonConnection | undefined {
    const owner = this.runtimeOwner.get(runtimeId)
    if (!owner) return undefined
    const conn = this.connection(owner)
    if (!conn) {
      this.runtimeOwner.delete(runtimeId)
      return undefined
    }
    return conn
  }

  get localConnection(): LocalConnection {
    return this.local
  }

  /** Spawn args that turn the local daemon into a phone-reachable runtime:
   * resident (listeners demand it) + owner-stdio (the pipe stays the owner
   * control channel) + a WS listener on a default port (0.0.0.0 so the
   * phone can dial the LAN address). Fixed default 4971 keeps the scanned
   * QR valid across GUI restarts; if busy the daemon walks up and the
   * actual port is read back via daemon.info when the QR is rendered. */
  private localWsArgs(): string[] {
    return ['--stay-resident', '--owner-stdio', '--listen-ws', '0.0.0.0:4971', '--token', this.localWsToken()]
  }

  /** The local daemon's WS token, generating it on first use. */
  localWsToken(): string {
    if (!this.localWsTokenValue) {
      this.localWsTokenValue = `pion-${randomBytes(18).toString('base64url')}`
      void this.persist()
    }
    return this.localWsTokenValue
  }

  /** Plaintext token for a runtime id (settings QR only; never leaves main
   * except composed into the pion:// link the user explicitly shows). */
  tokenFor(id: string): string | undefined {
    return id === 'local' ? this.localWsToken() : this.tokens.get(id)
  }

  /** Every connection known to settings (local + registered remotes). */
  connections(): DaemonConnection[] {
    return [this.local, ...this.remotes.values()]
  }

  listConnections(): DaemonConnection[] {
    return this.connections()
  }

  /** host/port for a remote id (settings.list descriptor); undefined for
   * local or unknown. */
  remoteMeta(id: string): { host: string; port: number } | undefined {
    const conn = this.remotes.get(id)
    return conn ? { host: conn.hostAddress, port: conn.portNumber } : undefined
  }

  /** Hooks that a NEW remote connection must get (event fan-out added after
   * registration would otherwise miss it). The IPC layer passes its wiring
   * here once at boot; added remotes are wired on connect. */
  onNewConnection(cb: (conn: DaemonConnection) => void): void {
    this.newConnListeners.add(cb)
  }

  private newConnListeners = new Set<(conn: DaemonConnection) => void>()

  private announceConnection(conn: DaemonConnection): void {
    for (const cb of this.newConnListeners) cb(conn)
  }

  onStateChange(cb: (id: string, connected: boolean) => void): void {
    this.stateListeners.add(cb)
  }

  onReady(cb: (runtimeId: string) => void): void {
    this.readyListeners.add(cb)
  }

  private notifyState(id: string, connected: boolean): void {
    for (const cb of this.stateListeners) cb(id, connected)
  }

  private notifyReady(runtimeId: string): void {
    for (const cb of this.readyListeners) cb(runtimeId)
  }

  async addRemote(input: { name: string; host: string; port: number; token: string }): Promise<{ id: string; name: string; host: string; port: number }> {
    const id = `remote-${randomUUID().slice(0, 8)}`
    const conn = new RemoteConnection(id, input.name, input.host, input.port, input.token, (rid, connected) => this.notifyState(rid, connected))
    try {
      await conn.connect()
    } catch (err) {
      // Initial handshake failed: stop the reconnect loop (a failed add must
      // not leave a zombie connection retrying forever — the user re-adds via
      // settings when ready).
      conn.dispose()
      throw err
    }
    conn.onReady(() => this.notifyReady(id))
    this.remotes.set(id, conn)
    this.tokens.set(id, input.token)
    this.announceConnection(conn)
    await this.persist()
    return { id, name: input.name, host: input.host, port: input.port }
  }

  async removeRemote(id: string): Promise<void> {
    const conn = this.remotes.get(id)
    if (!conn) throw new Error(`Unknown runtime: ${id}`)
    conn.dispose()
    this.remotes.delete(id)
    this.tokens.delete(id)
    // Orphaned project mappings fall back to local resolution; the local
    // daemon errors verbatim for paths it doesn't own (existing semantics).
    for (const [path, rid] of this.projectRuntime) {
      if (rid === id) this.projectRuntime.delete(path)
    }
    await this.persist()
  }

  /** Manual reconnect (settings button): immediate dial for a stored remote,
   * bypassing the backoff ladder. Rejects with a readable error so the
   * settings UI can surface why (offline host, bad token, version mismatch). */
  async reconnectRemote(id: string): Promise<void> {
    const conn = this.remotes.get(id)
    if (!conn) throw new Error(`Unknown runtime: ${id}`)
    if (conn.dialIn) throw new Error('dial-home runtime — the remote daemon redials by itself; enable the listener instead')
    await conn.reconnectNow()
  }

  /** One-shot probe for settings.test — connect, hello, read version, drop. */
  async probe(input: { host: string; port: number; token: string }): Promise<{ daemonVersion: string }> {
    return new Promise((resolve, reject) => {
      const sock = new Socket()
      let buffer = ''
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error('connection timed out'))
      }, HELLO_TIMEOUT_MS)
      sock.on('connect', () => {
        sock.write(JSON.stringify({ type: 'hello', protocol: DAEMON_PROTOCOL, token: input.token, clientId: 'pion-main-probe' }) + '\n')
      })
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const idx = buffer.indexOf('\n')
        if (idx < 0) return
        const line = buffer.slice(0, idx)
        buffer = ''
        try {
          const frame = JSON.parse(line) as DaemonFrame
          clearTimeout(timer)
          sock.destroy()
          if (frame.type === 'hello_ok') resolve({ daemonVersion: frame.daemonVersion })
          else if (frame.type === 'hello_error') reject(new Error(`${frame.error.code}: ${frame.error.message}`))
          else reject(new Error('unexpected frame during handshake'))
        } catch {
          clearTimeout(timer)
          sock.destroy()
          reject(new Error('unparseable handshake frame'))
        }
      })
      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      sock.connect(input.port, input.host)
    })
  }

  private credFile(): string {
    return join(app.getPath('userData'), CREDENTIALS_FILE)
  }

  private async persist(): Promise<void> {
    const records: StoredRuntime[] = [...this.remotes.values()].map((conn) => {
      const token = this.tokens.get(conn.id) ?? ''
      return {
        id: conn.id,
        name: conn.name,
        host: conn.hostAddress,
        port: conn.portNumber,
        tokenEncrypted: safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token).toString('base64') : '',
        ...(conn.dialIn ? { dial: 'in' as const } : {}),
      }
    })
    const file: CredFile = {
      listener: { enabled: this.listenerEnabled, port: this.listenerPort ?? DEFAULT_LISTEN_PORT },
      runtimes: records,
      ...(this.localWsTokenValue && safeStorage.isEncryptionAvailable()
        ? { localWsTokenEncrypted: safeStorage.encryptString(this.localWsTokenValue).toString('base64') }
        : {}),
    }
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(this.credFile(), JSON.stringify(file, null, 2), 'utf8')
  }

  /** Boot-time: load stored remotes + listener config. Dial-out remotes
   * reconnect; dial-in remotes wait for their daemon to redial; the
   * dial-home listener restarts if it was enabled. MUST run before the local
   * daemon spawns — the spawn args embed the persisted local WS token. */
  async loadAndConnectRemotes(): Promise<void> {
    let parsed: CredFile | StoredRuntime[] = { runtimes: [] }
    try {
      const raw = JSON.parse(await readFile(this.credFile(), 'utf8')) as CredFile | StoredRuntime[]
      parsed = Array.isArray(raw) ? raw : { listener: raw.listener, runtimes: Array.isArray(raw.runtimes) ? raw.runtimes : [], localWsTokenEncrypted: !Array.isArray(raw) ? raw.localWsTokenEncrypted : undefined }
    } catch {
      /* no credentials yet */
    }
    if (!Array.isArray(parsed) && parsed.localWsTokenEncrypted && safeStorage.isEncryptionAvailable()) {
      try {
        this.localWsTokenValue = safeStorage.decryptString(Buffer.from(parsed.localWsTokenEncrypted, 'base64'))
      } catch {
        /* unreadable (keychain change): regenerate below on first use */
      }
    }
    const records = Array.isArray(parsed) ? parsed : parsed.runtimes
    if (!Array.isArray(parsed) && parsed.listener?.enabled) {
      this.listenerEnabled = true
      this.listenerPort = parsed.listener.port
      await this.pairing.startListener(parsed.listener.port).catch((err) => {
        console.log(`[pairing] stored listener port unavailable: ${err instanceof Error ? err.message : String(err)}`)
        this.listenerEnabled = false
      })
    }
    for (const r of records) {
      try {
        if (!safeStorage.isEncryptionAvailable() || !r.tokenEncrypted) continue
        const token = safeStorage.decryptString(Buffer.from(r.tokenEncrypted, 'base64'))
        const conn = new RemoteConnection(r.id, r.name, r.host, r.port, token, (rid, connected) => this.notifyState(rid, connected), { dialIn: r.dial === 'in' })
        conn.onReady(() => this.notifyReady(r.id))
        this.remotes.set(r.id, conn)
        this.tokens.set(r.id, token)
        this.announceConnection(conn)
        this.notifyState(r.id, false)
        // Dial-in runtimes never dial out — they wait for the remote daemon.
        if (r.dial !== 'in') void conn.connect().catch(() => undefined)
      } catch (err) {
        console.log(`[daemon] stored runtime ${r.id} failed to load: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async stopAll(): Promise<void> {
    this.pairing.close()
    for (const conn of this.remotes.values()) conn.dispose()
    this.remotes.clear()
    await this.local.stop()
  }
}

export const daemons = new DaemonRegistry()
