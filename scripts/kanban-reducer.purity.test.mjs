// Purity regression suite for the kanban event-log projection
// (src/lib/kanbanReducer.ts). The projection is the single source of board
// state for main's KanbanStore; the same copy-on-write rules as the
// transcript eventReducer apply (React StrictMode double-invokes updaters).
// Inputs are deep-frozen (mutation throws in strict-mode ESM) and every
// assertion compares a double invocation.
import {
  applyKanbanEvent,
  cardToEvents,
  createKanbanCards,
  parseKanbanEventLine,
  replayKanbanEvents,
} from '../node_modules/.tmp/kanbanReducer.bundle.mjs'

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

// Pure double-invoke: same frozen input twice → same output, no throw.
function check(fn, label, ...args) {
  try {
    const r1 = fn(...args)
    const r2 = fn(...args)
    if (!eq(r1, r2)) throw new Error('double-invoke diverged')
    return r1
  } catch (e) {
    failures++
    console.error(`FAIL  ${label}: ${e.message}`)
    return undefined
  }
}

const T = (over = {}) => deepFreeze({ v: 1, ts: '2026-08-29T12:00:00.000Z', ...over })

// ── parseKanbanEventLine ─────────────────────────────────────────────────
console.log('parseKanbanEventLine:')
check(parseKanbanEventLine, 'valid card_created parses', JSON.stringify(T({ type: 'card_created', id: 'k_a1', title: '修复登录超时', body: 'md', acceptance: ['30s 内完成'] })))
check(parseKanbanEventLine, 'valid card_moved parses', JSON.stringify(T({ type: 'card_moved', id: 'k_a1', to: 'review', by: 'agent' })))
check(parseKanbanEventLine, 'valid note_added parses', JSON.stringify(T({ type: 'note_added', id: 'k_a1', note: { id: 'n_1', source: 'agent', text: 'done', sessionFile: '/s.jsonl' } })))
assert(parseKanbanEventLine('not json') === null, 'broken JSON → null')
assert(parseKanbanEventLine('') === null, 'empty line → null')
assert(parseKanbanEventLine(JSON.stringify({ v: 2, type: 'card_created', id: 'k_x', title: 't', ts: 'z' })) === null, 'wrong schema version → null')
assert(parseKanbanEventLine(JSON.stringify({ v: 1, type: 'card_aliens', id: 'k_x', ts: 'z' })) === null, 'unknown type → null')
assert(parseKanbanEventLine(JSON.stringify({ v: 1, type: 'card_created', title: 'no id', ts: 'z' })) === null, 'missing id → null')
assert(parseKanbanEventLine(JSON.stringify({ v: 1, type: 'card_moved', id: 'k_x', to: 'heaven', by: 'user', ts: 'z' })) === null, 'invalid status → null')
assert(parseKanbanEventLine(JSON.stringify({ v: 1, type: 'card_moved', id: 'k_x', to: 'todo', by: 'robot', ts: 'z' })) === null, 'invalid actor → null')
assert(parseKanbanEventLine(JSON.stringify({ v: 1, type: 'note_added', id: 'k_x', note: { source: 'agent' }, ts: 'z' })) === null, 'note without id/text → null')

// ── applyKanbanEvent fold ────────────────────────────────────────────────
console.log('applyKanbanEvent:')
const create = T({ type: 'card_created', id: 'k_a1', title: '修复登录超时', body: '## 步骤', acceptance: ['30s 内完成'] })
let base = createKanbanCards()
const afterCreate = check(applyKanbanEvent, 'create folds', base, create)
assert(afterCreate?.length === 1, 'create appends one card')
const card = afterCreate?.[0]
assert(card && card.status === 'todo', 'new card lands in todo')
assert(card && card.runState === 'idle' && card.archived === false && card.notes.length === 0, 'new card defaults idle/unarchived/no notes')
assert(card && card.createdAt === card.updatedAt && card.createdAt === create.ts, 'timestamps from event ts')
assert(eq(applyKanbanEvent(afterCreate, create), afterCreate), 'duplicate create is a no-op (idempotent replay)')

const update = T({ type: 'card_updated', id: 'k_a1', title: '修复登录超时（改）', ts: '2026-08-29T13:00:00.000Z' })
const afterUpdate = check(applyKanbanEvent, 'update folds', afterCreate, update)
assert(afterUpdate?.[0].title === '修复登录超时（改）', 'update patches title')
assert(afterUpdate?.[0].createdAt === create.ts, 'update keeps createdAt')
assert(afterUpdate?.[0].updatedAt === update.ts, 'update bumps updatedAt')

const move = T({ type: 'card_moved', id: 'k_a1', to: 'in_progress', by: 'user' })
assert(check(applyKanbanEvent, 'move folds', afterUpdate, move)?.[0].status === 'in_progress', 'move changes status')

const assign = T({ type: 'card_assigned', id: 'k_a1', sessionFile: '/s/one.jsonl', model: 'glm-5.2' })
const afterAssign = check(applyKanbanEvent, 'assign folds', afterUpdate, assign)
assert(afterAssign?.[0].assignee?.sessionFile === '/s/one.jsonl' && afterAssign?.[0].assignee?.model === 'glm-5.2' && afterAssign?.[0].assignee?.label === undefined, 'assign sets only provided fields')

const note = T({ type: 'note_added', id: 'k_a1', note: { id: 'n_1', source: 'agent', text: '完成第一步', sessionFile: '/s/one.jsonl' } })
const afterNote = check(applyKanbanEvent, 'note folds', afterAssign, note)
assert(afterNote?.[0].notes.length === 1 && afterNote?.[0].notes[0].text === '完成第一步', 'note appended')

const archive = T({ type: 'card_archived', id: 'k_a1' })
assert(check(applyKanbanEvent, 'archive folds', afterNote, archive)?.[0].archived === true, 'archive flags the card')

assert(eq(check(applyKanbanEvent, 'unknown-card events ignored', base, note), base), 'events for unknown card are skipped')
assert(eq(check(applyKanbanEvent, 'unknown event type ignored', base, { v: 1, type: 'card_beamed', id: 'k_a1', ts: 'z' }), base), 'unknown event type skipped')

// ── copy-on-write purity ─────────────────────────────────────────────────
console.log('copy-on-write:')
const two = replayKanbanEvents([
  T({ type: 'card_created', id: 'k_1', title: 'A' }),
  T({ type: 'card_created', id: 'k_2', title: 'B' }),
])
const frozen = deepFreeze(two)
const moved = applyKanbanEvent(frozen, T({ type: 'card_moved', id: 'k_2', to: 'done', by: 'user' }))
assert(moved[0] === frozen[0], 'untouched card keeps reference identity')
assert(moved[1] !== frozen[1], 'moved card is a fresh object')
assert(eq(applyKanbanEvent(frozen, T({ type: 'card_moved', id: 'k_2', to: 'done', by: 'user' })), moved), 'double invocation is stable')
assert(frozen[1].status === 'todo', 'frozen input was not mutated')

// ── replay = incremental fold (restart equivalence) ──────────────────────
console.log('replay:')
const log = [
  T({ type: 'card_created', id: 'k_1', title: 'A' }),
  T({ type: 'card_created', id: 'k_2', title: 'B' }),
  T({ type: 'card_moved', id: 'k_1', to: 'in_progress', by: 'user' }),
  T({ type: 'card_assigned', id: 'k_1', sessionFile: '/s/one.jsonl' }),
  T({ type: 'note_added', id: 'k_1', note: { id: 'n_1', source: 'agent', text: '进行中', sessionFile: '/s/one.jsonl' } }),
  T({ type: 'card_moved', id: 'k_1', to: 'review', by: 'agent' }),
  T({ type: 'card_archived', id: 'k_2' }),
]
const replayed = check(replayKanbanEvents, 'full replay', deepFreeze(log))
let incremental = createKanbanCards()
for (const ev of log) incremental = applyKanbanEvent(incremental, ev)
assert(eq(replayed, incremental), 'replay equals incremental fold')
assert(replayed?.[0].status === 'review' && replayed?.[0].notes.length === 1, 'final state correct after agent report')
assert(replayed?.[1].archived === true, 'archived card retained for audit')

// ── cardToEvents: cross-store migration round-trip ───────────────────────
console.log('cardToEvents:')
const migrated = deepFreeze({
  id: 'k_m1',
  title: '迁移卡',
  body: '正文',
  acceptance: ['A1'],
  status: 'review',
  assignee: { sessionFile: '/s/x.jsonl', model: 'glm-5.2' },
  runState: 'idle',
  notes: [
    { id: 'n_1', source: 'agent', text: '进行中', at: '2026-08-30T08:30:00.000Z', sessionFile: '/s/x.jsonl' },
    { id: 'n_2', source: 'system', text: '兜底', at: '2026-08-30T08:35:00.000Z' },
  ],
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T09:00:00.000Z',
})
const reborn = replayKanbanEvents(check(cardToEvents, 'migration events', migrated, '2026-08-30T10:00:00.000Z'))[0]
// Compare semantically (fixed key projection) — key ORDER differs after the
// fold and JSON.stringify is order-sensitive.
const pick = (c) => ({ id: c.id, title: c.title, body: c.body, acceptance: c.acceptance, status: c.status, assignee: c.assignee, notes: c.notes, createdAt: c.createdAt, archived: !!c.archived })
assert(reborn && eq(pick(reborn), pick(migrated)), 'replayed migrated card equals the original')
assert(reborn && reborn.notes.map((n) => n.id).join() === 'n_1,n_2', 'note order preserved across migration')
const plain = deepFreeze({ id: 'k_m2', title: '裸卡', status: 'todo', runState: 'idle', notes: [], createdAt: '2026-08-30T08:00:00.000Z', updatedAt: '2026-08-30T08:00:00.000Z' })
const plainEvents = cardToEvents(plain, 'ts')
assert(plainEvents.length === 1 && plainEvents[0].type === 'card_created', 'minimal card yields a single create event')

console.log(failures ? `\n${failures} FAILURES` : '\nall kanban-reducer purity checks passed')
process.exit(failures ? 1 : 0)
