// pion-daemon wire server (protocol v3): multiple authenticated clients at a
// time (cap MAX_CLIENTS), over three carriers with identical frames
// (contracts/daemon-protocol.ts):
//
// - stdio (owner client, spawn mode): newline-delimited JSON on stdin/stdout,
//   the pipe pair IS the credential — no hello/token (v1 behavior, frozen).
// - WS (resident mode, --listen-ws + --token): each WS text message carries
//   one frame; the first message must be `hello` (protocol + token +
//   clientId?), then the frame stream is identical to stdio. hello mismatch →
//   hello_error then close(1003); a client over the cap → hello_error(conflict).
// - TCP JSONL (resident mode, --listen): same hello/token gate over a plain
//   socket, one LF-terminated JSON frame per line (Pion main's carrier —
//   Electron's Node event loop stalls after a client-side WS upgrade).
// - dial-home (④ R3-1, --connect): the daemon is the CLIENT — it dials the
//   local Pion pairing listener, sends `hello` first (protocol + token),
//   waits for hello_ok, then the socket becomes one of the control channels
//   (an owner carrier, like stdio). Broken handshakes / disconnects → backoff
//   re-dial, never give up while the process lives.
//
// v3 semantics: events are broadcast to every handshaken client with the same
// daemon-wide seq; call results go back to the requesting connection only.
// `daemon.shutdown` is accepted from owner carriers (stdio / dial-home) only.
// Logs go to <userData>/daemon.log (redirectLogging in index.ts), keeping
// stdout clean for protocol frames in spawn mode.
import { createInterface } from 'node:readline'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket, type WebSocket as WsSocket } from 'ws'
import type {
  CallFrame,
  ClientFrame,
  DaemonErrorCode,
  DaemonEventChannel,
  DaemonEventMap,
  DaemonFrame,
  HelloFrame,
} from '../contracts/daemon-protocol'
import { DAEMON_PROTOCOL, DAEMON_PROTOCOL_VERSION } from '../contracts/daemon-protocol'

/** Error a method handler throws to control the result envelope's code.
 * Anything else collapses to `internal`. */
export class DaemonRpcError extends Error {
  readonly code: DaemonErrorCode
  constructor(code: DaemonErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

type MethodHandler = (params: unknown) => Promise<unknown> | unknown

/** v3: a handshaken client connection. Owner carriers (stdio / dial-home)
 * may call `daemon.shutdown`; listen carriers (ws / tcp) may not. */
interface ClientInfo {
  carrier: 'stdio' | 'ws' | 'tcp' | 'dial-home'
  clientId?: string
}

/** v3: upper bound on simultaneous clients. The GUI + a phone + headroom;
 * a hard cap keeps a buggy client from pinning sockets forever. */
const MAX_CLIENTS = 4

/** Where result/event frames go. Exactly one active control transport at a
 * time (single-control-client rule, cross-carrier). */
interface Transport {
  send(frame: DaemonFrame): void
  close(code?: number): void
}

class StdioTransport implements Transport {
  send(frame: DaemonFrame): void {
    process.stdout.write(JSON.stringify(frame) + '\n')
  }
  close(): void {
    /* spawn mode: the process exits after serveStdio resolves */
  }
}

class WsTransport implements Transport {
  constructor(readonly ws: WsSocket) {}
  send(frame: DaemonFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }
  close(code?: number): void {
    this.ws.close(code ?? 1000)
  }
}

/** Live network listener entry for `daemon.info` (QR rendering). `port` is
 * what the OS actually bound — an ephemeral port 0 or a walked-up default
 * lands somewhere the caller could not have guessed. */
export interface ListenerInfo {
  kind: 'ws' | 'tcp'
  host: string
  port: number
}

// TCP JSONL carrier (④ R2-A): one LF-terminated JSON frame per line — the
// stdio discipline over a socket. Exists because Electron main's Node event
// loop stalls after a client-side WS upgrade (goal.md v3 §5.2, reconfirmed
// during R2-A against a resident peer); Pion's own client uses this carrier.
// WS stays for browser-class clients (iOS).
import { createServer, Socket, type Server } from 'node:net'

class JsonlTransport implements Transport {
  constructor(readonly socket: Socket) {}
  send(frame: DaemonFrame): void {
    if (!this.socket.destroyed) this.socket.write(JSON.stringify(frame) + '\n')
  }
  close(): void {
    this.socket.end()
  }
}

/** Actual bound port from an address() result, falling back to the requested
 * port (address() can be null in odd shutdown races — never crash here). */
function boundPort(address: ReturnType<Server['address']> | { port: number } | null, fallback: number): number {
  if (address && typeof address === 'object' && typeof (address as { port?: unknown }).port === 'number') {
    return (address as { port: number }).port
  }
  return fallback
}

export class DaemonServer {
  private daemonVersion: string
  private methods = new Map<string, MethodHandler>()
  /** v3: all handshaken clients. Keyed by transport for O(1) detach. */
  private clients = new Map<Transport, ClientInfo>()
  private listener: WebSocketServer | null = null
  private shutdownHook: (() => void) | null = null
  private dialDisposed = false
  private dialRetry = 0
  private dialTimer: NodeJS.Timeout | null = null
  private seq = 0
  private bootedAt = Date.now()
  /** Network listeners bound so far (daemon.info). */
  private readonly listeners: ListenerInfo[] = []

  constructor(options: { daemonVersion: string }) {
    this.daemonVersion = options.daemonVersion
    this.register('ping', () => ({ pong: true, pid: process.pid, uptimeMs: Date.now() - this.bootedAt }))
    this.register('daemon.info', () => this.info())
  }

  /** Identity + live listeners (the `daemon.info` result; boot also reads the
   * actual bound WS port after starting listeners). */
  info(): { daemonVersion: string; protocolVersion: number; listeners: ListenerInfo[] } {
    return { daemonVersion: this.daemonVersion, protocolVersion: DAEMON_PROTOCOL_VERSION, listeners: this.listeners.map((l) => ({ ...l })) }
  }

  register(method: string, handler: MethodHandler): void {
    if (this.methods.has(method)) throw new Error(`method already registered: ${method}`)
    this.methods.set(method, handler)
  }

  /** Called by index.ts: daemon.shutdown replies ok, then asks for the
   * graceful exit ladder (drain in-flight result frames first). */
  setShutdownHook(fn: () => void): void {
    this.shutdownHook = fn
    this.register('daemon.shutdown', () => {
      setTimeout(() => this.shutdownHook?.(), 200).unref()
      return null
    })
  }

  /** Serves the owner client over stdin/stdout. Resolves when stdin closes
   * (the parent went away — time to shut down). Spawn mode only. */
  serveStdio(): Promise<void> {
    return new Promise((resolve) => {
      // hello_ok announces readiness; no client hello is required over stdio
      // (the pipe is the credential).
      const t = new StdioTransport()
      this.clients.set(t, { carrier: 'stdio' })
      t.send({ type: 'hello_ok', protocol: DAEMON_PROTOCOL, daemonVersion: this.daemonVersion, lastSeq: this.seq })
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
      rl.on('line', (line) => {
        if (!line.trim()) return
        let frame: ClientFrame
        try {
          frame = JSON.parse(line) as ClientFrame
        } catch {
          console.log('[daemon] dropping unparseable client frame')
          return
        }
        this.onClientFrame(frame, t)
      })
      rl.on('close', () => {
        this.clients.delete(t)
        resolve()
      })
    })
  }

  /** WS listener carrier (resident mode, --listen-ws): clients MUST hello
   * first (protocol + token). Resolves once bound; rejects on bind errors. */
  startListener(options: { host: string; port: number; token: string }): Promise<void> {
    const tokenBytes = Buffer.from(options.token, 'utf8')
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: options.host, port: options.port })
      wss.on('error', (err) => {
        console.log(`[daemon] ws listener error: ${err.message}`)
        reject(err)
      })
      wss.on('listening', () => {
        const bound = boundPort(wss.address(), options.port)
        console.log(`[daemon] ws listening on ${options.host}:${bound}`)
        this.listeners.push({ kind: 'ws', host: options.host, port: bound })
        resolve()
      })
      wss.on('connection', (ws) => this.onWsConnection(ws, tokenBytes))
      this.listener = wss
    })
  }

  /** TCP JSONL listener (resident mode, --listen): the same hello/token gate
   * and frame semantics as WS, one LF-terminated JSON frame per line. This
   * is the carrier Pion's Electron main uses (Electron's Node event loop
   * stalls after a client-side WS upgrade — see JsonlTransport's note). */
  startJsonlListener(options: { host: string; port: number; token: string }): Promise<void> {
    const tokenBytes = Buffer.from(options.token, 'utf8')
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onJsonlConnection(socket, tokenBytes))
      server.on('error', (err) => {
        console.log(`[daemon] tcp listener error: ${err.message}`)
        reject(err)
      })
      server.listen(options.port, options.host, () => {
        const bound = boundPort(server.address(), options.port)
        console.log(`[daemon] tcp listening on ${options.host}:${bound}`)
        this.listeners.push({ kind: 'tcp', host: options.host, port: bound })
        resolve()
      })
      this.tcpListener = server
    })
  }

  private tcpListener: Server | null = null

  private onJsonlConnection(socket: Socket, tokenBytes: Buffer): void {
    let handshaken = false
    let buffer = ''
    const transport = new JsonlTransport(socket)
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        let frame: ClientFrame
        try {
          frame = JSON.parse(line) as ClientFrame
        } catch {
          console.log('[daemon] dropping unparseable tcp frame')
          continue
        }
        if (!handshaken) {
          if (frame.type !== 'hello') {
            // Frames before the handshake: close without answering (§3).
            socket.destroy()
            return
          }
          handshaken = this.helloGate(frame, tokenBytes, transport, 'tcp')
          continue
        }
        this.onClientFrame(frame, transport)
      }
    })
    socket.on('close', () => {
      if (handshaken) {
        this.clients.delete(transport)
        console.log('[daemon] tcp client disconnected')
      }
    })
    socket.on('error', () => {
      /* close event follows */
    })
  }

  /** Dial-home carrier (④ R3-1, --connect): the daemon dials the local Pion
   * pairing listener, announces itself with `hello` (protocol + token), and
   * waits for hello_ok (protocol must match; hello_error / timeout / drop →
   * backoff re-dial). After hello_ok the socket IS the owner control
   * channel — identical frame discipline as stdio. Re-dials forever until
   * close() (shutdown), so both peers may restart freely. */
  dialHome(options: { host: string; port: number; token: string; clientId: string }): void {
    const attempt = (): void => {
      if (this.dialDisposed) return
      const sock = new Socket()
      let handshaken = false
      let buffer = ''
      const transport = new JsonlTransport(sock)
      const helloTimer = setTimeout(() => {
        console.log(`[daemon] dial-home handshake timed out (${options.host}:${options.port}), redialing`)
        sock.destroy()
      }, 10_000)
      helloTimer.unref?.()
      sock.on('connect', () => {
        sock.write(JSON.stringify({ type: 'hello', protocol: DAEMON_PROTOCOL, token: options.token, clientId: options.clientId }) + '\n')
      })
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.trim()) continue
          let frame: ClientFrame | DaemonFrame
          try {
            frame = JSON.parse(line) as ClientFrame | DaemonFrame
          } catch {
            console.log('[daemon] dropping unparseable dial-home frame')
            continue
          }
          if (!handshaken) {
            if (frame.type === 'hello_ok') {
              if (frame.protocol !== DAEMON_PROTOCOL) {
                console.log(`[daemon] dial-home protocol mismatch (peer ${frame.protocol}, we ${DAEMON_PROTOCOL}), redialing`)
                clearTimeout(helloTimer)
                sock.destroy()
                return
              }
              handshaken = true
              clearTimeout(helloTimer)
              this.clients.set(transport, { carrier: 'dial-home', clientId: options.clientId })
              this.dialRetry = 0
              console.log(`[daemon] dial-home control channel attached (${options.host}:${options.port})`)
              continue
            }
            if (frame.type === 'hello_error') {
              console.log(`[daemon] dial-home rejected (${frame.error.code}: ${frame.error.message}), redialing`)
              clearTimeout(helloTimer)
              sock.destroy()
              return
            }
            // Frames before hello_ok: dropped (spec: nothing is served early).
            console.log(`[daemon] dropping dial-home frame before hello_ok: ${frame.type}`)
            continue
          }
          if (frame.type === 'call') this.onClientFrame(frame, transport)
        }
      })
      const teardown = (): void => {
        clearTimeout(helloTimer)
        if (handshaken) {
          this.clients.delete(transport)
          console.log('[daemon] dial-home control channel lost')
        }
        this.scheduleRedial(options)
      }
      sock.on('close', teardown)
      sock.on('error', (err) => {
        if (!handshaken) console.log(`[daemon] dial-home connect failed (${options.host}:${options.port}): ${err.message}`)
        /* close event follows → teardown → re-dial */
      })
      sock.connect(options.port, options.host)
    }
    attempt()
  }

  private scheduleRedial(options: { host: string; port: number; token: string; clientId: string }): void {
    if (this.dialDisposed) return
    const delays = [1_000, 2_000, 5_000, 10_000]
    const delay = delays[Math.min(this.dialRetry, delays.length - 1)]
    this.dialRetry += 1
    console.log(`[daemon] dial-home redial in ${delay}ms (attempt ${this.dialRetry})`)
    this.dialTimer = setTimeout(() => {
      this.dialTimer = null
      this.dialHome(options)
    }, delay)
    this.dialTimer.unref?.()
  }

  private onWsConnection(ws: WsSocket, tokenBytes: Buffer): void {
    let handshaken = false
    let transport: WsTransport | null = null
    ws.on('message', (data) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(data.toString()) as ClientFrame
      } catch {
        console.log('[daemon] dropping unparseable ws frame')
        return
      }
      if (!handshaken) {
        if (frame.type !== 'hello') {
          // Frames before the handshake: close without answering (§3).
          ws.close(1003)
          return
        }
        transport = new WsTransport(ws)
        handshaken = this.helloGate(frame, tokenBytes, transport, 'ws')
        return
      }
      this.onClientFrame(frame, transport as WsTransport)
    })
    ws.on('close', () => {
      if (handshaken && transport) {
        this.clients.delete(transport)
        console.log('[daemon] ws client disconnected')
      }
    })
    ws.on('error', () => {
      /* close event follows */
    })
  }

  /** Shared handshake gate (WS + TCP JSONL): protocol → token → client cap.
   * On success the connection joins the client table; sends hello_error +
   * closes otherwise. */
  private helloGate(frame: HelloFrame, tokenBytes: Buffer, transport: Transport, carrier: string): boolean {
    const helloError = (code: DaemonErrorCode, message: string): boolean => {
      transport.send({ type: 'hello_error', error: { code, message } })
      transport.close(1003)
      return false
    }
    if (frame.protocol !== DAEMON_PROTOCOL) {
      return helloError('version_mismatch', `protocol mismatch: client=${frame.protocol}, daemon=${DAEMON_PROTOCOL}`)
    }
    const token = Buffer.from(typeof frame.token === 'string' ? frame.token : '', 'utf8')
    if (token.length !== tokenBytes.length || !timingSafeEqual(token, tokenBytes)) {
      return helloError('unauthorized', 'token missing or wrong')
    }
    if (this.clients.size >= MAX_CLIENTS) {
      return helloError('conflict', `client cap reached (${MAX_CLIENTS})`)
    }
    transport.send({ type: 'hello_ok', protocol: DAEMON_PROTOCOL, daemonVersion: this.daemonVersion, lastSeq: this.seq })
    this.clients.set(transport, { carrier: carrier as ClientInfo['carrier'], clientId: frame.clientId })
    console.log(`[daemon] ${carrier} client attached${frame.clientId ? ` (clientId=${frame.clientId})` : ''} [${this.clients.size}/${MAX_CLIENTS}]`)
    return true
  }

  private onClientFrame(frame: ClientFrame, transport: Transport): void {
    if (frame.type !== 'call') {
      console.log(`[daemon] dropping unexpected client frame: ${(frame as { type?: string }).type}`)
      return
    }
    void this.onCall(frame, transport).catch(() => undefined)
  }

  /** Pushes an event to every handshaken client (v3 broadcast). Monotonic
   * daemon-wide seq; clients recover via re-hydrate (goal.md §5.3). With no
   * clients the event is dropped (spawn mode always has stdio; resident mode
   * may sit clientless). */
  broadcast(channel: DaemonEventChannel, payload: unknown): void {
    this.seq += 1
    const frame: DaemonFrame = { type: 'event', channel, seq: this.seq, payload: payload as DaemonEventMap[DaemonEventChannel] }
    for (const client of this.clients.keys()) client.send(frame)
  }

  close(): void {
    this.dialDisposed = true
    if (this.dialTimer) {
      clearTimeout(this.dialTimer)
      this.dialTimer = null
    }
    this.listener?.close()
    this.tcpListener?.close()
    for (const client of this.clients.keys()) client.close()
    this.clients.clear()
  }

  private async onCall(frame: CallFrame, transport: Transport): Promise<void> {
    const reply = (ok: true, value: unknown): void => transport.send({ type: 'result', id: frame.id, ok, value })
    const replyError = (code: DaemonErrorCode, message: string): void =>
      transport.send({ type: 'result', id: frame.id, ok: false, error: { code, message } })
    const handler = this.methods.get(frame.method)
    if (!handler) {
      replyError('not_found', `unknown method: ${frame.method}`)
      return
    }
    // v3: lifecycle is owned by the owner side (the GUI that spawned or
    // paired this daemon) — phones on listen carriers must not shut it down.
    if (frame.method === 'daemon.shutdown') {
      const client = this.clients.get(transport)
      if (client && client.carrier !== 'stdio' && client.carrier !== 'dial-home') {
        replyError('unauthorized', 'daemon.shutdown requires an owner carrier (stdio / dial-home)')
        return
      }
    }
    try {
      reply(true, await handler(frame.params))
    } catch (err) {
      if (err instanceof DaemonRpcError) {
        replyError(err.code, err.message)
      } else {
        const message = err instanceof Error ? err.message : String(err)
        console.log(`[daemon] method ${frame.method} failed: ${message}`)
        replyError('internal', message)
      }
    }
  }
}
