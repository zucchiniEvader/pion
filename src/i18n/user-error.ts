/** Strip Electron IPC wrappers without interpreting arbitrary error text. */
export function parseUserError(error: unknown): { raw: string; code: string; payload?: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replace(/^Error (?:invoking remote method|occurred in handler for) '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
  const sep = message.indexOf(':')
  return {
    raw,
    code: sep === -1 ? message : message.slice(0, sep),
    payload: sep === -1 ? undefined : message.slice(sep + 1),
  }
}
