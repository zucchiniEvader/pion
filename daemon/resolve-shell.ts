// Login shell resolution shared by the LOCAL terminal host (Electron main)
// and the REMOTE one (daemon): $SHELL first, then the common POSIX shells,
// so a machine without zsh (typical Linux) still gets a working pty.
// Kept in its own module — importing either terminal host would drag the
// whole pty layer into the other bundle.
import { existsSync } from 'node:fs'

/** Login shell that exists on THIS machine (a Linux remote may lack zsh). */
export function resolveShell(): { shell: string; args: string[] } {
  const fromEnv = process.env.SHELL?.trim()
  for (const candidate of [fromEnv, '/bin/zsh', '/bin/bash']) {
    if (candidate && existsSync(candidate)) {
      const base = candidate.split('/').pop() ?? ''
      return { shell: candidate, args: base === 'zsh' || base === 'bash' ? ['-l'] : [] }
    }
  }
  return { shell: '/bin/sh', args: [] }
}
