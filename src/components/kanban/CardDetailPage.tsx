import { useEffect, useState } from 'react'
import {
  Archive,
  Check,
  Link2,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  SquareKanban,
  ChevronLeft,
  ChevronDown,
} from 'lucide-react'
import type { KanbanCard, KanbanDispatchInput, ProjectRecord, SessionRecord } from '@/types'
import { KANBAN_UNASSIGNED } from '@/types'
import { fmtStamp, relTime } from '@/lib/reltime'
import { useI18n, useUserErrorMessage } from '@/i18n'
import type { MsgKey } from '@/i18n/zh'
import { cn } from '@/lib/utils'
import { MarkdownContent } from '@/components/markdown'
import { RunStateBadge } from '@/components/kanban/KanbanCardView'
import { STATUS_KEY, STATUS_STYLE } from '@/components/kanban/status-style'
import { Badge, badgeVariants } from '@/components/ui/badge'

// Timeline styling per note source: the dot carries the color, the rail
// line itself stays neutral.
const NOTE_DOT: Record<KanbanCard['notes'][number]['source'], string> = {
  user: 'bg-ink2',
  agent: 'bg-accent',
  system: 'bg-warn',
}

const NOTE_SOURCE_KEY: Record<KanbanCard['notes'][number]['source'], MsgKey> = {
  user: 'kanban.noteUser',
  agent: 'kanban.noteAgent',
  system: 'kanban.noteSystem',
}

interface CardDetailPageProps {
  card: KanbanCard
  projectName?: string
  projects: ProjectRecord[]
  onBack: () => void
  onNote: (text: string) => Promise<void>
  onArchive: () => Promise<void>
  /** Review → Done: the human sign-off that closes the loop. */
  onComplete: () => Promise<void>
  onDispatch: (input: KanbanDispatchInput) => Promise<void>
  /** Migration for unassigned cards: execution/assign requires a project. */
  onMoveProject: (toProjectPath: string) => Promise<void>
  onViewSession: (sessionFile: string) => void
}

// Full card detail page — covers the board (with a back button) instead of a
// side drawer: cards accumulate flow history, plan/review/execution results,
// so they deserve real vertical space. Every op routes through the card's own
// project store; unassigned cards first pick a project (see the 项目 row).
export function CardDetailPage({
  card,
  projectName,
  projects,
  onBack,
  onNote,
  onArchive,
  onComplete,
  onDispatch,
  onMoveProject,
  onViewSession,
}: CardDetailPageProps) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [pickedProject, setPickedProject] = useState('')
  const { lang, t } = useI18n()
  const ue = useUserErrorMessage()
  const unassigned = card.projectPath === KANBAN_UNASSIGNED

  // Bind/dispatch candidates for the card's own project.
  useEffect(() => {
    const projectPath = card.projectPath
    if (!projectPath || unassigned || card.assignee?.sessionFile) return
    let cancelled = false
    void window.pi.sessions
      .list(projectPath)
      .then((list) => {
        if (!cancelled) setSessions(list.slice(0, 50))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [card.projectPath, unassigned, card.assignee?.sessionFile])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  const submitComment = () => {
    const text = comment.trim()
    if (!text) return
    void run(async () => {
      await onNote(text)
      setComment('')
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-card-page>
      {sessionMenuOpen && <div className="fixed inset-0 z-20" onClick={() => setSessionMenuOpen(false)} />}
      {/* Page header in the SessionHeader pattern: 13px semibold title with
          the project/status/runstate chips after it (back link instead of the
          sidebar toggle). */}
      <div className="drag flex h-12 shrink-0 items-center gap-2.5 border-b-[0.5px] border-line bg-canvas pl-4 pr-3">
        <button
          className={cn(badgeVariants(), 'shrink-0 transition-colors hover:bg-fill-hover hover:text-ink')}
          onClick={onBack}
          title={t('kanban.backToBoard')}
        >
          <ChevronLeft size={12} strokeWidth={1.75} />
          {t('kanban.back')}
        </button>
        <h1 className={cn('min-w-0 truncate text-[13px] font-semibold', card.archived && 'text-ink2 line-through')}>{card.title}</h1>
        <Badge title={card.projectPath ?? t('kanban.unassigned')}>
          {card.projectPath === KANBAN_UNASSIGNED || !projectName ? t('kanban.unassigned') : projectName}
          <span className="font-mono opacity-60">· {card.id}</span>
        </Badge>
        <Badge tone={STATUS_STYLE[card.status].tone} title={t('kanban.statusTitle')}>
          {t(STATUS_KEY[card.status])}
        </Badge>
        <RunStateBadge state={card.runState} />
        {/* Archive lives in the header as a card-level action so the bottom
            comment bar stays comment-only (§评论只做评论). */}
        <button
          className={cn(badgeVariants(), 'ml-auto transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-40')}
          disabled={busy || card.archived}
          onClick={() => void run(onArchive)}
          title={t('kanban.archiveCard')}
        >
          <Archive size={11} strokeWidth={1.75} />
          {t('kanban.archive')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-4">
          <p className={cn('text-[11px] text-ink2', card.archived && 'line-through')}>
            {t('kanban.createdAt', { time: relTime(card.createdAt, lang) })} · {t('kanban.updatedAt', { time: relTime(card.updatedAt, lang) })}
          </p>

          {/* Unassigned: the execution-time project gate. */}
          {unassigned && (
            <section className="rounded-xl border-[0.5px] border-warn/40 bg-tint-warn px-3 py-2.5 text-xs">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.project')}</p>
              <p className="mt-1 text-ink2">{t('kanban.noProjectHint')}</p>
              <div className="mt-2 flex items-center gap-1.5">
                <select
                  value={pickedProject}
                  onChange={(e) => setPickedProject(e.target.value)}
                  className="h-7 min-w-0 flex-1 truncate rounded-lg border-[0.5px] border-line bg-canvas px-1.5 text-xs text-ink outline-none"
                  title={t('kanban.pickProject')}
                >
                  <option value="">{t('kanban.pickProjectDots')}</option>
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  className="flex h-7 shrink-0 items-center gap-1 rounded-lg border-[0.5px] border-line bg-canvas px-2 text-[11px] text-ink2 transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-40"
                  disabled={busy || !pickedProject}
                  title={t('kanban.moveToProject')}
                  onClick={() => pickedProject && void run(() => onMoveProject(pickedProject))}
                >
                  <SquareKanban size={11} strokeWidth={1.75} />
                  {t('kanban.moveIn')}
                </button>
              </div>
            </section>
          )}

          {/* Assignee — only for cards with a project. */}
          {card.assignee && (
            <section className="rounded-xl border-[0.5px] border-line bg-panel px-3 py-2.5 text-xs">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.assignee')}</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="truncate text-ink">{card.assignee.label ?? 'PI Agent'}</span>
                {card.assignee.model && <span className="shrink-0 rounded bg-fill-hover px-1.5 py-px text-[10px] text-ink2">{card.assignee.model}</span>}
                {card.assignee.sessionFile && (
                  <button
                    className="ml-auto shrink-0 rounded-lg border-[0.5px] border-line px-2 py-1 text-[11px] text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                    title={t('kanban.openSession')}
                    onClick={() => card.assignee?.sessionFile && onViewSession(card.assignee.sessionFile)}
                  >
                    {t('kanban.viewSession')}
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Dispatch — execution always happens inside a project. Dispatch
              to an existing session picks the session right here. Review/done
              cards are closed for dispatch: review owns the loop below. */}
          {!unassigned && !card.archived && card.status !== 'done' && card.status !== 'review' && (
            <section>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.dispatch')}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                  disabled={busy || card.runState === 'running' || card.runState === 'starting'}
                  title={t('kanban.dispatchFreshTitle')}
                  onClick={() => void run(() => onDispatch({ fresh: true }))}
                >
                  <Play size={12} strokeWidth={2} />
                  {t('kanban.dispatchToAgent')}
                </button>
                {!card.assignee?.sessionFile && (
                  <span className="relative">
                    {/* Pick-and-dispatch in one click: the button opens the
                        session list, picking a session dispatches to it. */}
                    <button
                      className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-3 text-xs text-ink2 transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-40"
                      disabled={busy || card.runState === 'running' || card.runState === 'starting'}
                      title={t('kanban.dispatchExistingTitle')}
                      onClick={() => setSessionMenuOpen(!sessionMenuOpen)}
                    >
                      <Link2 size={12} strokeWidth={1.75} />
                      {t('kanban.dispatchExisting')}
                      <ChevronDown
                        size={11}
                        strokeWidth={2}
                        className={cn('shrink-0 transition-transform', sessionMenuOpen && 'rotate-180')}
                      />
                    </button>
                    {sessionMenuOpen && (
                      <div className="dialog-in absolute left-0 top-full z-30 mt-1.5 flex max-h-72 w-72 flex-col overflow-hidden rounded-xl border-[0.5px] border-line bg-canvas p-1 shadow-pop">
                        {sessions.length === 0 ? (
                          <p className="px-2.5 py-2 text-xs text-ink2">{t('kanban.noSessionsInProject')}</p>
                        ) : (
                          <div className="min-h-0 flex-1 overflow-y-auto">
                            {sessions.map((s) => (
                              <button
                                key={s.filePath}
                                className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                                title={s.title}
                                onClick={() => {
                                  setSessionMenuOpen(false)
                                  void run(() => onDispatch({ fresh: false, sessionFile: s.filePath }))
                                }}
                              >
                                {s.title.slice(0, 40)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </span>
                )}
                {(card.runState === 'running' || card.runState === 'starting') && (
                  <span className="text-[11px] text-ink2">{t('kanban.runningNoDispatch')}</span>
                )}
              </div>
            </section>
          )}

          {/* Review — the agent has delivered; the human closes the loop here
              (§审核 Done). Comments posted in this state are forwarded to the
              executing session (main), so 标记完成 / 评论 are the only moves. */}
          {!unassigned && !card.archived && card.status === 'review' && (
            <section>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.review')}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-ok px-2.5 text-xs text-white transition-colors hover:brightness-95 disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void run(onComplete)}
                  title={t('kanban.markDone')}
                >
                  <Check size={12} strokeWidth={2} />
                  {t('kanban.done')}
                </button>
                <span className="text-[11px] text-ink2">
                  {!card.assignee?.sessionFile && t('kanban.noSessionBound')}
                </span>
              </div>
            </section>
          )}

          {card.body && (
            <section>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.description')}</p>
              <div className="mt-1 text-sm">
                <MarkdownContent text={card.body} />
              </div>
            </section>
          )}

          {card.acceptance && card.acceptance.length > 0 && (
            <section>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.acceptance')}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {card.acceptance.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-ink">
                    <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ok" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Flow history as a timeline: newest first, made explicit by the
              rail + per-entry stamps and a 最新 badge on the top entry
              (comments, agent reports, system taps). */}
          <section>
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.activity', { count: card.notes.length })}</p>
              {/* {card.notes.length > 1 && <p className="text-[11px] text-ink2">新在上 · 旧在下</p>} */}
            </div>
            {card.notes.length === 0 && <p className="mt-1 text-sm text-ink2">{t('kanban.noNotes')}</p>}
            <ol className="mt-2 flex flex-col">
              {[...card.notes].reverse().map((note, i) => (
                <li key={note.id} className="flex gap-3 pb-3 last:pb-0">
                  <div className="relative flex w-2.5 shrink-0 justify-center">
                    <span className={cn('z-10 mt-3 size-2 shrink-0 rounded-full', NOTE_DOT[note.source])} />
                    {i < card.notes.length - 1 && (
                      <span className="absolute bottom-0 top-4 left-1/2 w-px -translate-x-1/2 bg-line" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 rounded-lg bg-panel px-3 py-2 text-sm">
                    <p className="flex items-center gap-1.5 text-[11px] text-ink2">
                      <span className="font-medium text-ink">{t(NOTE_SOURCE_KEY[note.source])}</span>
                      {note.at && (
                        <span title={fmtStamp(note.at, lang)}>
                          {fmtStamp(note.at, lang)} · {relTime(note.at, lang)}
                        </span>
                      )}
                      {i === 0 && card.notes.length > 1 && (
                        <span className="shrink-0 rounded bg-fill-hover px-1.5 py-px text-[10px]">{t('kanban.latest')}</span>
                      )}
                      {note.sessionFile && (
                        <button
                          className="ml-auto shrink-0 underline decoration-line underline-offset-2 hover:text-ink"
                          onClick={() => onViewSession(note.sessionFile!)}
                        >
                          {t('kanban.viewSession')}
                        </button>
                      )}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-ink">{note.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      {/* Comment bar docked at the bottom of the page. */}
      <footer className="shrink-0 border-t-[0.5px] border-line px-4 py-3">
        {error && <p className="mb-2 break-words text-[11px] text-bad">{error}</p>}
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submitComment()
              }
            }}
            placeholder={card.status === 'review' && card.assignee?.sessionFile ? t('kanban.commentPlaceholderForward') : t('kanban.commentPlaceholder')}
            className="h-8 min-w-0 flex-1 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-xs text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
          />
          <button
            className="flex h-8 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
            disabled={busy || !comment.trim()}
            onClick={submitComment}
            title={t('kanban.addComment')}
          >
            {busy ? <LoaderCircle size={12} strokeWidth={2} className="animate-spin" /> : <MessageSquarePlus size={12} strokeWidth={1.75} />}
            {t('kanban.comment')}
          </button>
        </div>
      </footer>
    </div>
  )
}
