// In-app pi bootstrap: runs pi.dev's official installer (docs/onboarding-design.md §3.4).
//
// Why this lives in main and not in the daemon: it is a machine-level,
// client-local action (goal.md §6 keeps those in Electron main), it must work
// when the daemon is unreachable, and — decisively — it is needed exactly when
// pi is missing, which is the one thing the daemon exists to run. Keeping it
// here also leaves the frozen v3 daemon protocol untouched (adding a daemon
// method would mean a version bump).
//
// How it drives a terminal-only installer without a shell:
//   fetch(install.sh) → temp file → spawn('sh', [file])   (args array, shell:false)
// Two details make that work:
//   1. `detached: true` puts the child in its own session, so it has NO
//      controlling terminal and takes the installer's documented
//      non-interactive path: it auto-selects "install" and never edits the
//      user's shell profile (both branches are guarded on /dev/tty in the
//      script). Without it, a dev build launched FROM a terminal would block
//      on a prompt written straight to that tty — invisible to the progress
//      box, i.e. a look-alike hang.
//   2. stdout/stderr are piped, so every line the installer prints reaches the UI.
// The installer itself checks for Node >= 22.19 and falls back to a ~/.local
// npm prefix when the global one is not writable; when Node is missing it exits
// non-zero with a readable message (no tty ⇒ it cannot offer to install Node).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeChildEnvironment } from '../../daemon/pi-rpc'
import type { UpdateProgressEvent } from '../../src/types'

const INSTALL_SCRIPT_URL = 'https://pi.dev/install.sh'
const FETCH_TIMEOUT_MS = 30_000

let installChild: ChildProcess | null = null

/** True while the installer is running. */
export function piInstallRunning(): boolean {
  return installChild !== null
}

/** Kills a running install (app quit). */
export function stopPiInstall(): void {
  if (installChild) {
    installChild.kill('SIGTERM')
    installChild = null
  }
}

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

/**
 * Starts the official installer unless one is already running. Only ever
 * called from an explicit user action (the setup page's install button).
 * Start-time failures return { started: false, error } and are shown by the
 * caller; anything after the spawn arrives as progress events.
 */
export async function runPiInstall(
  progress: (e: UpdateProgressEvent) => void,
): Promise<{ started: boolean; error?: string }> {
  if (installChild) return { started: false, error: 'install already running' }
  let dir: string | null = null
  try {
    const res = await fetch(INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${INSTALL_SCRIPT_URL} → HTTP ${res.status}`)
    const body = await res.text()
    // Cheap sanity check on the download: never hand an error page to `sh`.
    if (!body.startsWith('#!')) throw new Error(`${INSTALL_SCRIPT_URL} did not return a shell script`)
    dir = await mkdtemp(join(tmpdir(), 'pion-pi-install-'))
    const script = join(dir, 'install.sh')
    await writeFile(script, body, { mode: 0o600 })
    const child = spawn('sh', [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeChildEnvironment(),
      shell: false,
      detached: true, // own session → no controlling tty → non-interactive (see header)
      windowsHide: true,
    })
    installChild = child
    progress({ running: true })

    const out = { value: '' }
    const errOut = { value: '' }
    pipeStream(child.stdout, out, progress)
    pipeStream(child.stderr, errOut, progress)

    const cleanup = (): void => {
      if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    child.once('exit', (code) => {
      installChild = null
      // Flush whatever partial lines remain on both streams.
      for (const buffer of [out, errOut]) {
        if (buffer.value.trim()) progress({ running: true, line: buffer.value.trimEnd() })
        buffer.value = ''
      }
      progress({ running: false, done: true, code: code ?? -1 })
      cleanup()
    })
    child.once('error', (err) => {
      if (installChild === child) installChild = null
      progress({ running: false, done: true, code: -1, error: err.message })
      cleanup()
    })
    return { started: true }
  } catch (err) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    return { started: false, error: message }
  }
}
