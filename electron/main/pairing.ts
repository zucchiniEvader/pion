// Dial-home pairing listener (④ R3-2, goal.md §9): Pion listens locally;
// the remote daemon dials in with `--connect <host:port> --token <token>`
// (implemented in daemon/ R3-1). One TCP connection, LF-terminated JSON
// frames, hello gate:
//
//   token == active pairing token   → new pairing: create a runtime entry,
//                                     hello_ok, hand the socket to main as
//                                     an accepted RemoteConnection, pairing
//                                     token is destroyed
//   token == a paired runtime's     → that runtime re-dialing after a drop:
//                                     hello_ok, same-runtime re-attach (new
//                                     socket replaces the stale one)
//   anything else                   → close silently (no error frame, no
//                                     probing surface)
//
// Electron-free and dependency-injected so the module is testable with a
// plain node harness (scripts/daemon-pairing-test.mjs). The registry wires
// the deps in daemon-client.ts.
import { createServer, type Server, type Socket } from 'node:net'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DAEMON_PROTOCOL, type DaemonFrame } from '../../contracts/daemon-protocol'

export interface PairingDeps {
  /** Look up a paired runtime by its dial token (in-memory plaintext map). */
  runtimeIdByToken(token: string): string | undefined
  /** An already-paired runtime re-dialed: attach the fresh socket to its
   * existing connection object (replaces any stale socket). */
  attachDialIn(id: string, sock: Socket, remoteAddr: string): void
  /** A new pairing dial completed: create + persist the runtime entry. */
  pairInNew(token: string, sock: Socket, remoteAddr: string): void
  /** Connection-state fan-out (renderer settings updates). */
  notifyState(id: string, connected: boolean): void
  /** Current path of the single-file daemon bundle, served over the pairing
   * port so the remote one-liner can curl it (④ R3 bootstrap). */
  daemonBundlePath(): string | null
}

const HELLO_TIMEOUT_MS = 8_000
const PAIRING_TTL_MS = 10 * 60_000

export class PairingManager {
  private server: Server | null = null
  private pairToken: string | null = null
  private pairExpiresAt: Date | null = null
  private pairTimer: NodeJS.Timeout | null = null
  private ttlMs: number
  private deps: PairingDeps
  /** Resolved listen port once the listener is up (null when disabled). */
  port: number | null = null

  constructor(deps: PairingDeps, options?: { ttlMs?: number }) {
    this.deps = deps
    this.ttlMs = options?.ttlMs ?? PAIRING_TTL_MS
  }

  get enabled(): boolean {
    return this.server !== null
  }

  get pairingActive(): boolean {
    return this.pairToken !== null
  }

  pairingInfo(): { token: string; expiresAt: string } | null {
    if (!this.pairToken || !this.pairExpiresAt) return null
    return { token: this.pairToken, expiresAt: this.pairExpiresAt.toISOString() }
  }

  /** Starts the dial-home listener on 0.0.0.0:<port>. Idempotent when the
   * listener is already up on the same port. */
  async startListener(port: number): Promise<void> {
    if (this.server) {
      if (this.port === port) return
      this.stopListener()
    }
    const server = createServer((sock) => void this.onConnection(sock))
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err) => reject(new Error(`pairing listener failed to bind: ${err.message}`)))
      server.listen(port, '0.0.0.0', () => {
        // Port 0 (ephemeral fallback) → surface the ACTUAL bound port; the
        // pairing command embeds it.
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve()
      })
    })
    this.server = server
    console.log(`[pairing] dial-home listener on 0.0.0.0:${this.port}`)
  }

  /** Stops the listener. Accepted runtime connections are NOT torn down —
   * disabling only stops NEW dials (already-paired runtimes redial later). */
  stopListener(): void {
    this.server?.close()
    this.server = null
    this.port = null
    this.cancelPairing()
    console.log('[pairing] dial-home listener stopped')
  }

  /** Opens (or resets) a one-time pairing window. Returns the token + expiry. */
  startPairing(): { token: string; expiresAt: string } {
    this.destroyPairToken()
    const token = 'PION-PAIR-' + Array.from({ length: 6 }, () => randomInt(10).toString()).join('')
    const expiresAt = new Date(Date.now() + this.ttlMs)
    this.pairToken = token
    this.pairExpiresAt = expiresAt
    this.pairTimer = setTimeout(() => {
      console.log('[pairing] pairing token expired')
      this.destroyPairToken()
    }, this.ttlMs).unref()
    return { token, expiresAt: expiresAt.toISOString() }
  }

  cancelPairing(): void {
    this.destroyPairToken()
  }

  close(): void {
    this.stopListener()
  }

  private destroyPairToken(): void {
    this.pairToken = null
    this.pairExpiresAt = null
    if (this.pairTimer) {
      clearTimeout(this.pairTimer)
      this.pairTimer = null
    }
  }

  private tokenEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    return ab.length === bb.length && timingSafeEqual(ab, bb)
  }

  private write(sock: Socket, frame: DaemonFrame): void {
    sock.write(JSON.stringify(frame) + '\n')
  }

  private onConnection(sock: Socket): void {
    const remoteAddr = sock.remoteAddress ?? 'unknown'
    // Strip the IPv6-mapped IPv4 prefix so names read as plain IPv4.
    const remoteIp = remoteAddr.startsWith('::ffff:') ? remoteAddr.slice(7) : remoteAddr
    let buffer = ''
    let done = false
    let http = false
    const helloTimer = setTimeout(() => {
      if (!done) sock.destroy()
    }, HELLO_TIMEOUT_MS)

    sock.on('data', (chunk) => {
      if (done) return
      buffer += chunk.toString('utf8')
      // Bootstrap branch (④ R3): an HTTP GET on the pairing port downloads
      // the single-file daemon bundle — the remote one-liner curls this same
      // port it later dials. Anything not HTTP falls through to frames.
      if (!http && /^(GET|HEAD) /.test(buffer)) {
        if (!buffer.includes('\r\n\r\n')) return
        done = true
        clearTimeout(helloTimer)
        const path = (buffer.split(' ')[1] ?? '').split('?')[0]
        if (path !== '/pion-daemon.cjs') {
          sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
          return
        }
        const file = this.deps.daemonBundlePath()
        if (!file || !existsSync(file)) {
          sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
          return
        }
        readFile(file)
          .then((body) => {
            sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`)
            sock.end(body)
          })
          .catch(() => sock.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'))
        return
      }
      if (http) return
      const idx = buffer.indexOf('\n')
      if (idx < 0) return
      const line = buffer.slice(0, idx)
      const rest = buffer.slice(idx + 1)
      let hello: { type?: string; protocol?: string; token?: string }
      try {
        hello = JSON.parse(line) as typeof hello
      } catch {
        done = true
        clearTimeout(helloTimer)
        sock.destroy()
        return
      }
      done = true
      clearTimeout(helloTimer)
      if (hello.type !== 'hello' || typeof hello.token !== 'string') {
        sock.destroy()
        return
      }
      if (hello.protocol !== DAEMON_PROTOCOL) {
        // Version mismatch gets a readable frame (the daemon surfaces it);
        // unknown tokens get nothing.
        this.write(sock, { type: 'hello_error', error: { code: 'version_mismatch', message: `expected ${DAEMON_PROTOCOL}` } })
        sock.destroy()
        return
      }
      // 1) Active one-time pairing token → new runtime pairing.
      if (this.pairToken && this.tokenEquals(hello.token, this.pairToken)) {
        const token = this.pairToken
        this.destroyPairToken()
        this.write(sock, { type: 'hello_ok', protocol: DAEMON_PROTOCOL, daemonVersion: 'pion-main', lastSeq: 0 })
        this.deps.pairInNew(token, sock, remoteIp)
        this.seedPump(sock, rest)
        console.log(`[pairing] paired new runtime from ${remoteIp}`)
        return
      }
      // 2) A paired runtime's token → that runtime is redialing; re-attach.
      const runtimeId = this.deps.runtimeIdByToken(hello.token)
      if (runtimeId) {
        this.write(sock, { type: 'hello_ok', protocol: DAEMON_PROTOCOL, daemonVersion: 'pion-main', lastSeq: 0 })
        this.deps.attachDialIn(runtimeId, sock, remoteIp)
        this.seedPump(sock, rest)
        console.log(`[pairing] runtime ${runtimeId} redialed from ${remoteIp}`)
        return
      }
      // 3) Unknown token → close silently.
      sock.destroy()
    })
    sock.on('error', () => sock.destroy())
  }

  /** After the pairing manager consumed the hello line, any leftover bytes
   * belong to the runtime's frame pump — re-inject them as socket data. */
  private seedPump(sock: Socket, rest: string): void {
    if (rest) sock.emit('data', Buffer.from(rest, 'utf8'))
  }
}
