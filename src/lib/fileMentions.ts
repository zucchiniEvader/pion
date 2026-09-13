// @ file mention support for the composer (pi TUI parity: `@` fuzzy-picks a
// project file, the bare path is inserted — no content expansion, pi's tools
// resolve the path themselves). Pure helpers so the purity runner can test
// them without React.

/** The `@token` under the cursor, if any. `@` must start the text or follow
 * whitespace (so `a@b` emails/handles never trigger), and the query runs up
 * to the cursor with no whitespace inside. */
export interface FileMention {
  /** Index of the `@` in the text. */
  start: number
  /** Cursor position (end of the query). */
  end: number
  query: string
}

export function findFileMention(text: string, cursor: number): FileMention | null {
  const before = text.slice(0, cursor)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  return { start: cursor - match[1].length - 1, end: cursor, query: match[1] }
}

/** Case-insensitive substring ranking: basename hits before directory hits,
 * earlier hits before later, shorter paths win ties. */
export function rankFileMentions(files: string[], query: string, limit = 12): string[] {
  const q = query.toLowerCase()
  const scored: Array<{ path: string; score: number }> = []
  for (const path of files) {
    if (!q) {
      scored.push({ path, score: path.length })
      continue
    }
    const lower = path.toLowerCase()
    const at = lower.indexOf(q)
    if (at === -1) continue
    const inBasename = at > lower.lastIndexOf('/')
    scored.push({ path, score: (inBasename ? 0 : 1) * 1e6 + at * 1e3 + path.length })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((s) => s.path)
}

/** Replaces the `@query` token with the picked path plus a trailing space
 * (pi TUI behavior: the `@` is dropped, a bare path is what pi's tools read). */
export function applyFileMention(text: string, mention: FileMention, path: string): { text: string; cursor: number } {
  const next = `${text.slice(0, mention.start)}${path} ${text.slice(mention.end)}`
  return { text: next, cursor: mention.start + path.length + 1 }
}
