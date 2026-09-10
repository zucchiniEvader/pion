import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import type { PiEventEnvelope } from '@/types'
import type { TranscriptMessage } from '@/lib/eventReducer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

// Renders an interactive extension_ui_request (confirm / input / select /
// editor) and calls back with the response. Question-style prompts (select /
// input) render as a floating card docked above the composer — the caller
// positions it — so one questionnaire keeps one visual home; confirm / editor
// keep a native-style modal with focus trapping and Escape-to-cancel. Unknown
// interactive methods fall back to a generic JSON surface so unknown payloads
// never crash the UI.
interface ExtensionPromptProps {
  request: PiEventEnvelope
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void
  /** "Question k of N" context recovered from a running ask_user_question call. */
  questionnaire?: QuestionnaireInfo | null
  /** Called after the sentinel option is picked, with the typed custom answer. */
  onCustomAnswer?: (text: string) => void
}

export function ExtensionPrompt({ request, onRespond, questionnaire, onCustomAnswer }: ExtensionPromptProps) {
  const event = request.event as {
    method: string
    id: string
    /** pi names the heading "title"; older payloads used "message". */
    title?: string
    message?: string
    options?: unknown
    placeholder?: string
    defaultValue?: string
    allowEmpty?: boolean
  }
  const [value, setValue] = useState(typeof event.defaultValue === 'string' ? event.defaultValue : '')
  const [custom, setCustom] = useState('')
  const { t } = useI18n()
  const cancel = () => onRespond({ cancelled: true })
  const heading = event.title ?? event.message
  const progress = questionnaire
    ? t('extension.questionOf', { index: questionnaire.index + 1, total: questionnaire.total })
    : null

  if (event.method === 'select' || event.method === 'input') {
    const isSelect = event.method === 'select'
    const options = isSelect ? normalizeSelectOptions(event.options) : []
    // The ask_user_question extension appends a localized "Type something."
    // sentinel row to every question in RPC mode; render it as the free-text
    // input it actually means.
    let sentinel: SelectOption | undefined
    for (let i = options.length - 1; i >= 0; i--) {
      if (SENTINEL_RE.test(options[i].value)) {
        sentinel = options[i]
        break
      }
    }
    const plain = sentinel && onCustomAnswer ? options.filter((o) => o !== sentinel) : options
    const submitCustom = () => {
      const text = custom.trim()
      if (!text || !sentinel || !onCustomAnswer) return
      onRespond({ value: sentinel.value })
      onCustomAnswer(text)
    }
    // Plain input prompt: the typed value is the answer itself.
    const submitValue = () => {
      if (!value.trim() && !event.allowEmpty) return
      onRespond({ value })
    }
    const showSubmit = isSelect ? sentinel != null && onCustomAnswer != null : true
    const canSubmit = isSelect ? custom.trim().length > 0 : value.trim().length > 0 || !!event.allowEmpty
    const submit = () => { if (isSelect) submitCustom(); else submitValue() }
    // The extension folds option lists / instructions into the raw prompt
    // title; show only the clean question text plus a compact option hint.
    const q = questionnaire?.questions[questionnaire.index]
    const cleanHeading = q ? [q.header ? `[${q.header}] ` : '', q.question].join('') : heading
    return (
      <div className="pop-card w-full p-3">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <p className="min-w-0 text-[13px] font-semibold leading-snug">{cleanHeading || (isSelect ? 'Select' : 'Input')}</p>
          {progress && <span className="shrink-0 text-[11px] tabular-nums text-ink2">{progress}</span>}
        </div>
        {isSelect ? (
          <div className="mt-2 flex flex-col gap-1">
            {plain.map((opt) => (
              <button
                key={opt.value}
                className="rounded-lg px-3 py-2 text-left transition-colors hover:bg-fill-hover"
                onClick={() => onRespond({ value: opt.value })}
              >
                <span className="block text-[13px]">{opt.label}</span>
                {opt.description && (
                  <span className="mt-0.5 block text-xs leading-snug text-ink2">{opt.description}</span>
                )}
              </button>
            ))}
            {sentinel && onCustomAnswer && (
              <Input
                size="md"
                value={custom}
                onValueChange={setCustom}
                placeholder={t('extension.customAnswer')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitCustom()
                  }
                }}
              />
            )}
          </div>
        ) : (
          <>
            {q && q.options.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-ink2">
                {q.options.map((o, i) => (
                  <span key={i}>{i + 1}. {o}</span>
                ))}
              </div>
            )}
            <Input
              autoFocus
              size="md"
              value={value}
              onValueChange={setValue}
              placeholder={event.placeholder}
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitValue()
                }
              }}
            />
          </>
        )}
        <div className="mt-2.5 flex justify-end gap-2">
          {showSubmit && (
            <Button size="sm" disabled={!canSubmit} onClick={submit}>{t('extension.submitAnswer')}</Button>
          )}
          <Button size="sm" onClick={cancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  const width =
    event.method === 'editor' ? 'w-[min(560px,calc(100vw-48px))]' : 'w-[min(420px,calc(100vw-48px))]'

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) cancel() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] dark:bg-black/45" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-6">
          <Dialog.Popup className={cn('dialog-in outline-none rounded-xl border-[0.5px] border-line bg-canvas p-4 shadow-pop', width)}>
            {(() => {
              switch (event.method) {
                case 'confirm':
                  return (
                    <>
                      <Dialog.Title className="text-sm font-semibold leading-snug">{heading ?? 'Confirm?'}</Dialog.Title>
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Cancel</Button>
                        <Button size="sm" variant="primary" autoFocus onClick={() => onRespond({ confirmed: true })}>Confirm</Button>
                      </div>
                    </>
                  )
                case 'editor':
                  return (
                    <>
                      <Dialog.Title className="text-sm font-semibold leading-snug">{heading ?? 'Edit'}</Dialog.Title>
                      <textarea
                        className="mt-3 min-h-[220px] w-full resize-y rounded-lg border-[0.5px] border-line bg-canvas px-3 py-2 font-mono text-xs leading-relaxed transition-shadow placeholder:text-ink2 focus:border-accent"
                        value={value}
                        placeholder={event.placeholder}
                        onChange={(e) => setValue(e.target.value)}
                        rows={10}
                        autoFocus
                      />
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Cancel</Button>
                        <Button size="sm" variant="primary" onClick={() => onRespond({ value })}>Save</Button>
                      </div>
                    </>
                  )
                default:
                  // Generic fallback: never crash on an unknown interactive method.
                  return (
                    <>
                      <Dialog.Title className="font-mono text-xs text-accent">{event.method}</Dialog.Title>
                      <pre className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border-[0.5px] border-line bg-panel p-2.5 font-mono text-xs leading-relaxed select-text">
                        {safeStringify(request.event)}
                      </pre>
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Dismiss</Button>
                      </div>
                    </>
                  )
              }
            })()}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

interface SelectOption {
  label: string
  description?: string
  value: string
}

// The rpiv-ask-user-question extension appends one localized sentinel row per
// question in RPC mode. Its regular options arrive as "N. Label — desc"; the
// sentinel is "N. Type something." (en) / "N. 输入内容" (zh) with no description.
const SENTINEL_RE = /^\d+\.\s*(?:Type something\.|\u8f93\u5165\u5185\u5bb9)\s*$/

export interface QuestionnaireInfo {
  total: number
  /** 0-based index of the question this prompt belongs to. */
  index: number
  questions: { header?: string; question: string; options: string[] }[]
}

function optionLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((o) =>
      o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string'
        ? (o as { label: string }).label
        : typeof o === 'string' ? o : '',
    )
    .filter(Boolean)
}

// The extension walks its questions one select/input dialog at a time in RPC
// mode (its rpc-fallback.ts), so no single request carries the total. The
// running ask_user_question tool call's args do — correlate the prompt title
// against the question texts to recover "question k of N" and the upcoming
// questions. Returns null for prompts that aren't part of a questionnaire.
export function findQuestionnaire(transcript: TranscriptMessage[], title: string): QuestionnaireInfo | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const parts = transcript[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p.type !== 'toolCall' || p.name !== 'ask_user_question') continue
      // Only a still-running call owns the current prompt; an older finished
      // one means some other extension is asking — no progress to show.
      if (p.status !== 'running') return null
      const raw = (p.args as { questions?: unknown } | undefined)?.questions
      if (!Array.isArray(raw)) return null
      const questions = raw
        .filter((q): q is { question: string; header?: string } => {
          const c = q as { question?: unknown } | null
          return !!c && typeof c.question === 'string' && c.question.length > 0
        })
        .map((q) => ({
          question: q.question,
          header: typeof q.header === 'string' && q.header ? q.header : undefined,
          options: optionLabels((q as { options?: unknown }).options),
        }))
      if (questions.length === 0) return null
      // ponytail: first title match wins — identical question texts would
      // mis-highlight the progress list; never happens in practice.
      const index = questions.findIndex((q) => title.includes(q.question))
      if (index < 0) return null
      return { total: questions.length, index, questions }
    }
  }
  return null
}

// pi forwards select options verbatim from the extension, so their shape is
// free-form: strings, or objects with any common label/value spelling plus an
// optional description line. Whatever is missing falls back so every option
// stays visible and answerable; the response echoes a stable value string.
function normalizeSelectOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return []
  const pick = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  return raw.map((opt) => {
    if (typeof opt === 'string' || typeof opt === 'number') {
      const s = String(opt)
      return { label: s, value: s }
    }
    if (opt && typeof opt === 'object') {
      const o = opt as Record<string, unknown>
      const value = pick(o, 'value', 'id', 'label', 'name', 'title')
      const label = pick(o, 'label', 'title', 'name', 'value', 'id') ?? value
      const description = pick(o, 'description', 'detail', 'hint', 'subtitle')
      if (label) return { label, description, value: value ?? label }
      const json = safeStringify(opt)
      return { label: json, value: json }
    }
    const s = safeStringify(opt)
    return { label: s, value: s }
  })
}
