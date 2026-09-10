import { memo, useEffect, useRef, useState } from 'react'
import type { AppMeta, ProjectRecord, SessionRecord, SettingsRuntime, UpdateCheckResult } from '@/types'
import { ContextMenu } from '@base-ui/react/context-menu'
import { cn } from '@/lib/utils'
import { relTime } from '@/lib/reltime'
import { useI18n } from '@/i18n'
import { AppLogo } from '@/components/AppLogo'
import { OverlayScrollArea } from '@/components/overlay-scrollbar'
import {
  Archive,
  ArchiveRestore,
  ArrowUpCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageCirclePlus,
  MessageSquarePlus,
  Pencil,
  PanelLeftClose,
  Plus,
  Settings,
  SquareKanban,
  SquarePen,
  Trash2,
} from 'lucide-react'

interface SidebarProps {
  meta: AppMeta | null
  projects: ProjectRecord[]
  /** ④ runtime list for project-row badges and offline dimming. */
  runtimes: SettingsRuntime[]
  /** Sessions keyed by project path. */
  sessionsByPath: Record<string, SessionRecord[]>
  /** Session files this app created or opened, keyed by project path; the
   * list under a project shows only these unless the user opts into all. */
  trackedFilesByPath: Record<string, string[]>
  activeProjectPath: string | null
  activeSessionPath: string | null
  /** Running/unread state per session file, so background runs still show a
   * spinner and finished-but-unseen sessions show a badge. */
  sessionStatusByFile: Record<string, { running: boolean; unread: boolean }>
  onPickProject: () => void
  /** Opens the remote add-project dialog for this runtime. */
  onAddFromRuntime: (runtime: SettingsRuntime) => void
  /** Opens the settings dialog, optionally deep-linking to a section
   * (the update badge deep-links to 'updates'). */
  onOpenSettings: (section?: 'updates') => void
  /** Update-check result owned by App (single subscriber); the footer
   * badge renders from it, the full surface lives in Settings > Updates. */
  updateResult: UpdateCheckResult | null
  onOpenProject: (project: ProjectRecord) => void
  onOpenSession: (session: SessionRecord) => void
  /** New task in the current project; opens the folder picker when none is selected. */
  onNewTask: () => void
  /** True while the main area shows the kanban board. */
  boardActive: boolean
  /** Cards waiting in Review across all projects (badge on the board entry). */
  boardReviewCount: number
  /** Toggles the board surface for the active project. */
  onToggleBoard: () => void
  /** Opens a new-task draft for the given project; the runtime starts on first send. */
  onNewTaskForProject: (project: ProjectRecord) => void
  onRenameSession: (session: SessionRecord, name: string) => void
  /** Moves a tracked session into the archive group (registry only). */
  onArchiveSession: (session: SessionRecord) => void
  /** Promotes an archived session back into the regular list. */
  onUnarchiveSession: (session: SessionRecord) => void
  onRemoveProject: (project: ProjectRecord) => void
  onCollapse: () => void
  /** Back/forward over view transitions; disabled flags come from App's history. */
  navBack: boolean
  navForward: boolean
  onNavBack: () => void
  onNavForward: () => void
}

// Full-height navigation rail: projects as expandable groups, their tasks
// nested beneath each project, PI health in the footer. Clicking a project row
// selects the project and toggles its task list; the row and its hover actions
// (new task, project menu) light up on hover only. The macOS traffic lights
// live in its top drag strip.
export function Sidebar({
  meta,
  projects,
  runtimes,
  sessionsByPath,
  trackedFilesByPath,
  activeProjectPath,
  activeSessionPath,
  sessionStatusByFile,
  onPickProject,
  onAddFromRuntime,
  onOpenSettings,
  updateResult,
  onOpenProject,
  onOpenSession,
  onNewTask,
  boardActive,
  boardReviewCount,
  onToggleBoard,
  onNewTaskForProject,
  onRenameSession,
  onArchiveSession,
  onUnarchiveSession,
  onRemoveProject,
  onCollapse,
  navBack,
  navForward,
  onNavBack,
  onNavForward,
}: SidebarProps) {
  // Which project groups are expanded; the active project follows selection.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!activeProjectPath) return
    setExpandedPaths((prev) => {
      if (prev.has(activeProjectPath)) return prev
      const next = new Set(prev)
      next.add(activeProjectPath)
      return next
    })
  }, [activeProjectPath])
  const togglePath = (path: string) =>
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const [projectsOpen, setProjectsOpen] = useState(true)
  const toggleProjectsSection = () => setProjectsOpen((v) => !v)
  // Collapsed-by-default archive groups: sessions on disk that this app never
  // created or opened. Opening one from here registers it permanently, so it
  // then moves up into the project's regular list.
  const [archivedOpenPaths, setArchivedOpenPaths] = useState<Set<string>>(new Set())
  const toggleArchived = (path: string) =>
    setArchivedOpenPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  // One open project menu at a time, with its lazily loaded extension list.
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [addProjectMenuOpen, setAddProjectMenuOpen] = useState(false)
  const remoteRuntimes = runtimes.filter((r) => r.kind === 'remote')
  /** runtimeId → runtime for project-row badges / offline dimming. */
  const runtimeById = new Map(runtimes.map((r) => [r.id, r]))
  const isProjectOffline = (p: ProjectRecord): boolean => {
    const rt = p.runtime && p.runtime !== 'local' ? runtimeById.get(p.runtime) : undefined
    return rt !== undefined && !rt.connected
  }
  const runtimeNameOf = (p: ProjectRecord): string | null => {
    if (!p.runtime || p.runtime === 'local') return null
    return runtimeById.get(p.runtime)?.name ?? null
  }
  const [confirmRemove, setConfirmRemove] = useState(false)
  const openProjectMenu = (path: string) => {
    setMenuPath(path)
    setConfirmRemove(false)
  }

  // Pi/extension upgrade availability: main runs the check async at startup;
  // App owns the subscription (single subscriber rule) and passes the result
  // down. The badge deep-links into Settings > Updates.
  const { t } = useI18n()
  const updateCheck = updateResult

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-line bg-panel">
      {/* Drag strip: traffic lights (native, left), view history + collapse docked right. */}
      <div className="drag traffic-inset-tight flex h-12 shrink-0 items-center gap-0.5 px-2">
        <button
          className="no-drag rounded-md p-1.5 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink disabled:pointer-events-none disabled:opacity-35"
          title={t('header.back')}
          disabled={!navBack}
          onClick={onNavBack}
        >
          <ChevronLeft size={16} strokeWidth={1.75} />
        </button>
        <button
          className="no-drag rounded-md p-1.5 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink disabled:pointer-events-none disabled:opacity-35"
          title={t('header.forward')}
          disabled={!navForward}
          onClick={onNavForward}
        >
          <ChevronRight size={16} strokeWidth={1.75} />
        </button>
        <button
          className="no-drag ml-auto rounded-md p-1.5 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('header.hideSidebar')}
          onClick={onCollapse}
        >
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </button>
      </div>

      {/* OverlayScrollArea hides the native scrollbar (styled webkit bars take
          layout width, which squeezed rows and reflowed the list on expand);
          its overlay thumb shows while scrolling instead. */}
      <OverlayScrollArea
        wrapperClassName="flex-1"
        scrollClassName="h-full overflow-y-auto px-2 pb-3"
      >
        <button
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors hover:bg-fill-hover"
          onClick={onNewTask}
          title={t('sidebar.newTaskTitle')}
        >
          <SquarePen size={16} strokeWidth={1.75} className="shrink-0" />
          <span>{t('sidebar.newTask')}</span>
          <span className="kbd ml-auto">⌘N</span>
        </button>
        {/* Board entry below 新建任务: the one board switch for the whole app.
            Active state shows where you are; clicking again returns to the
            session view (session rows jump back too). */}
        <button
          className={cn(
            'mt-1 flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors',
            boardActive ? 'bg-fill-active text-ink' : 'text-ink hover:bg-fill-hover',
          )}
          onClick={onToggleBoard}
          title={t('sidebar.board')}
        >
          <SquareKanban size={16} strokeWidth={1.75} className="shrink-0" />
          <span>{t('sidebar.board')}</span>
          {boardReviewCount > 0 && (
            <span
              className="ml-auto rounded-full bg-purple/12 px-1.5 py-px text-[10px] font-medium tabular-nums text-purple"
              title={t('sidebar.reviewBadgeTitle', { count: boardReviewCount, s: boardReviewCount === 1 ? '' : 's' })}
            >
              {boardReviewCount}
            </span>
          )}
        </button>

        <section className="mt-5">
          <div className="mb-1 flex items-center justify-between pl-2 pr-0.5">
            <button
              className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink2 transition-colors hover:text-ink"
              onClick={toggleProjectsSection}
            >
              <ChevronDown size={12} className={cn('transition-transform', !projectsOpen && '-rotate-90')} />
              {t('sidebar.projects')}
            </button>
            <div className="relative">
              <button
                className="rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                title={t('sidebar.addProject')}
                onClick={() => {
                  // ④: with remote runtimes configured, the + button opens a
                  // small menu; local-only keeps the exact original behavior.
                  if (remoteRuntimes.length === 0) onPickProject()
                  else setAddProjectMenuOpen((v) => !v)
                }}
              >
                <Plus size={13} />
              </button>
              {addProjectMenuOpen && remoteRuntimes.length > 0 && (
                <>
                  {/* Click-outside dismissal, same pattern as the project menu. */}
                  <div className="fixed inset-0 z-20" onClick={() => setAddProjectMenuOpen(false)} />
                  <div className="pop-card absolute right-0 top-full z-30 mt-1 min-w-[180px] p-1">
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[13px] font-medium text-ink transition-colors hover:bg-fill-hover"
                      onClick={() => {
                        setAddProjectMenuOpen(false)
                        onPickProject()
                      }}
                    >
                      <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                      {t('sidebar.addProjectLocal')}
                    </button>
                    {remoteRuntimes.map((r) => (
                      <button
                        key={r.id}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[13px] font-medium text-ink transition-colors hover:bg-fill-hover"
                        onClick={() => {
                          setAddProjectMenuOpen(false)
                          onAddFromRuntime(r)
                        }}
                      >
                        <Folder size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                        <span className="min-w-0 truncate">{t('sidebar.addProjectFrom', { name: r.name })}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {projects.length === 0 ? (
            <button
              className="mx-1 mt-1 flex w-[calc(100%-8px)] flex-col items-start gap-1 rounded-lg border border-dashed border-line px-3 py-4 text-left text-xs text-ink2 transition-colors hover:bg-fill-hover"
              onClick={onPickProject}
            >
              <FolderOpen size={16} strokeWidth={1.5} />
              <span>{t('sidebar.emptyProjects')}</span>
            </button>
          ) : (
            <ul className="space-y-0.5">
              {projects.map((p) => {
                const expanded = projectsOpen && expandedPaths.has(p.path)
                const allTasks = sessionsByPath[p.path] ?? []
                const tracked = new Set(trackedFilesByPath[p.path] ?? [])
                const tasks = allTasks.filter((s) => tracked.has(s.filePath))
                const archivedTasks = allTasks.filter((s) => !tracked.has(s.filePath))
                const archOpen = archivedOpenPaths.has(p.path)
                const menuOpen = menuPath === p.path
                return (
                  <li key={p.id}>
                    <div className="group relative">
                      <button
                        className={cn(
                          'flex h-9 w-full items-center gap-2 rounded-lg py-0 pl-2 pr-1 text-left text-[13px] text-ink transition-colors',
                          !expanded && 'hover:bg-fill-hover',
                          isProjectOffline(p) && 'opacity-50',
                        )}
                        onClick={() => {
                          // Select only when expanding; selecting while collapsing
                          // would flip activeProjectPath and the effect above would
                          // re-expand the group we just collapsed.
                          if (!expanded) onOpenProject(p)
                          togglePath(p.path)
                        }}
                        title={p.path}
                      >
                        {expanded ? (
                          <FolderOpen size={15} strokeWidth={1.75} className="shrink-0 text-ink2" />
                        ) : (
                          <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink2" />
                        )}
                        <span className="truncate font-medium">{p.name}</span>
                        {(() => {
                          const rn = runtimeNameOf(p)
                          return rn ? (
                            <span className="shrink-0 rounded bg-tint-accent px-1 py-px text-[10px] font-medium text-accent" title={rn}>
                              {rn}
                            </span>
                          ) : null
                        })()}
                        {isProjectOffline(p) && (
                          <span className="shrink-0 rounded bg-fill-hover px-1 py-px text-[10px] font-medium text-ink2">
                            {t('sidebar.offline')}
                          </span>
                        )}
                      </button>
                      {/* Hover actions: new session + project menu. */}
                      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          className="grid size-6 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                          aria-label={t('sidebar.newTaskIn', { name: p.name })}
                          title={t('sidebar.newTask')}
                          onClick={() => onNewTaskForProject(p)}
                        >
                          <MessageCirclePlus size={14} strokeWidth={1.75} />
                        </button>
                        <button
                          className={cn(
                            'grid size-6 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink',
                            menuOpen && 'bg-fill-hover text-ink opacity-100',
                          )}
                          aria-label={t('sidebar.projectOptionsAria', { name: p.name })}
                          title={t('sidebar.projectOptions')}
                          onClick={() => (menuOpen ? setMenuPath(null) : openProjectMenu(p.path))}
                        >
                          <span className="text-[13px] leading-none tracking-[0.08em]">⋯</span>
                        </button>
                      </div>
                      {menuOpen && (
                        <>
                          {/* Click-away catcher. */}
                          <div className="fixed inset-0 z-20" onClick={() => setMenuPath(null)} />
                          <div className="pop-card absolute right-1 top-full z-30 mt-1 w-72 overflow-hidden p-1.5">
                            <button
                              className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                              onClick={() => {
                                setMenuPath(null)
                                void window.pi.app.revealPath(p.path)
                              }}
                            >
                              <ExternalLink size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                              {t('sidebar.showInFinder')}
                            </button>
                            <div className="mt-1 border-t-[0.5px] border-line pt-1 pb-0.5">
                              {confirmRemove ? (
                                <>
                                  <p className="px-1.5 pb-1 text-[11px] text-ink2">{t('sidebar.removeProjectHint')}</p>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      className="min-w-0 flex-1 rounded-lg bg-bad px-2 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                                      onClick={() => {
                                        setMenuPath(null)
                                        onRemoveProject(p)
                                      }}
                                    >
                                      {t('sidebar.confirmRemove')}
                                    </button>
                                    <button
                                      className="rounded-lg px-2 py-1.5 text-xs text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                                      onClick={() => setConfirmRemove(false)}
                                    >
                                      {t('common.cancel')}
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <button
                                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-xs text-bad transition-colors hover:bg-tint-bad"
                                  onClick={() => setConfirmRemove(true)}
                                >
                                  <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
                                  {t('sidebar.removeProject')}
                                </button>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                    {/* Nested task list under this project. Animated via the
                        grid 0fr→1fr trick; content stays mounted when collapsed. */}
                    <div
                      className={cn(
                        'grid transition-[grid-template-rows] duration-200 ease-out',
                        expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        {tasks.length > 0 ? (
                          <ul className="ml-[15px] space-y-0.5 border-l border-line pb-1 pl-1.5 pt-0.5">
                            {tasks.map((s) => (
                              <SessionRow
                                key={s.id}
                                session={s}
                                active={s.filePath === activeSessionPath}
                                spinning={sessionStatusByFile[s.filePath]?.running}
                                unread={sessionStatusByFile[s.filePath]?.unread && !sessionStatusByFile[s.filePath]?.running}
                                onOpen={onOpenSession}
                                onRename={onRenameSession}
                                onArchive={onArchiveSession}
                              />
                            ))}
                          </ul>
                        ) : (
                          <span className="ml-[15px] mt-0.5 flex h-7 items-center gap-1.5 rounded-md text-xs text-ink2 transition-colors">
                            {t('sidebar.noSessions')}
                          </span>
                        )}
                        {/* Archive: sessions on disk this app never created or
                            opened. Opening one registers it as tracked, so it
                            then moves up into the regular list above. */}
                        {archivedTasks.length > 0 && (
                          <div className="ml-[15px] border-l border-line pb-1 pl-1.5">
                            <button
                              className="flex h-6 w-full items-center gap-1 rounded-md pr-2 pl-1.5 text-[11px] text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                              title={t('sidebar.archiveGroupTitle')}
                              onClick={() => toggleArchived(p.path)}
                            >
                              <ChevronDown size={11} className={cn('transition-transform', !archOpen && '-rotate-90')} />
                              <span>{t('sidebar.archiveGroup')}</span>
                              <span className="ml-auto tabular-nums">{archivedTasks.length}</span>
                            </button>
                            <div
                              className={cn(
                                'grid transition-[grid-template-rows] duration-200 ease-out',
                                archOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                              )}
                            >
                              <ul className="min-h-0 space-y-0.5 overflow-hidden pb-1 pt-0.5">
                                {archivedTasks.map((s) => (
                                  <SessionRow
                                    key={s.id}
                                    session={s}
                                    muted
                                    active={s.filePath === activeSessionPath}
                                    spinning={sessionStatusByFile[s.filePath]?.running}
                                    unread={sessionStatusByFile[s.filePath]?.unread && !sessionStatusByFile[s.filePath]?.running}
                                    onOpen={onOpenSession}
                                    onRename={onRenameSession}
                                    onUnarchive={onUnarchiveSession}
                                  />
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </OverlayScrollArea>

      <footer className="flex h-12 shrink-0 items-center gap-2.5 border-t border-line px-3">
        <AppLogo className="size-6 rounded-md" />
        <span className="text-[13px] font-medium">Pion</span>
        {meta?.piPath ? (
          <span className="rounded-md bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok">
            {meta.piVersion ? `v${meta.piVersion}` : t('sidebar.piDetected')}
          </span>
        ) : (
          <span className="rounded-md bg-bad/10 px-1.5 py-0.5 text-[10px] font-medium text-bad">{t('sidebar.piMissing')}</span>
        )}
        {updateCheck && updateCheck.outdatedCount > 0 && (
          <button
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-tint-warn px-1.5 py-0.5 text-[10px] font-medium text-warn transition-colors hover:bg-warn/20"
            title={t('sidebar.updateAvailableTitle')}
            onClick={() => onOpenSettings('updates')}
          >
            <ArrowUpCircle size={11} strokeWidth={1.75} />
            {t('sidebar.updatesCount', { count: updateCheck.outdatedCount, s: updateCheck.outdatedCount === 1 ? '' : 's' })}
          </button>
        )}
        <button
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('sidebar.settings')}
          onClick={() => onOpenSettings()}
        >
          <Settings size={12} />
        </button>
      </footer>
    </aside>
  )
}

// One nested task row: click opens; right-click opens a context menu
// (rename today, more actions later); editing swaps the title for an inline
// input (Enter commits, Escape cancels).
// memo: the pool pushes state at streaming-flush cadence and the session list
// refreshes at 2Hz; unchanged rows (stable session identity via App's merge +
// stable handlers) must bail here instead of re-executing 178× per update.
const SessionRow = memo(function SessionRow({
  session,
  active,
  spinning,
  unread,
  muted,
  onOpen,
  onRename,
  onArchive,
  onUnarchive,
}: {
  session: SessionRecord
  active: boolean
  spinning?: boolean
  unread?: boolean
  /** Archived (non-app) session: slightly muted title. */
  muted?: boolean
  onOpen: (session: SessionRecord) => void
  onRename: (session: SessionRecord, name: string) => void
  /** Present for tracked sessions: move into the archive group. */
  onArchive?: (session: SessionRecord) => void
  /** Archived (non-app) session: promote back to the regular list. */
  onUnarchive?: (session: SessionRecord) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.title)
  const { lang, t } = useI18n()

  const commit = () => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== session.title) onRename(session, trimmed)
  }

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(session.title)
              setEditing(false)
            }
          }}
          className="h-8 w-full rounded-md border-[0.5px] border-accent bg-canvas px-2 text-[13px] text-ink outline-none"
        />
      </li>
    )
  }

  return (
    <li>
      <ContextMenu.Root>
        <ContextMenu.Trigger className="block w-full">
          <button
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors',
              active ? 'bg-fill-hover' : 'hover:bg-fill-hover',
            )}
            onClick={() => onOpen(session)}
            title={session.preview ?? session.title}
          >
            <span className={cn('min-w-0 truncate', muted ? 'font-normal text-ink2' : 'font-medium')}>
              {session.title || t('sidebar.untitledTask')}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {unread && <span className="size-1.5 rounded-full bg-accent" />}
              <span className="text-[11px] text-ink2">{relTime(session.updatedAt, lang)}</span>
              {spinning && <LoaderCircle size={13} strokeWidth={1.75} className="animate-spin text-accent" />}
            </span>
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="outline-none">
            <ContextMenu.Popup className="pop-card min-w-[192px] p-1">
              <ContextMenu.Item
                className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium text-ink outline-none select-none data-highlighted:bg-fill-hover"
                onClick={() => {
                  setName(session.title)
                  setEditing(true)
                }}
              >
                <Pencil size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                {t('sidebar.rename')}
              </ContextMenu.Item>
              <ContextMenu.Item
                className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium text-ink outline-none select-none data-highlighted:bg-fill-hover"
                onClick={() => void window.pi.app.revealPath(session.filePath)}
              >
                <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                {t('sidebar.showInFinder')}
              </ContextMenu.Item>
              {onArchive && (
                <ContextMenu.Item
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium text-ink outline-none select-none data-highlighted:bg-fill-hover"
                  onClick={() => onArchive(session)}
                >
                  <Archive size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                  {t('sidebar.archive')}
                </ContextMenu.Item>
              )}
              {onUnarchive && (
                <ContextMenu.Item
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium text-ink outline-none select-none data-highlighted:bg-fill-hover"
                  onClick={() => onUnarchive(session)}
                >
                  <ArchiveRestore size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                  {t('sidebar.unarchive')}
                </ContextMenu.Item>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </li>
  )
})
