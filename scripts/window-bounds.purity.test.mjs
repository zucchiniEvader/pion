// window-bounds purity suite (electron/main/window-bounds.ts bundled for node):
// first-launch centering, restore, and the off-screen / unplugged-monitor cases
// that make the clamp worth having.
import { parseWindowBounds, resolveWindowBounds, rectCenter, DEFAULT_WIDTH, DEFAULT_HEIGHT } from '../node_modules/.tmp/windowBounds.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

// The real built-in display measured on this machine: 1512x982, 33px menu bar.
const builtIn = { x: 0, y: 33, width: 1512, height: 949 }

// 1. First launch: default size, centered inside the work area — NOT at y=33
// (the macOS default this module exists to avoid).
const first = resolveWindowBounds(null, builtIn)
assert(first.width === DEFAULT_WIDTH && first.height === DEFAULT_HEIGHT, `first launch uses defaults (${first.width}x${first.height})`)
assert(first.y === 33 + Math.round((949 - 800) / 2), `first launch centers vertically (y=${first.y}, want 108)`)
assert(first.x === Math.round((1512 - 1200) / 2), `first launch centers horizontally (x=${first.x}, want 156)`)
assert(first.y > builtIn.y, 'first launch does not sit on the work-area top edge')

// 2. Restore: a saved frame that still fits comes back untouched.
const saved = { x: 300, y: 200, width: 1000, height: 700 }
assert(JSON.stringify(resolveWindowBounds(saved, builtIn)) === JSON.stringify(saved), 'a fitting saved frame is restored verbatim')

// 3. Unplugged monitor: saved on a display that no longer exists → the caller
// hands us the nearest work area; the frame must land inside it, not off-screen.
const gone = { x: 2400, y: 300, width: 1100, height: 700 }
const pulled = resolveWindowBounds(gone, builtIn)
assert(pulled.x + pulled.width <= builtIn.x + builtIn.width, `off-screen frame pulled inside (x=${pulled.x})`)
assert(pulled.x >= builtIn.x && pulled.y >= builtIn.y, `off-screen frame not above/left of work area (${pulled.x},${pulled.y})`)

// 4. Saved on a display ABOVE the main one (negative y) is also recovered.
const above = resolveWindowBounds({ x: 100, y: -1400, width: 1200, height: 800 }, builtIn)
assert(above.y >= builtIn.y, `negative-y frame clamped down (y=${above.y})`)

// 5. Too big for the display: size shrinks to the work area.
const shrunk = resolveWindowBounds({ x: 0, y: 0, width: 4000, height: 3000 }, builtIn)
assert(shrunk.width === builtIn.width && shrunk.height === builtIn.height, `oversized frame shrinks to work area (${shrunk.width}x${shrunk.height})`)
assert(shrunk.x === 0 && shrunk.y === 33, `shrunk frame re-anchored to work area origin (${shrunk.x},${shrunk.y})`)

// 6. Work area smaller than the minimum window: no inverted clamp, no NaN.
const tiny = resolveWindowBounds(null, { x: 0, y: 0, width: 640, height: 400 })
assert(tiny.width === 640 && tiny.height === 400, `tiny work area clamps down to it (${tiny.width}x${tiny.height})`)
assert(tiny.x === 0 && tiny.y === 0, `tiny work area stays in bounds (${tiny.x},${tiny.y})`)

// 7. Second display with a non-zero origin (display to the left / above).
const left = { x: -1920, y: 0, width: 1920, height: 1080 }
const onLeft = resolveWindowBounds(null, left)
assert(onLeft.x >= -1920 && onLeft.x + onLeft.width <= 0, `centers on a left-hand display (x=${onLeft.x})`)

// 8. Garbage persisted state is rejected, never partially trusted.
for (const bad of [null, undefined, 'nope', 42, {}, { x: 1, y: 2 }, { x: 1, y: 2, width: 3 }, { x: NaN, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: '100', height: 100 }]) {
  assert(parseWindowBounds(bad) === null, `parseWindowBounds rejects ${JSON.stringify(bad) ?? String(bad)}`)
}
assert(JSON.stringify(parseWindowBounds({ x: 1, y: 2, width: 3, height: 4 })) === '{"x":1,"y":2,"width":3,"height":4}', 'parseWindowBounds accepts a valid rect')

// 9. rectCenter drives the display lookup for a saved frame.
assert(rectCenter({ x: 100, y: 200, width: 400, height: 300 }).x === 300, 'rectCenter x')
assert(rectCenter({ x: 100, y: 200, width: 400, height: 300 }).y === 350, 'rectCenter y')

console.log(failures ? `\n${failures} FAILURES` : '\nall window-bounds checks passed')
process.exit(failures ? 1 : 0)
