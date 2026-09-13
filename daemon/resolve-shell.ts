// Login shell resolution shared by the LOCAL terminal host (Electron main)
// and the REMOTE one (daemon): $SHELL first, then the common POSIX shells,
// so a machine without zsh (typical Linux) still gets a working pty.
// Kept in its own module — importing either terminal host would drag the
// whole pty layer into the other bundle.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Login shell that exists on THIS machine (a Linux remote may lack zsh). */
export function resolveShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    // ConPTY terminal: PowerShell first (the modern default), cmd.exe as the
    // guaranteed fallback. No login-arg concept on Windows.
    const windir = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const powershell = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(powershell)) return { shell: powershell, args: [] }
    return { shell: process.env.ComSpec ?? join(windir, 'System32', 'cmd.exe'), args: [] }
  }
  const fromEnv = process.env.SHELL?.trim()
  for (const candidate of [fromEnv, '/bin/zsh', '/bin/bash']) {
    if (candidate && existsSync(candidate)) {
      const base = candidate.split('/').pop() ?? ''
      return { shell: candidate, args: base === 'zsh' || base === 'bash' ? ['-l'] : [] }
    }
  }
  return { shell: '/bin/sh', args: [] }
}
