// Purity regression check for applyEvent: React StrictMode double-invokes
// useState updaters with the SAME base state. Each invocation runs
// [...prev] + applyEvent(next, ev) exactly like the hook does. If any arm
// mutates objects shared with the previous state, the two invocations
// disagree and streamed deltas double — the exact bug reported with
// "你好你好！！我是 PI我是 PI…" pairs.
import { applyEvent, createTranscript, needsHistoryHydration } from '../node_modules/.tmp/eventReducer.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}
const snap = (m) => JSON.stringify(m)

// React-like updater: shallow copy only, applyEvent must not touch shared rows.
const runOnce = (base, ev) => {
  const next = base.slice()
  applyEvent(next, ev)
  return next
}

function step(base, ev, label) {
  // Snapshot IMMEDIATELY after each invocation: under aliasing bugs the
  // result keeps mutating after return, so deferring the comparison would
  // hide the divergence (both snapshots would read the same poisoned data).
  const raw1 = runOnce(base, ev)
  const s1 = snap(raw1)
  const s2 = snap(runOnce(base, ev))
  if (s1 !== s2) {
    failures++
    console.error(`FAIL  ${label}: updater is impure — double invocation diverges`)
    return JSON.parse(s2) // detach aliases; keep going
  }
  console.log(`  ok  ${label}: double-invoke stable`)
  return JSON.parse(s2)
}

const events = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm ' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'ok' } },
  { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 't1', name: 'read', args: { path: 'goal.md' } } } },
  { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'goal.md' } },
  { type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', partialResult: 'partial…' },
  { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'full file body' },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
  { type: 'message_end' },
  { type: 'agent_end' },
]

console.log('streaming turn, one event at a time:')
let messages = createTranscript()
for (const [i, ev] of events.entries()) {
  messages = step(messages, ev, `#${i} ${ev.type}`)
}

const asst = messages.filter((m) => m.role === 'assistant')
assert(messages.filter((m) => m.role === 'user').length === 1, 'exactly one user row')
assert(asst.length === 1, 'exactly one assistant row')
const text = asst[0].parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
assert(text === '你好done', `assistant text is "你好done", got ${JSON.stringify(text)}`)
const thinking = asst[0].parts.find((p) => p.type === 'thinking')
assert(thinking && thinking.text === 'hmm ok', `thinking merged once, got ${thinking && JSON.stringify(thinking.text)}`)
const tool = asst[0].parts.find((p) => p.type === 'toolCall')
assert(tool && tool.status === 'done' && !tool.isError && tool.resultText === 'full file body', 'tool part finalized once')
assert(asst[0].streaming === false, 'assistant row finalized')

// Double-check with a batched flush (React may commit several events between renders):
console.log('whole-turn replay in one batch:')
const replay = createTranscript()
for (const ev of events) {
  const r1 = runOnce(replay, ev); const s1 = snap(r1)
  const s2 = snap(runOnce(replay, ev))
  assert(s1 === s2, `batch stability ${ev.type}`)
  replay.length = 0
  replay.push(...JSON.parse(s2))
}
console.log('needsHistoryHydration:')
const sPath = '/sessions/x.jsonl'
assert(needsHistoryHydration(undefined, sPath) === true, 'no entry → hydrate')
assert(needsHistoryHydration({ transcript: { length: 0 }, lastStart: null }, undefined) === false, 'no sessionPath → never')
assert(
  needsHistoryHydration({ transcript: { length: 0 }, lastStart: null }, sPath) === true,
  'empty entry without renderer start → hydrate',
)
assert(
  needsHistoryHydration({ transcript: { length: 4 }, lastStart: null, lastSessionFile: null }, sPath) === true,
  'background tail-only entry (kanban comment forward) → hydrate/replace',
)
assert(
  needsHistoryHydration({ transcript: { length: 4 }, lastStart: { projectPath: '/p' }, lastSessionFile: sPath }, sPath) === false,
  'renderer-owned live transcript → keep memory',
)
assert(
  needsHistoryHydration({ transcript: { length: 0 }, lastStart: { projectPath: '/p' } }, sPath) === false,
  'renderer-owned empty transcript → keep memory',
)

console.log(failures ? `\n${failures} FAILURES` : '\nall purity checks passed')
process.exit(failures ? 1 : 0)
