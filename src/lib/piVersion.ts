// pi version floor for the first-run gate. Pure — no imports — so it runs in
// the purity suite (scripts/pi-version.purity.test.mjs).
//
// Why a gate at all: an old pi does not fail loudly, it fails *differently*.
// Sessions die inside the spawn (`PI RPC exited (1)`) and third-party extensions
// that promise a newer API fail to load — which pi treats as fatal, so it exits
// before Pion can talk to it at all. Measured on a real machine: pi 0.74.2 plus
// an extension requiring >= 0.84.0 = every task failed. Telling the user to
// upgrade is far cheaper than that debugging session.

/**
 * The floor is set by the newest pi RPC feature Pion actually relies on:
 * `get_available_thinking_levels` (pi 0.81.0). Close behind: `session_info`
 * (0.80.3), `--name` (0.78.0), and the `ctx.reload` API used by Pion's own
 * bundled extension (0.52.9). Bump this only with the same evidence.
 */
export const MIN_PI_VERSION = '0.81.0'

/** "0.85.1" / "v0.85.1" / "pi 0.85.1" → [0, 85, 1]; null when unparseable. */
export function parsePiVersion(raw: string | null | undefined): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec((raw ?? '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/**
 * True only when pi is *known* to be older than the floor. An unknown or
 * unparseable version is deliberately not "outdated": inferring old age from a
 * failed `pi --version` would lock users out of a working install, while a
 * false negative only costs the nicer error message.
 */
export function isPiOutdated(version: string | null | undefined): boolean {
  const have = parsePiVersion(version)
  const min = parsePiVersion(MIN_PI_VERSION)
  if (!have || !min) return false
  for (let i = 0; i < 3; i++) {
    if (have[i] !== min[i]) return have[i] < min[i]
  }
  return false
}
