// Integrated terminal host (client-local, goal.md: Terminal 与 PI RPC 是独立
// 功能,不混用 stdin/stdout — this never touches the daemon or pi-rpc).
// v1 scope: LOCAL shells only, one pty per project, pure shell (cwd = project
// dir, login shell). Remote-runtime terminals would belong in the daemon
// protocol instead — deliberately out of scope.
//
// pty = node-pty (native; rebuilt for the Electron ABI by postinstall).
// A scrollback buffer (capped) is kept main-side so the renderer can unmount
// on tab switch / panel close and replay on re-attach.
import { ipcMain, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { spawn, type IPty } from 'node-pty'
import { IPC } from '../../src/types'
import type { DaemonConnection } from './daemon-client'

interface TermEntry {
  pty: IPty
  /** Tail of the raw output stream (escape sequences included), for replay. */
  buffer: string
}

const BUFFER_CAP = 200_000
const terminals = new Map<string, TermEntry>() // key: projectPath

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // ELECTRON_RUN_AS_NODE would make Electron-based CLIs launched from this
    // terminal silently run as plain node — never propagate it.
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') out[k] = v
  }
  return out
}

function assertUsableDir(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || !projectPath || projectPath.includes('\0')) {
    throw new TypeError('projectPath must be a non-empty string')
  }
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error('err.project.missingDir')
  }
  return projectPath
}

/** Syntax-only check, BEFORE routing: a remote project's path does not exist
 * on THIS machine, so the existsSync assertUsableDir can only run once the
 * call is known to be local. */
function basicPath(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    throw new TypeError('projectPath must be a non-empty string')
  }
  return rawPath
}

function assertDimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new TypeError(`${name} must be an integer in 1..500`)
  }
  return value
}

export function registerTerminalHandlers(getWindow: () => BrowserWindow | null, remoteFor: (projectPath: string) => DaemonConnection | null): void {
  // Attach = create on first use, then idempotent re-attach (buffer replay).
  // A project owned by a REMOTE runtime proxies to its daemon (daemon-side
  // pty host, same method names); local projects use the host below.
  ipcMain.handle(IPC.TERMINAL_ATTACH, (_e, rawPath: unknown) => {
    const projectPath = basicPath(rawPath)
    const remote = remoteFor(projectPath)
    if (remote) return remote.call('terminal.attach', { projectPath })
    assertUsableDir(projectPath)
    const existing = terminals.get(projectPath)
    if (existing) return { buffer: existing.buffer }
    const shell = process.env.SHELL?.trim() || '/bin/zsh'
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: projectPath,
      env: { ...cleanEnv(), TERM: 'xterm-256color', TERM_PROGRAM: 'Pion' },
    })
    const entry: TermEntry = { pty, buffer: '' }
    terminals.set(projectPath, entry)
    pty.onData((data) => {
      entry.buffer = entry.buffer.length + data.length > BUFFER_CAP ? (entry.buffer + data).slice(-BUFFER_CAP) : entry.buffer + data
      getWindow()?.webContents.send(IPC.TERMINAL_DATA, { projectPath, data })
    })
    pty.onExit(({ exitCode }) => {
      terminals.delete(projectPath)
      getWindow()?.webContents.send(IPC.TERMINAL_EXIT, { projectPath, exitCode })
    })
    return { buffer: '' }
  })

  ipcMain.handle(IPC.TERMINAL_INPUT, (_e, rawPath: unknown, data: unknown) => {
    const projectPath = basicPath(rawPath)
    if (typeof data !== 'string' || data.length > 8192) throw new TypeError('data must be a string (max 8KB)')
    const remote = remoteFor(projectPath)
    if (remote) return remote.call('terminal.input', { projectPath, data })
    assertUsableDir(projectPath)
    terminals.get(projectPath)?.pty.write(data)
  })

  ipcMain.handle(IPC.TERMINAL_RESIZE, (_e, rawPath: unknown, cols: unknown, rows: unknown) => {
    const projectPath = basicPath(rawPath)
    const remote = remoteFor(projectPath)
    if (remote) {
      return remote.call('terminal.resize', { projectPath, cols: assertDimension(cols, 'cols'), rows: assertDimension(rows, 'rows') })
    }
    assertUsableDir(projectPath)
    terminals.get(projectPath)?.pty.resize(assertDimension(cols, 'cols'), assertDimension(rows, 'rows'))
  })

  ipcMain.handle(IPC.TERMINAL_KILL, (_e, rawPath: unknown) => {
    const projectPath = basicPath(rawPath)
    const remote = remoteFor(projectPath)
    if (remote) return remote.call('terminal.kill', { projectPath })
    assertUsableDir(projectPath)
    const entry = terminals.get(projectPath)
    if (entry) {
      entry.pty.kill()
      terminals.delete(projectPath)
    }
  })
}

/** App quit: no pty outlives the host. */
export function killAllTerminals(): void {
  for (const entry of terminals.values()) {
    try {
      entry.pty.kill()
    } catch {
      /* already dead */
    }
  }
  terminals.clear()
}
