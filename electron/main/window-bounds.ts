// Window placement math. Pure — no electron import, so it bundles and runs in
// the purity suite (scripts/window-bounds.purity.test.mjs).
//
// Why compute the frame at all: with no x/y, macOS places the window flush
// under the menu bar (measured winY === workArea.y, while x was centered), not
// centered as Electron's docs suggest. Computing it explicitly is also what
// gives restore-across-launches and multi-display clamping for free.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_WIDTH = 1200
export const DEFAULT_HEIGHT = 800
export const MIN_WIDTH = 800
export const MIN_HEIGHT = 500

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** Persisted state is a plain file on disk: accept it only as 4 finite numbers. */
export function parseWindowBounds(raw: unknown): Rect | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { x, y, width, height } = raw as Partial<Rect>
  if ([x, y, width, height].some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null
  return { x: x!, y: y!, width: width!, height: height! }
}

/**
 * The frame to open with: the saved rect where it still fits this workArea,
 * otherwise the default size centered in it. Clamping instead of discarding is
 * what makes an unplugged monitor or a resized display degrade gracefully —
 * the window reappears on the nearest display that still exists.
 */
export function resolveWindowBounds(saved: Rect | null, workArea: Rect): Rect {
  // Math.min guards against an inverted range on a work area smaller than the
  // minimum window (no supported display is, but the clamp must not depend on it).
  const width = clamp(saved?.width ?? DEFAULT_WIDTH, Math.min(MIN_WIDTH, workArea.width), workArea.width)
  const height = clamp(saved?.height ?? DEFAULT_HEIGHT, Math.min(MIN_HEIGHT, workArea.height), workArea.height)
  const centered = {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  }
  return {
    x: clamp(saved?.x ?? centered.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(saved?.y ?? centered.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  }
}

/** Center of a rect — asks Electron which display a saved frame belongs to. */
export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
