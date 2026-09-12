// Daemon-side integrated terminal host: one login-shell pty per project
// (cwd = project dir), scrollback tail for replay, output/exit broadcast.
// Used by REMOTE runtimes — the LOCAL terminal is hosted client-side in
// Electron main (same channel names, so main's proxy is a pure forward).
// Independent of pi-rpc by design (goal.md terminal rule).
//
// node-pty is native and the daemon ships as a single-file bundle, so it is
// loaded LAZILY: a daemon without node-pty installed nearby stays fully
// alive and its terminal methods fail with err.terminal.unavailable.
import { existsSync } from 'node:fs'
import type { TerminalAttachResult } from '../src/types'
import type { DaemonServer } from './server'
import { assertProjectDirectory } from './git'

interface TermEntry {
  pty: {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
  }
  buffer: string
}

const BUFFER_CAP = 200_000
const terminals = new Map<string, TermEntry>() // key: projectPath

type PtyModule = typeof import('node-pty')
let ptyModule: Promise<PtyModule | null> | null = null

function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty').catch(() => null)
  return ptyModule
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') out[k] = v
  }
  return out
}

/** Login shell that exists on THIS machine (a Linux remote may lack zsh). */
function resolveShell(): { shell: string; args: string[] } {
  const fromEnv = process.env.SHELL?.trim()
  for (const candidate of [fromEnv, '/bin/zsh', '/bin/bash']) {
    if (candidate && existsSync(candidate)) {
      const base = candidate.split('/').pop() ?? ''
      return { shell: candidate, args: base === 'zsh' || base === 'bash' ? ['-l'] : [] }
    }
  }
  return { shell: '/bin/sh', args: [] }
}

function assertDimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error(`${name} must be an integer in 1..500`)
  }
  return value
}

export function registerTerminalMethods(server: DaemonServer): void {
  server.register('terminal.attach', async (params): Promise<TerminalAttachResult> => {
    const { projectPath } = params as { projectPath: string }
    await assertProjectDirectory(projectPath)
    const existing = terminals.get(projectPath)
    if (existing) return { buffer: existing.buffer }
    const pty = await loadPty()
    if (!pty) throw new Error('err.terminal.unavailable')
    const { shell, args } = resolveShell()
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: projectPath,
      env: { ...cleanEnv(), TERM: 'xterm-256color', TERM_PROGRAM: 'Pion' },
    })
    const entry: TermEntry = { pty: proc, buffer: '' }
    terminals.set(projectPath, entry)
    proc.onData((data) => {
      entry.buffer = entry.buffer.length + data.length > BUFFER_CAP ? (entry.buffer + data).slice(-BUFFER_CAP) : entry.buffer + data
      server.broadcast('terminal.data', { projectPath, data })
    })
    proc.onExit(({ exitCode }) => {
      terminals.delete(projectPath)
      server.broadcast('terminal.exit', { projectPath, exitCode })
    })
    return { buffer: '' }
  })

  server.register('terminal.input', async (params) => {
    const { projectPath, data } = params as { projectPath: string; data: string }
    if (typeof data !== 'string' || data.length > 8192) throw new Error('data must be a string (max 8KB)')
    terminals.get(projectPath)?.pty.write(data)
    return null
  })

  server.register('terminal.resize', async (params) => {
    const { projectPath, cols, rows } = params as { projectPath: string; cols: number; rows: number }
    terminals.get(projectPath)?.pty.resize(assertDimension(cols, 'cols'), assertDimension(rows, 'rows'))
    return null
  })

  server.register('terminal.kill', async (params) => {
    const { projectPath } = params as { projectPath: string }
    const entry = terminals.get(projectPath)
    if (entry) {
      entry.pty.kill()
      terminals.delete(projectPath)
    }
    return null
  })
}

/** Daemon shutdown ladder: no pty outlives the host (called from boot). */
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
