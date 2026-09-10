// PI RPC runtime: spawns `pi --mode rpc`, owns the JSONL transport, correlates
// request/response by id, and forwards events. One runtime = one PI child.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access, constants as fsConstants, readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  PiEvent,
  PiEventEnvelope,
  RpcCommand,
  RpcResponse,
  RuntimeInfo,
} from '../src/types'

const RPC_READ_FRAME_LIMIT_BYTES = 16 * 1024 * 1024
const MAX_RPC_WRITE_FRAME_BYTES = 2 * 1024 * 1024
const MAX_QUEUED_WRITE_BYTES = 32 * 1024 * 1024
const WRITE_DEADLINE_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const COMPACT_TIMEOUT_MS = 10 * 60_000

interface PendingRequest {
  resolve: (value: RpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  command: string
}

// ──────────────────────────────────────────────────────────────────────────
// Strict LF JSONL decoder (bytes-accounted, LF-delimited)
// ──────────────────────────────────────────────────────────────────────────

class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private fragments: string[] = []
  private bytes = 0
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxBytes: number,
    private readonly onTooLarge: (error: Error) => void,
  ) {}
  push(chunk: Buffer): void {
    let start = 0
    for (;;) {
      const index = chunk.indexOf(0x0a, start)
      if (index < 0) break
      const fragment = this.decoder.write(chunk.subarray(start, index))
      this.takeLine(fragment, index - start)
      start = index + 1
    }
    const rest = chunk.subarray(start)
    const fragment = this.decoder.write(rest)
    if (fragment) {
      if (this.bytes + rest.length > this.maxBytes) return this.tooLarge()
      this.fragments.push(fragment)
      this.bytes += rest.length
    }
  }
  end(): void {
    const tail = this.decoder.end()
    if (tail) {
      if (this.bytes + tail.length > this.maxBytes) return this.tooLarge()
      this.fragments.push(tail)
    }
    if (this.fragments.length) {
      const line = this.fragments.join('')
      this.fragments = []
      this.bytes = 0
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
  }
  private takeLine(fragment: string, fragmentBytes: number): void {
    const total = this.bytes + fragmentBytes
    // A CR immediately before LF is framing, not content.
    if (total > this.maxBytes + 1) return this.tooLarge()
    if (fragment) this.fragments.push(fragment)
    const line = this.fragments.join('')
    this.fragments = []
    this.bytes = 0
    const framed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (total - Number(line.endsWith('\r')) > this.maxBytes) return this.tooLarge()
    this.onLine(framed)
  }
  private tooLarge(): never {
    this.onTooLarge(new Error('PI RPC frame exceeded the maximum size'))
    // Stop further decoding; the runtime will fail the transport.
    throw new Error('PI RPC frame exceeded the maximum size')
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Spawn environment + executable discovery
// ──────────────────────────────────────────────────────────────────────────

// An app launched from Finder/Dock inherits a minimal PATH (/usr/bin:/bin:…)
// that misses node/homebrew/nvm locations — pi's `#!/usr/bin/env node`
// shebang then exits 127 even though detectPi found pi via fixed candidates.
// Probe the conventional tool dirs once and prepend the existing ones.
let guiPathPrefix: string | null | undefined

function guiPathPrefixDirs(): string[] {
  const home = homedir()
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/sbin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin')]
  try {
    // Newest nvm node first; all installed versions stay resolvable.
    for (const version of readdirSync(join(home, '.nvm', 'versions', 'node')).sort().reverse()) {
      dirs.push(join(home, '.nvm', 'versions', 'node', version, 'bin'))
    }
  } catch {
    /* nvm not installed */
  }
  return dirs.filter((dir) => existsSync(dir))
}

function augmentedPath(): string | null {
  if (guiPathPrefix === undefined) {
    const dirs = guiPathPrefixDirs()
    guiPathPrefix = dirs.length > 0 ? dirs.join(':') : null
  }
  return guiPathPrefix
}

// Exported for other child-process spawners (git.ts, open-in-app) so every
// PI-adjacent child gets the same scrubbed environment.
export function safeChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_ENABLE_LOGGING',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'LD_PRELOAD',
    'FORCE_COLOR',
  ])
    delete env[key]
  env.NO_COLOR = '1'
  const prefix = process.platform !== 'win32' ? augmentedPath() : null
  if (prefix) env.PATH = `${prefix}:${env.PATH ?? ''}`
  return env
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

const isAbsolute = (p: string): boolean => process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(p) : p.startsWith('/')

function piExecutableCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir()
  const candidates: string[] = []
  // ~/.local/bin/pi is the documented install location.
  candidates.push(join(home, '.local', 'bin', 'pi'))
  // npm global bin — resolve via `npm config get prefix` would need a child,
  // so probe the conventional global locations instead.
  if (process.platform === 'win32') {
    if (env.APPDATA) candidates.push(join(env.APPDATA, 'npm', 'pi.cmd'))
  } else {
    candidates.push('/usr/local/bin/pi')
    candidates.push('/opt/homebrew/bin/pi')
    candidates.push(join(home, '.bun', 'bin', 'pi'))
    candidates.push(join(home, '.npm-global', 'bin', 'pi'))
    candidates.push(join(home, '.volta', 'bin', 'pi'))
  }
  // PATH lookup fallback (deferred to caller via which).
  return candidates
}

async function whichFromPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = env.PATH ?? env.Path
  if (!path) return null
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const candidate = join(dir, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    if (await canAccess(candidate, fsConstants.X_OK)) return candidate
  }
  return null
}

// Detection cache: performStart runs on every session open, and an uncached
// miss spawns `pi --version` (~200ms) serially before the runtime itself.
// Only positive results are cached so a later install is still picked up;
// a failed runtime start invalidates it in case the cached path went bad.
let detectedPi: { path: string; version: string | null } | null = null

export function invalidatePiDetection(): void {
  detectedPi = null
}

/** Locates the pi executable. Returns { path, version } or { path: null }. */
export async function detectPi(): Promise<{ path: string | null; version: string | null; problem?: string }> {
  if (detectedPi) return { ...detectedPi }
  let resolved: string | null = null
  for (const candidate of piExecutableCandidates()) {
    if (await canAccess(candidate, fsConstants.X_OK)) {
      resolved = candidate
      break
    }
  }
  if (!resolved) resolved = await whichFromPath(process.env)
  if (!resolved) return { path: null, version: null }
  const version = await piVersion(resolved).catch(() => null)
  detectedPi = { path: resolved, version }
  return { ...detectedPi }
}

async function piVersion(exe: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { shell: false, env: safeChildEnvironment(), windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null)
      resolve(stdout.trim() || null)
    })
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Process tree cleanup
// ──────────────────────────────────────────────────────────────────────────

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('close', onClose)
  })
}

async function killTree(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  // Process group kill (detached spawn sets a new pgid = child.pid) so
  // descendants die with the parent.
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal)
      } catch {
        /* no process group */
      }
    }
    try {
      child.kill(signal)
    } catch {
      /* already exited */
    }
  }
  for (const rung of [{ signal: 'SIGTERM' as const, wait: 2_000 }, { signal: 'SIGKILL' as const, wait: 1_500 }]) {
    signalTree(rung.signal)
    if (await waitForExit(child, rung.wait)) return true
  }
  return child.exitCode !== null || child.signalCode !== null
}

// ──────────────────────────────────────────────────────────────────────────
// RpcRuntime
// ──────────────────────────────────────────────────────────────────────────

export interface RpcRuntimeCallbacks {
  onEvent: (envelope: PiEventEnvelope) => void
  onExit: (runtime: PiRpcRuntime) => void
}

export class PiRpcRuntime {
  readonly runtimeId = randomUUID()
  private readonly child: ChildProcess
  private readonly pending = new Map<string, PendingRequest>()
  private stopped = false
  private transportFailed = false
  private stopPromise: Promise<boolean> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private queuedWriteBytes = 0
  private stderrChunks: string[] = []
  private stderrBytes = 0
  private info: RuntimeInfo
  // continuationPending / retryPending keep isStreaming true through a
  // non-terminal agent_end + auto_retry backoff so the renderer does not
  // treat the turn as finished.
  private continuationPending = false
  private retryPending = false

  constructor(
    executable: string,
    cwd: string,
    args: string[],
    private readonly callbacks: RpcRuntimeCallbacks,
    extraEnvironment: NodeJS.ProcessEnv = {},
  ) {
    this.info = { runtimeId: this.runtimeId, cwd, isStreaming: false, isCompacting: false }
    this.child = spawn(executable, args, {
      cwd,
      env: safeChildEnvironment(extraEnvironment),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const decoder = new StrictJsonlDecoder(
      (line) => this.handleLine(line),
      RPC_READ_FRAME_LIMIT_BYTES,
      (error) => this.failTransport(error),
    )
    const failPipe = (error: unknown): void => {
      if (this.transportFailed) return
      this.failTransport(error)
    }
    const stdout = this.child.stdout
    const stderr = this.child.stderr
    if (stdout) {
      stdout.on('data', (chunk: Buffer) => {
        try {
          decoder.push(chunk)
        } catch (error) {
          this.failTransport(error)
        }
      })
      stdout.on('end', () => {
        if (this.transportFailed) return
        try {
          decoder.end()
        } catch (error) {
          this.failTransport(error)
        }
      })
      stdout.on('error', failPipe)
    }
    // stderr is collected separately: the protocol stays clean and nothing is
    // streamed live to the renderer. It is NOT discarded — on an unexpected
    // exit the last lines go to daemon.log and one line (never more, and never
    // the whole stream) is attached to the exit error, because pi puts the
    // actual reason there. Bounded to avoid unbounded memory growth.
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        const slice = chunk.toString('utf8')
        const remaining = 64 * 1024 - this.stderrBytes
        if (remaining <= 0) return
        const text = slice.length <= remaining ? slice : slice.slice(0, remaining)
        this.stderrChunks.push(text)
        this.stderrBytes += text.length
      })
      stderr.on('error', failPipe)
    }
    this.child.stdin?.on('error', failPipe)
    this.child.once('error', failPipe)
    this.child.once('close', (code, signal) => {
      // Lifecycle log: runtime exits are otherwise silent, which turns a
      // stale-runtimeId report ("Runtime is no longer available") into an
      // undebuggable black hole.
      console.log(`[daemon] pi runtime ${this.runtimeId} exited (code ${code ?? '-'} signal ${signal ?? '-'}, expected=${this.stopped})`)
      // pi explains itself on stderr and that text never travels over the
      // protocol, so a bare exit code left users with nothing to act on
      // ("PI RPC exited (1)" for a pi whose extension failed to load). Keep the
      // full tail in the local log and the most useful line in the error.
      const detail = this.stderrSummary()
      if (!this.stopped && detail) console.log(`[daemon] pi runtime ${this.runtimeId} stderr:\n${this.stderrTail()}`)
      this.fail(new Error(`PI RPC exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`))
      this.emit({ type: 'runtime_exit', code, signal, expected: this.stopped })
      this.callbacks.onExit(this)
    })
  }

  snapshot(): RuntimeInfo {
    const streaming = this.info.isStreaming || this.continuationPending || this.retryPending
    return Object.freeze({ ...this.info, isStreaming: streaming })
  }

  /** Performs the protocol handshake: get_state. */
  async handshake(): Promise<RuntimeInfo> {
    const response = await this.request({ type: 'get_state' }, DEFAULT_REQUEST_TIMEOUT_MS)
    this.updateFromState(response.data)
    return this.snapshot()
  }

  /**
   * Fire-and-forget write for commands PI answers without an RPC envelope.
   * The payload goes out verbatim — extension_ui_response carries the
   * extension request id in `id`, which must not be replaced by a
   * correlation id, or PI cannot match it to the pending request.
   */
  async notify(command: RpcCommand): Promise<void> {
    const line = `${JSON.stringify(command)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_RPC_WRITE_FRAME_BYTES) throw new Error('RPC command exceeded the per-message byte limit')
    await new Promise<void>((resolve, reject) => {
      this.enqueueWrite(line, bytes, WRITE_DEADLINE_MS, reject)
      this.writeQueue = this.writeQueue.catch(() => undefined).then(() => undefined)
      this.writeQueue.then(resolve, reject)
    })
  }

  /** Sends a validated command, returns the response. */
  async command(command: RpcCommand): Promise<RpcResponse> {
    const timeout = DEFAULT_REQUEST_TIMEOUT_MS
    const response = await this.request(command, timeout)
    if (command.type === 'get_state') this.updateFromState(response.data)
    // An accepted abort ends the run; drop the streaming flags right away
    // instead of waiting for the trailing agent_end/agent_settled events.
    if (command.type === 'abort' && response.success === true) {
      this.info.isStreaming = false
      this.info.isCompacting = false
      this.continuationPending = false
      this.retryPending = false
    }
    // Refresh state after session-affecting commands so the renderer sees the
    // new sessionFile/model promptly.
    if (response.success === true && ['new_session', 'switch_session', 'set_model', 'set_thinking_level'].includes(command.type)) {
      void this.request({ type: 'get_state' }, DEFAULT_REQUEST_TIMEOUT_MS)
        .then((state) => this.updateFromState(state.data))
        .catch(() => undefined)
    }
    return response
  }

  /** Gracefully stops the runtime: abort if streaming, close stdin, kill tree. */
  stop(): Promise<boolean> {
    if (!this.stopPromise) this.stopPromise = this.performStop()
    return this.stopPromise
  }

  /** Last captured stderr (bounded), for diagnostics on crash. */
  stderr(): string {
    return this.stderrChunks.join('')
  }

  /**
   * pi's own explanation for an unexpected exit, for the user-facing error.
   * Prefers the LAST line starting with "Error" — that is where pi reports the
   * cause (e.g. `Error: Failed to load extension …`) even when a stack trace or
   * a node banner follows it. Falls back to the last non-empty line.
   */
  private stderrSummary(): string | null {
    const lines = this.stderr()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (!lines.length) return null
    const line = [...lines].reverse().find((l) => /^error\b/i.test(l)) ?? lines[lines.length - 1]!
    return line.length > 300 ? `${line.slice(0, 300)}…` : line
  }

  /** Trailing stderr for the crash log, capped so daemon.log cannot balloon. */
  private stderrTail(max = 2000): string {
    const text = this.stderr().trimEnd()
    return text.length > max ? text.slice(-max) : text
  }

  private async performStop(): Promise<boolean> {
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending) {
      try {
        await this.request({ type: 'abort' }, 5_000)
      } catch {
        /* close stdin and escalate */
      }
    }
    this.stopped = true
    try {
      this.child.stdin?.end()
    } catch {
      /* already closed */
    }
    if (await waitForExit(this.child, 750)) return true
    return killTree(this.child)
  }

  private async request(command: RpcCommand, timeoutMs: number): Promise<RpcResponse> {
    const id = randomUUID()
    const line = `${JSON.stringify({ ...command, id })}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_RPC_WRITE_FRAME_BYTES) throw new Error('RPC command exceeded the per-message byte limit')
    // Queue serialized writes so a slow child stdin never interleaves frames.
    await new Promise<void>((resolve, reject) => {
      this.enqueueWrite(line, bytes, timeoutMs, reject)
      this.writeQueue = this.writeQueue.catch(() => undefined).then(() => undefined)
      // resolve once the write itself settles
      this.writeQueue.then(resolve, reject)
    })
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Distinguish "write flushed but no response" (uncertain delivery)
        // from a pure timeout: the caller must not blindly retry.
        reject(new Error(`RPC command ${command.type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, command: command.type })
    })
  }

  private enqueueWrite(line: string, bytes: number, _timeoutMs: number, onWriteError: (e: Error) => void): void {
    if (this.transportFailed || this.stopped) {
      onWriteError(new Error('Runtime is not available'))
      return
    }
    if (this.queuedWriteBytes + bytes > MAX_QUEUED_WRITE_BYTES) {
      onWriteError(new Error('RPC write queue byte budget exceeded'))
      return
    }
    this.queuedWriteBytes += bytes
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - bytes)
      if (error) onWriteError(error)
    }
    const operation = this.writeQueue.catch(() => undefined).then<void>(
      () =>
        new Promise((resolveWrite) => {
          if (this.transportFailed || this.stopped) {
            finish(new Error('Runtime is not available'))
            resolveWrite()
            return
          }
          const deadline = setTimeout(() => {
            const stall = new Error('PI stopped reading RPC input')
            finish(stall)
            this.failTransport(stall)
            resolveWrite()
          }, WRITE_DEADLINE_MS)
          deadline.unref?.()
          try {
            this.child.stdin?.write(line, (error) => {
              clearTimeout(deadline)
              finish(error)
              resolveWrite()
            })
          } catch (error) {
            clearTimeout(deadline)
            finish(error instanceof Error ? error : new Error(String(error)))
            resolveWrite()
          }
        }),
    )
    this.writeQueue = operation
  }

  private handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.emit({ type: 'transport_error', error: 'PI emitted malformed JSON' })
      return
    }
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).type !== 'string') return
    const value = raw as Record<string, unknown> & { type: string }
    if (value.type === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id)
      if (!pending) {
        // Late answer to a timed-out request; consume silently.
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(value.id)
      if (value.command !== pending.command) {
        pending.reject(new Error(`PI returned a mismatched response for ${pending.command}`))
        this.emit({ type: 'transport_error', error: 'PI returned a mismatched RPC response' })
        return
      }
      const response: RpcResponse = {
        type: 'response',
        id: value.id,
        command: value.command,
        success: value.success === true,
        data: value.data,
        error: typeof value.error === 'string' ? value.error : undefined,
      }
      if (!response.success) {
        pending.reject(new Error(response.error ?? `RPC command ${pending.command} failed`))
        return
      }
      pending.resolve(response)
      return
    }
    // Event
    this.applyEvent(value as PiEvent)
    this.emit(value as PiEvent)
  }

  private applyEvent(value: PiEvent): void {
    switch (value.type) {
      case 'agent_start':
        this.continuationPending = false
        this.retryPending = false
        this.info.isStreaming = true
        this.info.isCompacting = false
        break
      case 'agent_end':
        this.continuationPending = false
        this.info.isStreaming = false
        this.info.isCompacting = false
        break
      case 'agent_settled':
        // The stable idle boundary: any streaming/continuation/retry flags
        // left over around an abort end here, so pooled snapshots taken
        // later never report a phantom running state.
        this.info.isStreaming = false
        this.info.isCompacting = false
        this.continuationPending = false
        this.retryPending = false
        break
      case 'compaction_start':
        this.info.isCompacting = true
        break
      case 'compaction_end':
        this.continuationPending = value.willRetry === true
        this.info.isCompacting = false
        break
      case 'auto_retry_start':
        this.retryPending = true
        break
      case 'auto_retry_end':
        this.retryPending = false
        break
    }
  }

  private updateFromState(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const state = data as Record<string, unknown>
    if (typeof state.sessionId === 'string') this.info.sessionId = state.sessionId
    if (typeof state.sessionFile === 'string') this.info.sessionFile = state.sessionFile
    if (typeof state.isStreaming === 'boolean') this.info.isStreaming = state.isStreaming
    if (typeof state.isCompacting === 'boolean') this.info.isCompacting = state.isCompacting
    if (typeof state.thinkingLevel === 'string') this.info.thinkingLevel = state.thinkingLevel
    if (state.model && typeof state.model === 'object') {
      const model = state.model as Record<string, unknown>
      this.info.model = {
        id: typeof model.id === 'string' ? model.id : undefined,
        name: typeof model.name === 'string' ? model.name : undefined,
        provider: typeof model.provider === 'string' ? model.provider : undefined,
      }
    }
  }

  private emit(event: PiEvent): void {
    this.callbacks.onEvent({ runtimeId: this.runtimeId, event })
  }

  private fail(error: unknown): void {
    // Reject every still-pending request so callers do not hang forever.
    const message = error instanceof Error ? error.message : String(error)
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  private failTransport(error: unknown): void {
    if (this.transportFailed) return
    this.transportFailed = true
    const message = error instanceof Error ? error.message : String(error)
    this.emit({ type: 'transport_error', error: message })
    this.fail(error)
    // Pause stdout so no more frames are decoded after a fatal transport error.
    this.child.stdout?.pause?.()
    this.stopPromise ??= this.performStop()
  }
}

// Re-export the __dirname shim for ESM main (used by session discovery below).
export function mainDirname(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl))
}
