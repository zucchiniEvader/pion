import { useState, type ReactNode } from 'react'
import type { ToolCallPart } from '@/lib/eventReducer'
import { truncateResult } from '@/lib/eventReducer'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { MarkdownContent } from '@/components/markdown'
import { ChevronRight, FileCode2, ListChecks, ScrollText, Search, Terminal, Wrench } from 'lucide-react'

// Compact activity row in the Claude-desktop style: "icon name · summary",
// with the full arguments/result tucked into an expandable drawer.
const statusLabel: Record<ToolCallPart['status'], string> = {
  streaming: 'composing…',
  running: 'running…',
  done: '',
  error: 'failed',
}

function toolIcon(name: string) {
  const n = name.toLowerCase()
  if (n.includes('read') || n === 'cat') return FileCode2
  if (n.includes('grep') || n.includes('find') || n.includes('glob') || n.includes('list')) return Search
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) return Terminal
  return Wrench
}

function summarize(part: ToolCallPart): string {
  const args = (part.args ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  // Prefer the human-meaningful handle: file path → basename, command → head.
  const path = pick('path', 'file_path', 'filePath', 'file')
  if (path) return path.split('/').pop() || path
  const command = pick('command', 'cmd', 'script')
  if (command) return command.length > 48 ? `${command.slice(0, 48)}…` : command
  const pattern = pick('pattern', 'query', 'url')
  if (pattern) return pattern.length > 48 ? `${pattern.slice(0, 48)}…` : pattern
  try {
    const json = JSON.stringify(part.args)
    return json && json !== '{}' ? (json.length > 48 ? `${json.slice(0, 48)}…` : json) : ''
  } catch {
    return ''
  }
}

export function ToolRow({ part }: { part: ToolCallPart }) {
  // pi-plan-mode's structured tools get purpose-built cards; everything else
  // keeps the generic icon · summary · JSON-drawer row.
  if (part.name === 'plan_mode_complete') return <PlanCompleteRow part={part} />
  if (part.name === 'plan_mode_question') return <PlanQuestionRow part={part} />
  return <GenericToolRow part={part} />
}

function GenericToolRow({ part }: { part: ToolCallPart }) {
  const [expanded, setExpanded] = useState(false)
  const [showFullResult, setShowFullResult] = useState(false)
  const Icon = toolIcon(part.name)
  const argsJson = part.args !== undefined ? safeStringify(part.args) : ''
  const result = truncateResult(part.resultText)
  const busy = part.status === 'streaming' || part.status === 'running'

  return (
    <div>
      <button
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink2 transition-colors hover:bg-fill-hover"
        onClick={() => setExpanded((v) => !v)}
      >
        {busy ? (
          <span className="inline-block size-3.5 shrink-0 animate-pulse rounded-full border-[1.5px] border-warn border-t-transparent" />
        ) : (
          <Icon size={14} strokeWidth={1.75} className="shrink-0" />
        )}
        <span className={cn('font-medium', part.status === 'error' && 'text-bad')}>{part.name}</span>
        {summarize(part) && <span className="min-w-0 truncate text-ink2">· {summarize(part)}</span>}
        <span className={cn('ml-auto shrink-0 text-xs', part.status === 'error' && 'text-bad')}>
          {statusLabel[part.status]}
        </span>
        <ChevronRight size={13} className={cn('shrink-0 transition-transform duration-150', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <div className="mb-2 ml-6 space-y-2">
          {argsJson && (
            <section>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-ink2">arguments</h4>
              <pre className="m-0 max-h-[300px] select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border-[0.5px] border-line bg-panel p-2.5 font-mono text-xs leading-relaxed">{argsJson}</pre>
            </section>
          )}
          {result && (
            <section>
              <h4 className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-ink2">
                result{part.isError ? ' (error)' : ''}
                {!showFullResult && result.length > 600 && (
                  <button className="rounded text-accent hover:bg-tint-accent" onClick={() => setShowFullResult(true)}>show full</button>
                )}
              </h4>
              <pre className="m-0 max-h-[300px] select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border-[0.5px] border-line bg-panel p-2.5 font-mono text-xs leading-relaxed">{showFullResult ? result : result.slice(0, 600)}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// pi-plan-mode cards (plan_mode_question / plan_mode_complete)
// ─────────────────────────────────────────────────────────────────────────

interface PlanQuestionOption {
  label?: string
  description?: string
}

interface PlanQuestion {
  header?: string
  question?: string
  options?: PlanQuestionOption[]
}

function planArgs(part: ToolCallPart): Record<string, unknown> {
  return (part.args ?? {}) as Record<string, unknown>
}

// The plan lives in the tool arguments (available live and on disk hydrate);
// the result merely echoes it behind a "Proposed Plan" marker.
function proposedPlanText(part: ToolCallPart): string {
  const plan = planArgs(part).plan
  if (typeof plan === 'string' && plan.trim()) return plan.trim()
  const result = part.resultText ?? ''
  const marker = '**Proposed Plan**'
  return result.startsWith(marker) ? result.slice(marker.length).trim() : result
}

function planTitle(plan: string): string {
  const line = plan.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 64)
}

// Shared row shell so the plan cards look exactly like generic tool rows.
function PlanRowShell({
  part,
  icon: Icon,
  summary,
  defaultOpen,
  children,
}: {
  part: ToolCallPart
  icon: typeof Wrench
  summary: string
  defaultOpen: boolean
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultOpen)
  const busy = part.status === 'streaming' || part.status === 'running'
  return (
    <div>
      <button
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink2 transition-colors hover:bg-fill-hover"
        onClick={() => setExpanded((v) => !v)}
      >
        {busy ? (
          <span className="inline-block size-3.5 shrink-0 animate-pulse rounded-full border-[1.5px] border-warn border-t-transparent" />
        ) : (
          <Icon size={14} strokeWidth={1.75} className="shrink-0" />
        )}
        <span className="font-medium">{part.name}</span>
        {summary && <span className="min-w-0 truncate text-ink2">· {summary}</span>}
        <span className={cn('ml-auto shrink-0 text-xs', part.status === 'error' && 'text-bad')}>
          {statusLabel[part.status]}
        </span>
        <ChevronRight size={13} className={cn('shrink-0 transition-transform duration-150', expanded && 'rotate-90')} />
      </button>
      {expanded && <div className="mb-2 ml-6 space-y-2">{children}</div>}
    </div>
  )
}

// The decision-ready plan is the deliverable: rendered as markdown, open by
// default, collapsible like any other tool row.
function PlanCompleteRow({ part }: { part: ToolCallPart }) {
  const { t } = useI18n()
  const plan = proposedPlanText(part)
  return (
    <PlanRowShell part={part} icon={ScrollText} summary={planTitle(plan)} defaultOpen>
      {plan ? (
        <section className="select-text rounded-md border-[0.5px] border-line bg-panel p-3">
          <MarkdownContent text={plan} />
        </section>
      ) : (
        <p className="px-2 py-1 text-xs text-ink2">
          {part.status === 'done' ? t('tool.noPlan') : t('tool.preparingPlan')}
        </p>
      )}
    </PlanRowShell>
  )
}

// Structured clarifying questions (1-3, each 2-4 options). The interactive
// answering happens in the floating extension prompt; this card mirrors what
// was asked (and what was answered, via the result text) in the transcript.
function PlanQuestionRow({ part }: { part: ToolCallPart }) {
  const { t } = useI18n()
  const raw = planArgs(part).questions
  const questions = Array.isArray(raw) ? (raw as PlanQuestion[]) : []
  const result = truncateResult(part.resultText)
  return (
    <PlanRowShell
      part={part}
      icon={ListChecks}
      summary={questions.length ? t('tool.questionCount', { count: questions.length, s: questions.length === 1 ? '' : 's' }) : ''}
      defaultOpen={questions.length > 0}
    >
      {questions.map((q, i) => (
        <section key={i} className="rounded-md border-[0.5px] border-line bg-panel p-2.5">
          <p className="text-[13px] font-medium leading-snug">
            {q.header && <span className="mr-1.5 rounded bg-fill-hover px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.06em] text-ink2">{q.header}</span>}
            {q.question}
          </p>
          <div className="mt-1.5 flex flex-col gap-1">
            {(q.options ?? []).map((o, j) => (
              <div key={j} className="rounded border-[0.5px] border-line bg-canvas px-2 py-1">
                <span className="text-xs font-medium">{o.label}</span>
                {o.description && <span className="ml-1.5 text-xs leading-snug text-ink2">{o.description}</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
      {!questions.length && part.status !== 'done' && (
        <p className="px-2 py-1 text-xs text-ink2">{t('tool.preparingQuestions')}</p>
      )}
      {part.status === 'done' && result && (
        <section>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-ink2">answers</h4>
          <pre className="m-0 max-h-[300px] select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border-[0.5px] border-line bg-panel p-2.5 font-mono text-xs leading-relaxed">{result.slice(0, 600)}</pre>
        </section>
      )}
    </PlanRowShell>
  )
}
