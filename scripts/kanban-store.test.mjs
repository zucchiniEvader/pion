// KanbanStore behavior test (daemon/kanban-store.ts bundled for node):
// persistence across instances, watcher convergence of EXTERNAL writes
// (the kanban-bridge / terminal `pi -e` path), broken-line tolerance, and the
// "load never creates .pion" guarantee.
import { mkdtempSync, readFileSync, existsSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KanbanStore, kanbanEventFile } from '../node_modules/.tmp/kanbanStore.bundle.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}
// Watcher convergence is async and machine-load sensitive: poll instead of a
// fixed sleep so a busy CI/host cannot flake the suite.
async function waitFor(cond, label, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - t0 > timeoutMs) {
      failures++
      console.error(`FAIL  ${label}: not converged within ${timeoutMs}ms`)
      return
    }
    await sleep(100)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'kanban-store-'))
const projectA = join(dir, 'proj-a')
const projectB = join(dir, 'proj-b')

// 1. Load on a project without .pion: empty, disabled, and NOTHING created.
{
  const store = new KanbanStore(projectA)
  await store.load()
  assert(store.cards.length === 0 && store.enabled === false, 'fresh project: empty projection, disabled')
  assert(!existsSync(join(projectA, '.pion')), 'load did not create .pion')
}

// 2. Create + mutate; every action appends exactly one event line.
const store = new KanbanStore(projectA)
await store.load()
const card = await store.create({ title: '修复登录超时', body: '## 步骤', acceptance: ['30s 内完成'] })
assert(store.enabled === true && existsSync(kanbanEventFile(projectA)), 'create materialized .pion/kanban/events.jsonl')
assert(card.status === 'todo', 'created card is in todo')
await store.update(card.id, { title: '修复登录超时（改）' })
await store.move(card.id, 'in_progress')
await store.assign(card.id, { sessionFile: '/tmp/none.jsonl', model: 'glm-5.2' })
await store.addNote(card.id, 'user', '进展正常')
const lines = readFileSync(kanbanEventFile(projectA), 'utf8').split('\n').filter(Boolean)
assert(lines.length === 5, `five user actions → five event lines, got ${lines.length}`)
const proj = store.card(card.id)
assert(proj.title === '修复登录超时（改）' && proj.status === 'in_progress' && proj.notes.length === 1, 'projection matches actions')

// 3. Persistence: a NEW instance replays to the identical projection.
{
  const store2 = new KanbanStore(projectA)
  await store2.load()
  const same = JSON.stringify(store2.cards) === JSON.stringify(store.cards)
  assert(same, 'fresh instance replays identical board (restart survival)')
}

// 4. External writer convergence (bridge path): direct file append lands via watcher.
appendFileSync(kanbanEventFile(projectA), JSON.stringify({ v: 1, type: 'note_added', id: card.id, note: { id: 'n_ext', source: 'agent', text: '外部汇报', sessionFile: '/tmp/none.jsonl' }, ts: '2026-08-29T13:30:00.000Z' }) + '\n')
await waitFor(() => store.card(card.id).notes.some((n) => n.id === 'n_ext'), 'external append converged through the watcher')
assert(store.card(card.id).notes.some((n) => n.id === 'n_ext'), 'external append converged through the watcher')
assert(store.card(card.id).notes.length === 2, 'no duplicated notes after convergence')

// 5. Broken + unknown lines are skipped on replay, never fatal.
appendFileSync(kanbanEventFile(projectA), 'this is not json\n')
appendFileSync(kanbanEventFile(projectA), JSON.stringify({ v: 1, type: 'card_from_the_future', id: card.id, ts: 'z' }) + '\n')
{
  const store3 = new KanbanStore(projectA)
  await store3.load()
  assert(store3.cards.length === 1 && store3.card(card.id).notes.length === 2, 'broken/unknown lines skipped, projection intact')
}

// 6. Duplicate create idempotence through the file (two writers racing).
appendFileSync(kanbanEventFile(projectA), JSON.stringify({ v: 1, type: 'card_created', id: card.id, title: '修复登录超时', ts: '2026-08-29T12:00:00.000Z' }) + '\n')
await waitFor(() => JSON.parse(readFileSync(kanbanEventFile(projectA), 'utf8').split('\n').filter(Boolean).slice(-1)[0]).type === 'card_created' && store.cards.length === 1, 'duplicate card_created no-op')
assert(store.cards.length === 1, 'duplicate card_created in log is a no-op')

// 7. Second project stays isolated (bridge only touches cwd's board).
{
  const storeB = new KanbanStore(projectB)
  await storeB.load()
  await storeB.create({ title: 'B 项目的卡' })
  assert(store.cards.length === 1 && storeB.cards.length === 1, 'project boards are isolated')
  assert(storeB.card(storeB.cards[0].id).title === 'B 项目的卡', 'second project card present')
}

store.stop()
rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURES` : '\nall kanban-store checks passed')
process.exit(failures ? 1 : 0)
