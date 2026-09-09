import { LoaderCircle } from 'lucide-react'
import type { CardRunState, KanbanCard } from '@/types'
import { KANBAN_UNASSIGNED } from '@/types'
import { relTime } from '@/lib/reltime'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { STATUS_STYLE } from '@/components/kanban/status-style'

// RunState projection badge (main derives it from the runtime pool): a
// spinner while the assigned worker spins up, a pulsing dot while running,
// and colored result dots for settled/failed. Idle shows nothing.
export function RunStateBadge({ state }: { state: CardRunState }) {
  const { t } = useI18n()
  if (state === 'idle') return null
  if (state === 'starting')
    return (
      <span className="shrink-0 text-ink2" title={t('kanban.cardRunStarting')}>
        <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
      </span>
    )
  if (state === 'running')
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] text-ink2" title={t('kanban.cardRunWorking')}>
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      </span>
    )
  const settled = state === 'settled'
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', settled ? 'bg-ok' : 'bg-bad')}
      title={settled ? t('kanban.cardRunSettled') : t('kanban.cardRunError')}
    />
  )
}

// Stable per-project dot color on the all-projects board: a small palette
// indexed by a cheap string hash keeps one color per project per session.
const PROJECT_DOTS = ['bg-accent', 'bg-ok', 'bg-warn', 'bg-bad']
export function projectDotClass(projectPath: string): string {
  let hash = 0
  for (let i = 0; i < projectPath.length; i++) hash = (hash * 31 + projectPath.charCodeAt(i)) | 0
  return PROJECT_DOTS[Math.abs(hash) % PROJECT_DOTS.length]
}

/** 项目标签:色点 + 项目名,标记卡片归属(聚合视图下显示);未分配卡用中性点。 */
export function ProjectTag({ projectPath, name }: { projectPath: string; name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 rounded bg-fill-hover px-1 py-px" title={projectPath}>
      <span className={cn('size-1.5 shrink-0 rounded-full', projectPath === KANBAN_UNASSIGNED ? 'bg-ink2/50' : projectDotClass(projectPath))} />
      <span className="max-w-[72px] truncate">{name}</span>
    </span>
  )
}

// One card on a column: title, project tag, model chip, runState badge,
// note/acceptance counters, and relative update time. Click opens the drawer.
export function KanbanCardView({
  card,
  projectName,
  onOpen,
}: {
  card: KanbanCard
  /** Shown as a project tag when provided (all-projects view). */
  projectName?: string
  onOpen: () => void
}) {
  const { lang } = useI18n()
  return (
    <button
      className={cn(
        'w-full rounded-xl border-[0.5px] border-line bg-panel p-2.5 text-left shadow-card transition-colors hover:bg-fill-hover',
        STATUS_STYLE[card.status].stripe,
      )}
      title={card.title}
      onClick={onOpen}
    >
      <div className="flex items-start gap-1.5">
        <p className={cn('min-w-0 flex-1 text-xs font-medium leading-5', card.archived && 'text-ink2 line-through')}>{card.title}</p>
        <RunStateBadge state={card.runState} />
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-ink2">
        {projectName && card.projectPath && <ProjectTag projectPath={card.projectPath} name={projectName} />}
        {card.assignee?.model && (
          <span className="max-w-[110px] truncate rounded bg-fill-hover px-1 py-px" title={card.assignee.label ? `${card.assignee.label} · ${card.assignee.model}` : card.assignee.model}>
            {card.assignee.model}
          </span>
        )}
        {card.acceptance && card.acceptance.length > 0 && <span className="shrink-0">✓{card.acceptance.length}</span>}
        {card.notes.length > 0 && <span className="shrink-0">💬 {card.notes.length}</span>}
        <span className="ml-auto shrink-0">{relTime(card.updatedAt, lang)}</span>
      </div>
    </button>
  )
}
