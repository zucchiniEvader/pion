// Purity regression suite for the draft/prewarm decision layer
// (src/lib/draftDecision.ts). This state machine produced three shipped bugs
// (goal.md §2.3): the eviction storm, the stale-prewarm consumption that sent
// messages into dead runtimes, and the commit-window race that yanked the
// page back to the draft surface. Every branch below encodes one of those
// decisions so a regression here fails loudly instead of in production.
//
// Purity is checked two ways: inputs are deep-frozen (any mutation throws in
// strict-mode ESM), and every call is made twice with results compared —
// mirroring React StrictMode's double-invoked updaters.
import {
  isInertDraft,
  isHomeSurfaceUp,
  judgePrewarm,
  shouldStartPrewarm,
  resolveViewedSessionFile,
} from '../node_modules/.tmp/draftDecision.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const deepFreeze = (v) => {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(v[k])
    Object.freeze(v)
  }
  return v
}

// Blank prewarm draft: live runtime, empty transcript, started without a
// session file, never dispatched.
const blank = (over = {}) =>
  deepFreeze({
    runtime: { runtimeId: 'rt-1', cwd: '/proj/a' },
    transcript: [],
    lastStart: { projectPath: '/proj/a' },
    lastDispatchAt: null,
    ...over,
  })

// Every assertion below runs against frozen inputs, twice.
function pure2(fn, ...args) {
  const r1 = fn(...args)
  const r2 = fn(...args)
  if (!eq(r1, r2)) throw new Error(`double-invoke diverged: ${JSON.stringify(r1)} vs ${JSON.stringify(r2)}`)
  return r1
}

function check(fn, expected, label, ...args) {
  try {
    assert(eq(pure2(fn, ...args), expected), label)
  } catch (e) {
    failures++
    console.error(`FAIL  ${label}: ${e.message}`)
  }
}

// ── isInertDraft ─────────────────────────────────────────────────────────
console.log('isInertDraft:')
check(isInertDraft, false, 'null state is not a draft', null)
check(isInertDraft, false, 'undefined state is not a draft', undefined)
check(isInertDraft, true, 'blank prewarm is a draft', blank())
check(isInertDraft, false, 'dead runtime is not a draft', blank({ runtime: null }))
check(isInertDraft, false, 'transcript content disqualifies', blank({ transcript: [{ id: 'm1' }] }))
check(isInertDraft, false, 'any dispatch disqualifies (/plan streams no events)', blank({ lastDispatchAt: 123 }))
check(isInertDraft, false, 'bound to a session file disqualifies', blank({ lastStart: { projectPath: '/proj/a', sessionPath: '/proj/a/s.jsonl' } }))
check(isInertDraft, true, 'cwd match with projectPath', blank(), '/proj/a')
check(isInertDraft, false, 'cwd mismatch with projectPath', blank(), '/proj/b')
check(isInertDraft, true, 'without projectPath cwd is not checked', blank({ runtime: { runtimeId: 'rt-1', cwd: '/other' } }))

// ── isHomeSurfaceUp ──────────────────────────────────────────────────────
console.log('isHomeSurfaceUp:')
check(isHomeSurfaceUp, true, 'no session at all → hero up', null, false)
check(isHomeSurfaceUp, true, 'landing (no runtime, not exited) → hero up', blank({ runtime: null }), false)
check(isHomeSurfaceUp, false, 'exited conversation stays on screen', blank({ runtime: null, exited: true }), false)
check(isHomeSurfaceUp, true, 'exited + composingNew → hero up', blank({ runtime: null, exited: true }), true)
check(isHomeSurfaceUp, true, 'active blank prewarm keeps hero up', blank(), false)
check(isHomeSurfaceUp, false, 'dispatched runtime yields to the transcript', blank({ lastDispatchAt: 5 }), false)
check(isHomeSurfaceUp, false, 'populated transcript yields', blank({ transcript: [{ id: 'm1' }] }), false)
check(isHomeSurfaceUp, true, 'composingNew wins over any session', blank({ transcript: [{ id: 'm1' }] }), true)

// ── judgePrewarm ─────────────────────────────────────────────────────────
console.log('judgePrewarm:')
const infoA = { runtimeId: 'rt-1', cwd: '/proj/a' }
const infoB = { runtimeId: 'rt-2', cwd: '/proj/b' }
check(judgePrewarm, { ok: false, reason: 'no-runtime-info' }, 'start failure → no-runtime-info', null, blank(), '/proj/a')
check(judgePrewarm, { ok: true, runtimeId: 'rt-1' }, 'healthy prewarm is consumable', infoA, blank(), '/proj/a')
check(judgePrewarm, { ok: false, reason: 'project-mismatch' }, 'prewarm for another project is refused', infoB, blank(), '/proj/a')
check(judgePrewarm, { ok: false, reason: 'not-a-blank-draft' }, 'unknown pool state is refused', infoA, undefined, '/proj/a')
check(judgePrewarm, { ok: false, reason: 'not-a-blank-draft' }, 'evicted runtime (state.runtime gone) is refused', infoA, blank({ runtime: null }), '/proj/a')
check(judgePrewarm, { ok: false, reason: 'not-a-blank-draft' }, 'already dispatched is refused', infoA, blank({ lastDispatchAt: 9 }), '/proj/a')
check(judgePrewarm, { ok: false, reason: 'not-a-blank-draft' }, 'hydrated transcript is refused', infoA, blank({ transcript: [{ id: 'm1' }] }), '/proj/a')
// Regression: main's bind fast path reuses the prewarm process for a history
// session via switch_session, which sets lastStart.sessionPath on the pool
// state. A stale prewarmRef pointing at that runtime must fall through to a
// fresh start — never send a draft message into a bound conversation.
check(judgePrewarm, { ok: false, reason: 'not-a-blank-draft' }, 'rebound to a history session is refused', infoA, blank({ lastStart: { projectPath: '/proj/a', sessionPath: '/proj/a/s.jsonl' } }), '/proj/a')

// ── shouldStartPrewarm ───────────────────────────────────────────────────
console.log('shouldStartPrewarm:')
const clear = {
  startingMessageActive: false,
  hydrating: false,
  startInFlight: false,
  prewarmInFlight: false,
  homeSurfaceUp: true,
  warmDraftAlready: false,
}
for (const key of Object.keys(clear)) {
  check(shouldStartPrewarm, false, `guard blocks: ${key}`, { ...clear, [key]: key === 'homeSurfaceUp' ? false : true })
}
check(shouldStartPrewarm, true, 'all guards clear → prewarm', clear)

// ── resolveViewedSessionFile ─────────────────────────────────────────────
console.log('resolveViewedSessionFile:')
const live = { runtime: { sessionFile: '/proj/a/live.jsonl' }, lastStart: { sessionPath: '/proj/a/live.jsonl' }, lastSessionFile: '/proj/a/live.jsonl' }
check(resolveViewedSessionFile, null, 'draft owns nothing, even with a live runtime', true, live, null)
check(resolveViewedSessionFile, '/proj/a/live.jsonl', 'live session file wins', false, live, '/proj/a/pending.jsonl')
check(resolveViewedSessionFile, '/proj/a/started.jsonl', 'lastStart cascades when runtime detached', false, { runtime: null, lastStart: { sessionPath: '/proj/a/started.jsonl' }, lastSessionFile: '/proj/a/older.jsonl' }, null)
check(resolveViewedSessionFile, '/proj/a/older.jsonl', 'lastSessionFile survives runtime loss', false, { runtime: null, lastStart: null, lastSessionFile: '/proj/a/older.jsonl' }, null)
check(resolveViewedSessionFile, '/proj/a/pending.jsonl', 'in-flight session start is attributed', false, null, '/proj/a/pending.jsonl')
check(resolveViewedSessionFile, null, 'nothing known → null', false, null, null)

console.log(failures ? `\n${failures} FAILURES` : '\nall draft-decision purity checks passed')
process.exit(failures ? 1 : 0)
