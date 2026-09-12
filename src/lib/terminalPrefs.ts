// Terminal display preferences (renderer-local, like the language setting):
// font family + size for the xterm instance. Persisted in localStorage;
// changes broadcast via a window event so a live terminal applies them
// without a remount.

export interface TerminalPrefs {
  fontFamily: string
  fontSize: number
}

const KEY = 'pion.terminal.prefs'
const EVENT = 'pion:terminal-prefs'

export const DEFAULT_TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
export const DEFAULT_TERMINAL_FONT_SIZE = 12

/** Pure parse — accepts anything, always returns a valid prefs object. */
export function parseTerminalPrefs(raw: unknown): TerminalPrefs {
  const fallback = { fontFamily: DEFAULT_TERMINAL_FONT_FAMILY, fontSize: DEFAULT_TERMINAL_FONT_SIZE }
  if (typeof raw !== 'object' || raw === null) return fallback
  const { fontFamily, fontSize } = raw as Partial<TerminalPrefs>
  return {
    fontFamily: typeof fontFamily === 'string' && fontFamily.trim() ? fontFamily.trim().slice(0, 200) : fallback.fontFamily,
    fontSize: typeof fontSize === 'number' && Number.isInteger(fontSize) && fontSize >= 8 && fontSize <= 32 ? fontSize : fallback.fontSize,
  }
}

export function readTerminalPrefs(): TerminalPrefs {
  try {
    return parseTerminalPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return parseTerminalPrefs(null)
  }
}

export function writeTerminalPrefs(prefs: TerminalPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(parseTerminalPrefs(prefs)))
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function onTerminalPrefsChange(cb: (prefs: TerminalPrefs) => void): () => void {
  const handler = () => cb(readTerminalPrefs())
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
