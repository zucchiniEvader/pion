// Event reducer: builds a transcript from the PI event stream.
import type { PiEvent } from '@/types'

// A loose event record: known discriminants are handled explicitly; unknown
// types fall through to the default arm. Keeping it an index signature lets us
// narrow on `type` while reading the rest as `unknown`.
type EventRecord = { type: string; [key: string]: unknown }

/** Structural subset of pooled session state for the hydration decision. */
export interface HydrationSnapshot {
  transcript: { length: number }
  /** Set only when the renderer itself started/re-attached the runtime. */
  lastStart: unknown
  lastSessionFile?: string | null
}

/**
 * Whether opening `sessionPath` must load the transcript from the session
 * JSONL. Two cases: the entry was never hydrated, or it is background-only —
 * the pool materialized it from bare agent events for a runtime it never
 * started (kanban review-comment forward, background dispatch), so its
 * transcript holds only the streamed TAIL while the history prefix exists
 * solely on disk. PI session JSONL is the source of truth: replace the tail.
 */
export function needsHistoryHydration(
  existing: HydrationSnapshot | null | undefined,
  sessionPath: string | null | undefined,
): boolean {
  if (!sessionPath) return false
  if (!existing) return true
  return existing.lastStart == null && existing.lastSessionFile == null
}

export interface ToolCallPart {
  type: 'toolCall'
  id: string
  name: string
  args?: unknown
  status: 'streaming' | 'running' | 'done' | 'error'
  resultText?: string
  isError?: boolean
  /** Tool-defined result extras (e.g. rpiv-todo's full task snapshot). */
  details?: unknown
}

export interface TextPart {
  type: 'text'
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
  /** Wall-clock ms stamps; injected by the caller so updaters stay pure. */
  startedAt?: number
  finishedAt?: number
}

export interface ErrorPart {
  type: 'error'
  text: string
}

/** Transient lifecycle state (retrying, compacting) shown as a system row. */
export interface StatusPart {
  type: 'status'
  text: string
}

/** User-attached image (base64 payload, no data: URL prefix). */
export interface ImagePart {
  type: 'image'
  data: string
  mimeType: string
}

export type MessagePart = TextPart | ThinkingPart | ToolCallPart | ErrorPart | StatusPart | ImagePart

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  streaming?: boolean
  startedAt?: number
}

const EMPTY_TURN_FALLBACK = '(No text response.)'

function toolFallbackId(id: string | undefined, name: string): string {
  return id ?? `tool:${name}`
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.text === 'string') return r.text
    const content = r.content
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (c && typeof c === 'object') return String((c as Record<string, unknown>).text ?? '')
          return String(c)
        })
        .join('')
    }
    try {
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }
  return String(result ?? '')
}

/** Tool-defined result extras (`{content, details}` envelope → `details`). */
function resultDetails(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if ('details' in r) return r.details
  }
  return undefined
}

export function createTranscript(): TranscriptMessage[] {
  return []
}

function appendAssistant(messages: TranscriptMessage[]): number {
  const id = `msg-${messages.length}-${Date.now()}`
  messages.push({ id, role: 'assistant', parts: [], streaming: true })
  return messages.length - 1
}

function lastAssistantIndex(messages: TranscriptMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i
  }
  return -1
}

function ensureAssistant(messages: TranscriptMessage[]): number {
  const idx = lastAssistantIndex(messages)
  if (idx >= 0 && messages[idx].streaming) return idx
  return appendAssistant(messages)
}

function appendUserMessage(messages: TranscriptMessage[], text: string, images: ImagePart[] = []): void {
  messages.push({
    id: `user-${messages.length}-${Date.now()}`,
    role: 'user',
    parts: [...(text ? [{ type: 'text' as const, text }] : []), ...images],
  })
}

// One rolling system row per lifecycle kind (retry / compaction): start sets
// the in-progress text, end overwrites it with the outcome. Deterministic ids
// keep React keys stable; the row object is always replaced, never mutated.
function upsertSystemStatus(messages: TranscriptMessage[], id: string, text: string): void {
  const row: TranscriptMessage = { id, role: 'system', parts: [{ type: 'status', text }] }
  const idx = messages.findIndex((m) => m.id === id)
  if (idx >= 0) messages[idx] = row
  else messages.push(row)
}

// ── Copy-on-write helpers ────────────────────────────────────────────────
// State updaters call applyEvent inside React useState functions, which
// StrictMode invokes more than once. Every arm therefore clones the row and
// part it changes instead of mutating objects shared with the previous state;
// otherwise a second invocation would accumulate deltas (doubled text).

function editRow(messages: TranscriptMessage[], idx: number): TranscriptMessage {
  const row = messages[idx]
  const clone: TranscriptMessage = { ...row, parts: [...row.parts] }
  messages[idx] = clone
  return clone
}

function findPart(row: TranscriptMessage, predicate: (p: MessagePart) => boolean): MessagePart | undefined {
  return row.parts.find(predicate)
}

// Close any thinking part that is still open (no finishedAt) once another
// content block or the message boundary arrives, so the UI can show how long
// the model spent thinking. `now` comes from the event context; when absent
// (old callers/tests) parts keep their open state untouched.
function closeOpenParts(parts: MessagePart[], now?: number): MessagePart[] {
  if (!now) return parts
  let changed = false
  const next = parts.map((p) => {
    if (p.type === 'thinking' && p.startedAt && !p.finishedAt) {
      changed = true
      return { ...p, finishedAt: now }
    }
    return p
  })
  return changed ? next : parts
}

export interface EventContext {
  now?: number
}

export function applyEvent(messages: TranscriptMessage[], raw: EventRecord, ctx?: EventContext): TranscriptMessage[] {
  const now = ctx?.now
  switch (raw.type) {
    case 'message_start': {
      const message = raw.message as { role?: string; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined
      const role = message?.role
      if (role === 'user') {
        const text = message?.content?.find((c) => c.type === 'text')?.text
        const images = (message?.content ?? [])
          .filter((c) => c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string')
          .map((c) => ({ type: 'image' as const, data: c.data as string, mimeType: c.mimeType as string }))
        if (text || images.length) appendUserMessage(messages, text ?? '', images)
      } else if (role === 'assistant') {
        // assistant message starting; ensure a streaming assistant row.
        ensureAssistant(messages)
      }
      // toolResult / system / unknown roles do not open a new row here;
      // their content flows through tool_execution_* events.
      return messages
    }
    case 'message_update': {
      const delta = raw.assistantMessageEvent as { type?: string; delta?: string; toolCall?: { type?: string; id?: string; name?: string; arguments?: unknown; args?: unknown } } | undefined
      if (!delta) return messages
      const idx = ensureAssistant(messages)
      const dt = delta.type
      if (dt === 'text_delta' && delta.delta) {
        const msg = editRow(messages, idx)
        msg.parts = closeOpenParts(msg.parts, now)
        const last = msg.parts[msg.parts.length - 1]
        if (last && last.type === 'text') {
          msg.parts[msg.parts.length - 1] = { ...last, text: last.text + delta.delta }
        } else {
          msg.parts.push({ type: 'text', text: delta.delta })
        }
      } else if (dt === 'thinking_delta' && delta.delta) {
        const msg = editRow(messages, idx)
        const last = msg.parts[msg.parts.length - 1]
        if (last && last.type === 'thinking') {
          msg.parts[msg.parts.length - 1] = { ...last, text: last.text + delta.delta }
        } else {
          msg.parts.push({ type: 'thinking', text: delta.delta, startedAt: now })
        }
      } else if (dt === 'toolcall_end') {
        const tool = delta.toolCall
        const name = tool?.name ?? 'Tool'
        const id = toolFallbackId(tool?.id, name)
        const args = tool?.arguments ?? tool?.args
        const msg = editRow(messages, idx)
        msg.parts = closeOpenParts(msg.parts, now)
        const existing = findPart(msg, (p) => p.type === 'toolCall' && p.id === id)
        if (existing && existing.type === 'toolCall') {
          const at = msg.parts.indexOf(existing)
          msg.parts[at] = { ...existing, name, args, status: 'streaming' }
        } else {
          msg.parts.push({ type: 'toolCall', id, name, args, status: 'streaming' })
        }
      }
      return messages
    }
    case 'message_end': {
      // The assistant message is complete for this turn boundary.
      return messages
    }
    case 'tool_execution_start': {
      const toolCallId = raw.toolCallId as string
      const name = raw.toolName as string
      const idx = ensureAssistant(messages)
      const msg = editRow(messages, idx)
      const id = toolFallbackId(toolCallId, name)
      const existing = findPart(msg, (p) => p.type === 'toolCall' && p.id === id)
      if (existing && existing.type === 'toolCall') {
        const at = msg.parts.indexOf(existing)
        msg.parts[at] = { ...existing, name, args: raw.args, status: 'running' }
      } else {
        msg.parts.push({ type: 'toolCall', id, name, args: raw.args, status: 'running' })
      }
      return messages
    }
    case 'tool_execution_update': {
      const idx = lastAssistantIndex(messages)
      if (idx < 0) return messages
      const id = toolFallbackId(raw.toolCallId as string, raw.toolName as string)
      const candidate = findPart(messages[idx], (p) => p.type === 'toolCall' && p.id === id)
      if (!(candidate && candidate.type === 'toolCall')) return messages
      const msg = editRow(messages, idx)
      const part = msg.parts.find((p) => p.type === 'toolCall' && p.id === id)
      if (part && part.type === 'toolCall') {
        const at = msg.parts.indexOf(part)
        msg.parts[at] = { ...part, status: 'running', resultText: raw.partialResult !== undefined ? resultText(raw.partialResult) : part.resultText }
      }
      return messages
    }
    case 'tool_execution_end': {
      const idx = lastAssistantIndex(messages)
      if (idx < 0) return messages
      const id = toolFallbackId(raw.toolCallId as string, raw.toolName as string)
      const candidate = findPart(messages[idx], (p) => p.type === 'toolCall' && p.id === id)
      if (!(candidate && candidate.type === 'toolCall')) {
        // tool_execution_end without a matching call; show as a standalone row.
        const msg = editRow(messages, idx)
        msg.parts.push({
          type: 'toolCall',
          id,
          name: raw.toolName as string,
          args: undefined,
          status: raw.isError === true ? 'error' : 'done',
          resultText: resultText(raw.result),
          isError: raw.isError === true,
          details: resultDetails(raw.result),
        })
        return messages
      }
      const done = candidate.type === 'toolCall'
        ? { ...candidate, status: (raw.isError === true ? 'error' : 'done') as ToolCallPart['status'], isError: raw.isError === true, resultText: resultText(raw.result), details: resultDetails(raw.result) }
        : candidate
      const msg = editRow(messages, idx)
      const at = msg.parts.findIndex((p) => p.type === 'toolCall' && p.id === id)
      msg.parts[at] = done
      return messages
    }
    case 'agent_end': {
      // A retry boundary is not the end of the turn: the retried run keeps
      // streaming into the same assistant row, so leave it open.
      if (raw.willRetry === true) return messages
      // Materialize the final assistant message from the canonical messages
      // array if present; otherwise finalize streaming markers.
      const idx = lastAssistantIndex(messages)
      if (idx >= 0) {
        const row = messages[idx]
        const closed = closeOpenParts(row.parts, now)
        messages[idx] = closed.length
          ? { ...row, streaming: false, parts: closed }
          : { ...row, streaming: false, parts: [{ type: 'text', text: EMPTY_TURN_FALLBACK }] }
      }
      return messages
    }
    case 'agent_start':
      return messages
    case 'turn_start':
      // A new turn may carry a user message first; do not open an assistant
      // row until an assistant message_start or the first streaming delta.
      return messages
    case 'agent_settled': {
      // The stable idle boundary: finalize any row still marked streaming
      // (e.g. when agent_end fell in a gate window around a switch), so no
      // phantom streaming cursor survives an aborted or backgrounded turn.
      for (let i = 0; i < messages.length; i++) {
        const row = messages[i]
        if (row.role === 'assistant' && row.streaming) {
          const closed = closeOpenParts(row.parts, now)
          messages[i] = closed.length
            ? { ...row, streaming: false, parts: closed }
            : { ...row, streaming: false, parts: [{ type: 'text', text: EMPTY_TURN_FALLBACK }] }
        }
      }
      return messages
    }
    case 'compaction_start': {
      // Status parts store i18n keys, not prose — Transcript translates them
      // on render (keys: transcript.compacting/compacted/retrying/retried).
      upsertSystemStatus(messages, 'compaction-live', 'transcript.compacting')
      return messages
    }
    case 'compaction_end': {
      upsertSystemStatus(messages, 'compaction-live', 'transcript.compacted')
      return messages
    }
    case 'auto_retry_start': {
      upsertSystemStatus(messages, 'retry-live', 'transcript.retrying')
      return messages
    }
    case 'auto_retry_end': {
      upsertSystemStatus(messages, 'retry-live', 'transcript.retried')
      return messages
    }
    case 'extension_error':
    case 'error':
    case 'transport_error': {
      const text = typeof raw.error === 'string' ? raw.error : 'PI encountered an error.'
      messages.push({ id: `error-${Date.now()}`, role: 'system', parts: [{ type: 'error', text }] })
      return messages
    }
    case 'runtime_exit': {
      if (raw.expected === true) return messages
      const code = raw.code as number | null | undefined
      const signal = raw.signal as string | null | undefined
      const reason = code !== null && code !== undefined
        ? `exit code ${code}`
        : signal ?? 'an unknown error'
      messages.push({
        id: `exit-${Date.now()}`,
        role: 'system',
        parts: [{ type: 'error', text: `PI stopped unexpectedly (${reason}). Send a message again to restart it.` }],
      })
      return messages
    }
    default:
      // Unknown event types (extension_ui_request, entry_appended, ready,
      // available_commands_update, session_action_update, ...) are handled
      // elsewhere; the transcript reducer ignores them.
      return messages
  }
}

/** Truncates tool result text for display; the full result stays in the PI session. */
const MAX_TOOL_RESULT_CHARS = 8_000
export function truncateResult(text: string | undefined): string {
  if (!text) return ''
  return text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`
}

// ─────────────────────────────────────────────────────────────────────────
// Disk hydration: rebuild a transcript from a PI session JSONL's message
// records. Used when resuming a session so the user sees prior history
// instead of a blank transcript.
// ─────────────────────────────────────────────────────────────────────────

interface DiskMessage {
  type?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      id?: string
      arguments?: unknown
      args?: unknown
      data?: string
      mimeType?: string
    }>
    toolCallId?: string
    toolName?: string
    isError?: boolean
    details?: unknown
  }
}

type DiskContent = NonNullable<DiskMessage['message']>['content']

// Guard for rehydrated images: beyond this the base64 payload is more cost
// than value in the DOM (gooey-pi uses the same bound); show a placeholder.
const MAX_HYDRATED_IMAGE_CHARS = 2 * 1024 * 1024

// Append one disk content entry, merging with the previous part when it is of
// the same stream kind — PI splits one contiguous text/thinking run across
// assistant records, and the live reducer keeps such runs as a single part.
function appendContentPart(parts: MessagePart[], part: NonNullable<DiskContent>[number] | undefined): void {
  if (!part) return
  if (part.type === 'text') {
    const text = part.text ?? ''
    if (!text) return
    const last = parts[parts.length - 1]
    if (last && last.type === 'text') {
      parts[parts.length - 1] = { type: 'text', text: last.text + text }
      return
    }
    parts.push({ type: 'text', text })
  } else if (part.type === 'thinking') {
    const text = part.text ?? ''
    if (!text) return
    const last = parts[parts.length - 1]
    if (last && last.type === 'thinking') {
      parts[parts.length - 1] = { type: 'thinking', text: last.text + text }
      return
    }
    parts.push({ type: 'thinking', text })
  } else if (part.type === 'toolCall') {
    const name = part.name ?? 'Tool'
    const id = toolFallbackId(part.id, name)
    parts.push({ type: 'toolCall', id, name, args: part.arguments ?? part.args, status: 'done' })
  }
}

export function hydrateTranscript(diskMessages: unknown[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  for (const raw of diskMessages) {
    const record = raw as DiskMessage
    if (!record || record.type !== 'message' || !record.message) continue
    const msg = record.message
    const role = msg.role
    if (role === 'user') {
      const parts: MessagePart[] = []
      for (const c of msg.content ?? []) {
        if (c.type === 'text' && typeof c.text === 'string') {
          parts.push({ type: 'text', text: c.text })
        } else if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') {
          // PI session JSONL stores user attachments inline as base64
          // ({type:'image', data, mimeType}); keep them renderable after a
          // restart, with a placeholder for oversized payloads.
          if (c.data.length > MAX_HYDRATED_IMAGE_CHARS) {
            parts.push({ type: 'text', text: 'transcript.imageTooLarge' })
          } else {
            parts.push({ type: 'image', data: c.data, mimeType: c.mimeType })
          }
        }
      }
      messages.push({ id: `disk-user-${messages.length}`, role: 'user', parts: parts.length ? parts : [{ type: 'text', text: '' }] })
      continue
    }
    if (role === 'assistant') {
      // Consecutive assistant records form one agentic turn (text → tool
      // call → result → more text…). Merge them into a single row, matching
      // how the live reducer streams that same turn, so a rehydrated
      // transcript has the same compact layout as a streamed one.
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        for (const part of msg.content ?? []) appendContentPart(last.parts, part)
      } else {
        const parts: MessagePart[] = []
        for (const part of msg.content ?? []) appendContentPart(parts, part)
        messages.push({ id: `disk-asst-${messages.length}`, role: 'assistant', parts })
      }
      continue
    }
    if (role === 'toolResult') {
      // Attach the result to the matching tool call in the last assistant row.
      const row = messages[messages.length - 1]
      if (row && row.role === 'assistant') {
        const id = toolFallbackId(msg.toolCallId, msg.toolName ?? 'Tool')
        const call = row.parts.find((p) => p.type === 'toolCall' && p.id === id)
        if (call && call.type === 'toolCall') {
          call.resultText = resultText(msg.content)
          call.isError = msg.isError === true
          call.status = msg.isError ? 'error' : 'done'
          call.details = msg.details
        } else {
          // No matching call: show as a standalone done tool row.
          row.parts.push({
            type: 'toolCall',
            id,
            name: msg.toolName ?? 'Tool',
            status: msg.isError ? 'error' : 'done',
            resultText: resultText(msg.content),
            isError: msg.isError,
            details: msg.details,
          })
        }
      }
      continue
    }
  }
  return messages
}

// ──────────────────────────────────────────────────────────────────────────
// Todo projection (rpiv-todo extension)
// ──────────────────────────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface TodoItem {
  id: number
  subject: string
  description?: string
  activeForm?: string
  status: TodoStatus
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'deleted'])

/**
 * Current todo list of a session, derived from the transcript: the rpiv-todo
 * extension returns a full `{tasks, nextId}` snapshot in every successful
 * `todo` tool result's `details`, so the latest snapshot wins. Pure — the
 * same transcript always yields the same list.
 */
export function deriveTodoState(messages: TranscriptMessage[]): TodoItem[] {
  let snapshot: TodoItem[] | null = null
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'toolCall' || part.name !== 'todo') continue
      if (part.isError || part.status !== 'done') continue
      const tasks = (part.details as { tasks?: unknown } | null | undefined)?.tasks
      if (!Array.isArray(tasks)) continue
      const items: TodoItem[] = []
      let valid = true
      for (const raw of tasks) {
        if (!raw || typeof raw !== 'object') continue
        const t = raw as Record<string, unknown>
        if (typeof t.id !== 'number' || typeof t.subject !== 'string' || typeof t.status !== 'string' || !TODO_STATUSES.has(t.status)) {
          valid = false
          break
        }
        items.push({
          id: t.id,
          subject: t.subject,
          description: typeof t.description === 'string' ? t.description : undefined,
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
          status: t.status as TodoStatus,
        })
      }
      if (valid) snapshot = items
    }
  }
  // Tombstoned (deleted) tasks are bookkeeping only; never render them.
  return (snapshot ?? []).filter((t) => t.status !== 'deleted')
}
