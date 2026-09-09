import { useMemo, useState } from 'react'
import { Archive, Plus } from 'lucide-react'
import type { CardStatus, KanbanCard, ProjectRecord, SettingsRuntime } from '@/types'
import { KANBAN_UNASSIGNED } from '@/types'
import { KANBAN_STATUSES } from '@/lib/kanbanReducer'
import { STATUS_KEY, STATUS_STYLE } from '@/components/kanban/status-style'
import { cn } from '@/lib/utils'
import { useI18n, useUserErrorMessage } from '@/i18n'
import { useAllKanbanBoards } from '@/hooks/useAllKanbanBoards'
import { KanbanCardView } from '@/components/kanban/KanbanCardView'
import { OverlayScrollArea } from '@/components/overlay-scrollbar'
import { CardDetailPage } from '@/components/kanban/CardDetailPage'
import { CardCreateDialog } from '@/components/kanban/CardCreateDialog'

interface BoardViewProps {
  /** All registered projects; the board also aggregates unassigned cards. */
  projects: ProjectRecord[]
  runtimes: SettingsRuntime[]
  /** Aggregated board data, owned by App (single changed-subscription). */
  kanban: ReturnType<typeof useAllKanbanBoards>
  /** Jumps the main area to a worker session (transcript) by its project + file. */
  onViewSession: (projectPath: string, sessionFile: string) => void
}

// The kanban surface: toolbar (project filter + create dialog) and the
// five-column grid — or, when a card is open, the full-card detail page that
// covers it (cards accumulate plan/review/execution history; they deserve a
// page, not a side panel).
export function BoardView({ projects, runtimes, kanban, onViewSession }: BoardViewProps) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const { allCards, error, refreshProject } = kanban
  // 'all' | KANBAN_UNASSIGNED | projectPath — the aggregated view is default.
  const [filter, setFilter] = useState<string>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const nameByPath = useMemo(() => {
    const map = new Map(projects.map((p) => [p.path, p.name]))
    map.set(KANBAN_UNASSIGNED, t('kanban.unassigned'))
    return map
  }, [projects, t])

  const visible = useMemo(() => allCards.filter((c) => (filter === 'all' || c.projectPath === filter) && (showArchived || !c.archived)), [allCards, filter, showArchived])
  const byStatus = useMemo(() => {
    const grouped: Record<CardStatus, KanbanCard[]> = { todo: [], in_progress: [], review: [], done: [] }
    for (const card of visible) grouped[card.status].push(card)
    // 每列新卡在上(updatedAt 倒序)——活跃的卡片一眼可见。
    for (const list of Object.values(grouped)) list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return grouped
  }, [visible])

  const openCard = openCardId ? allCards.find((c) => c.id === openCardId) ?? null : null

  const createCard = async (input: { projectPath: string; title: string; body?: string; acceptance?: string[] }) => {
    await window.pi.kanban.create(input.projectPath, { title: input.title, body: input.body, acceptance: input.acceptance })
    await refreshProject(input.projectPath)
    // A card created outside the current filter would vanish on close —
    // follow it to the all-projects view instead.
    if (filter !== 'all' && filter !== input.projectPath) setFilter('all')
  }

  const columns = (
    <>
      {/* Header bar in the SessionHeader pattern: h-12 canvas bar with a
          13px semibold title, followed by the board controls. */}
      <div className="drag flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-line bg-canvas pl-4 pr-3">
        {/* <h1 className="shrink-0 truncate text-[13px] font-semibold">任务看板</h1> */}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 w-[150px] shrink-0 rounded-lg border-[0.5px] border-line bg-panel px-1.5 text-xs text-ink outline-none"
          title={t('kanban.filterByProject')}
        >
          <option value="all">{t('kanban.allProjects')}</option>
          <option value={KANBAN_UNASSIGNED}>{t('kanban.unassigned')}</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          onClick={() => setCreateOpen(true)}
          title={t('kanban.newCard')}
        >
          <Plus size={13} strokeWidth={2} />
          {t('kanban.newCard')}
        </button>
        <button
          className={cn(
            'ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-2.5 text-xs transition-colors',
            showArchived ? 'bg-fill-active text-ink' : 'text-ink2 hover:bg-fill-hover hover:text-ink',
          )}
          onClick={() => setShowArchived((v) => !v)}
          title={t('kanban.showArchived')}
        >
          <Archive size={12} strokeWidth={1.75} />
          {t('kanban.archived')}
        </button>
      </div>
      {(error ?? actionError) && (
        <p className="shrink-0 border-t-[0.5px] border-bad/30 bg-tint-bad px-4 py-1.5 text-[11px] text-bad">{ue(error ?? actionError)}</p>
      )}

      {/* Columns */}
      <div className="flex min-h-0 flex-1 items-stretch gap-2 overflow-x-auto px-3 pb-3 mt-2">
        {KANBAN_STATUSES.map((status) => (
          <section key={status} className="flex min-w-[200px] flex-1 flex-col rounded-2xl bg-panel/60">
            <header className="flex shrink-0 items-center gap-1.5 px-2.5 pb-1 pt-2.5">
              <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_STYLE[status].dot)} title={t(STATUS_KEY[status])} />
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t(STATUS_KEY[status])}</h3>
              <span className="rounded bg-fill-hover px-1.5 text-[10px] text-ink2">{byStatus[status].length}</span>
            </header>
            <OverlayScrollArea
              wrapperClassName="flex-1"
              scrollClassName="flex h-full flex-col gap-1.5 overflow-y-auto px-1.5 pb-2"
            >
              {byStatus[status].map((card) => (
                <KanbanCardView
                  key={card.id}
                  card={card}
                  // Project tags carry information in the aggregated view.
                  projectName={filter === 'all' && card.projectPath ? nameByPath.get(card.projectPath) : undefined}
                  onOpen={() => setOpenCardId(card.id)}
                />
              ))}
            </OverlayScrollArea>
          </section>
        ))}
      </div>
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {openCard ? (
        <CardDetailPage
          key={openCard.id}
          card={openCard}
          projectName={openCard.projectPath ? nameByPath.get(openCard.projectPath) : undefined}
          projects={projects}
          onBack={() => setOpenCardId(null)}
          onNote={async (text) => {
            await window.pi.kanban.note(openCard.projectPath!, openCard.id, text)
            await refreshProject(openCard.projectPath!)
          }}
          onArchive={async () => {
            await window.pi.kanban.archive(openCard.projectPath!, openCard.id)
            await refreshProject(openCard.projectPath!)
          }}
          onComplete={async () => {
            await window.pi.kanban.move(openCard.projectPath!, openCard.id, 'done')
            await refreshProject(openCard.projectPath!)
          }}
          onDispatch={async (input) => {
            await window.pi.kanban.dispatch(openCard.projectPath!, openCard.id, input)
            await refreshProject(openCard.projectPath!)
          }}
          onMoveProject={async (toProjectPath) => {
            const from = openCard.projectPath!
            await window.pi.kanban.moveProject(from, openCard.id, toProjectPath)
            await refreshProject(from)
            await refreshProject(toProjectPath)
            // Follow the card so it stays on screen after the migration.
            if (filter !== 'all') setFilter(toProjectPath)
          }}
          onViewSession={(file) => {
            const projectPath = openCard.projectPath!
            setOpenCardId(null)
            onViewSession(projectPath, file)
          }}
        />
      ) : (
        projects.length === 0 && filter === 'all' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <p className="px-4 pt-2 text-xs text-ink2">{t('kanban.noProjects')}</p>
            {columns}
          </div>
        ) : (
          columns
        )
      )}

      {createOpen && (
        <CardCreateDialog
          projects={projects}
          runtimes={runtimes}
          defaultProjectPath={filter !== 'all' && filter !== KANBAN_UNASSIGNED ? filter : null}
          onClose={() => setCreateOpen(false)}
          onCreate={createCard}
        />
      )}
    </div>
  )
}
