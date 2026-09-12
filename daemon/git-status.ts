// git status parsing (pure): `git status --porcelain=v1 -z` output → file
// list. The -z format NUL-terminates entries and never quotes paths; rename
// and copy entries carry the ORIGINAL path in an extra chunk right after
// (the "reversed" order: XY <new>\0<old>\0). No imports beyond the shared
// type so the purity suite can bundle this file standalone.

import type { GitChangedFile } from '../src/types'

export function parsePorcelainZ(raw: string): GitChangedFile[] {
  const chunks = raw.split('\0')
  const out: GitChangedFile[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    if (!chunk) continue
    const x = chunk[0]!
    const y = chunk[1]!
    // Ignored entries ('!!') are noise for the changes panel — skip them;
    // they consume no extra chunk.
    if (x === '!' && y === '!') continue
    const path = chunk.slice(3)
    if (!path) continue
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') i++ // consume the orig-path chunk
    out.push({ path, x, y })
  }
  return out
}
