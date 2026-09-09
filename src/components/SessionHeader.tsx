import { useEffect, useState, type KeyboardEvent } from 'react'
import type { GitBranchInfo, GitOverview, ProjectRecord } from '@/types'
import { cn } from '@/lib/utils'
import { useI18n, useUserErrorMessage } from '@/i18n'
import { Input } from '@/components/ui/input'
import {
  Check,
  ChevronDown,
  FolderOpen,
  Ghost,
  GitBranch,
  LoaderCircle,
  PanelLeftOpen,
  Plus,
} from 'lucide-react'

interface SessionHeaderProps {
  sidebarOpen: boolean
  onOpenSidebar: () => void
  /** Session title; falls back to the project name in App. */
  title: string
  project: ProjectRecord | null
}

// One metric for every header chip so text chips and the icon-only button
// render at exactly the same height regardless of content.
const chip =
  'flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-line bg-panel px-2 text-xs text-ink2 transition-colors'

// Segment of the "open externally" control: three icon-only buttons inside
// one bordered pill, each icon matching the target app.
const openSegment =
  'flex h-full w-[26px] items-center justify-center text-ink2 transition-colors first:rounded-l-[7px] last:rounded-r-[7px] hover:bg-fill-hover hover:text-ink'

// macOS Finder face: split rounded square with eyes and a smile.
function FinderIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="4.5" />
      <path d="M12 3v18" />
      <path d="M7.75 9.25v1.5" />
      <path d="M16.25 9.25v1.5" />
      <path d="M7.75 15.25c1.25 1.05 2.7 1.55 4.25 1.55s3-.5 4.25-1.55" />
    </svg>
  )
}

// Official VS Code mark (simple-icons path), filled with currentColor so it
// matches the monochrome header icons.
function VSCodeIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .325 8.74L3.899 12 .325 15.26a1 1 0 0 0 .002 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352Zm-5.146 14.861L10.826 12l7.178-5.448v10.896Z" />
    </svg>
  )
}

// Cap the session header title to 25 characters; Array.from splits on code
// points so surrogate pairs (emoji) aren't cut in half. Keeps the header
// compact regardless of how long the stored title is.
const capTitle = (t: string) => {
  const chars = Array.from(t)
  return chars.length > 25 ? chars.slice(0, 25).join('') + '…' : t
}

// Session-page top bar: draggable chrome with the session title, static
// project chip, branch/worktree dropdown, and the "open externally" icon
// group (Finder / Ghostty / VS Code).
export function SessionHeader({ sidebarOpen, onOpenSidebar, title, project }: SessionHeaderProps) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  // Branch/worktree overview of the active project; null while loading.
  const [overview, setOverview] = useState<GitOverview | null>(null)
  const [menuError, setMenuError] = useState<string | null>(null)
  // Branch whose worktree is being created right now (row spinner).
  const [busyBranch, setBusyBranch] = useState<string | null>(null)
  // "新建 Worktree" inline form state.
  const [formMode, setFormMode] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [creating, setCreating] = useState(false)

  const closeMenus = () => {
    setBranchMenuOpen(false)
    setFormMode(false)
    setNewBranch('')
    setMenuError(null)
  }

  const refreshOverview = (path: string) =>
    window.pi.git
      .overview(path)
      .then(setOverview)
      .catch(() => setOverview({ isRepo: false, currentBranch: null, branches: [] }))

  // Overview loads with the project so the chip can show the branch name;
  // a project that isn't a git repo (or git missing) just hides the chip.
  useEffect(() => {
    setOverview(null)
    closeMenus()
    setBusyBranch(null)
    if (project) void refreshOverview(project.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path])

  const toggleBranchMenu = () => {
    setMenuError(null)
    if (!branchMenuOpen && project) {
      // Re-fetch on open so worktrees created outside the app show up.
      void refreshOverview(project.path)
    }
    setBranchMenuOpen(!branchMenuOpen)
  }

  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  // A branch without a worktree gets one created; a branch that already has
  // one (or is the main worktree's branch) is revealed in Finder.
  const openBranchWorktree = async (branch: GitBranchInfo) => {
    if (!project || busyBranch) return
    setMenuError(null)
    try {
      if (branch.worktreePath) {
        await window.pi.app.revealPath(branch.worktreePath)
        closeMenus()
        return
      }
      setBusyBranch(branch.name)
      const { path } = await window.pi.git.createWorktree(project.path, branch.name)
      void refreshOverview(project.path)
      await window.pi.app.revealPath(path)
      closeMenus()
    } catch (e) {
      setMenuError(errorMessage(e))
    } finally {
      setBusyBranch(null)
    }
  }

  const submitWorktree = async () => {
    const name = newBranch.trim()
    if (!name || !project || creating) return
    setMenuError(null)
    setCreating(true)
    try {
      const { path } = await window.pi.git.createWorktree(project.path, name)
      void refreshOverview(project.path)
      await window.pi.app.revealPath(path)
      closeMenus()
    } catch (e) {
      setMenuError(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  const onFormKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submitWorktree()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setFormMode(false)
      setNewBranch('')
    }
  }

  // Runs one external-open action; failures surface below the icon group
  // until the next action.
  const runExternal = (action: () => Promise<void>) => {
    setMenuError(null)
    action()
      .then(() => closeMenus())
      .catch((e) => setMenuError(errorMessage(e)))
  }

  const hasOpenMenu = branchMenuOpen

  return (
    <header className="drag relative flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-line bg-canvas pl-4 pr-3">
      {/* Click-away catcher for both menus. */}
      {hasOpenMenu && <div className="fixed inset-0 z-20" onClick={closeMenus} />}
      {!sidebarOpen && (
        <button
          className="no-drag rounded-md p-1.5 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('header.showSidebar')}
          onClick={onOpenSidebar}
        >
          <PanelLeftOpen size={16} strokeWidth={1.75} />
        </button>
      )}
      {project && (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1 className="truncate text-[13px] font-semibold" title={title}>{capTitle(title)}</h1>
          {/* 静态项目 chip:仅展示,不响应点击。标题回退为项目名时隐藏,
              避免同一个名字以两种字号并排出现。 */}
          {title !== project.name && (
            <div className={cn(chip, 'hidden cursor-default sm:flex')} title={project.path}>
              <FolderOpen size={12} strokeWidth={1.75} />
              <span className="max-w-[160px] truncate">{project.name}</span>
            </div>
          )}
          {overview?.isRepo && (
            <span className="relative hidden sm:block">
              <button
                className={cn(chip, 'hover:bg-fill-hover hover:text-ink')}
                title={t('header.branchWorktree')}
                onClick={toggleBranchMenu}
              >
                <GitBranch size={12} strokeWidth={1.75} />
                <span className="max-w-[140px] truncate">{overview.currentBranch ?? 'HEAD'}</span>
                <ChevronDown
                  size={11}
                  strokeWidth={2}
                  className={cn('shrink-0 transition-transform', branchMenuOpen && 'rotate-180')}
                />
              </button>
              {branchMenuOpen && (
                <div className="dialog-in no-drag absolute left-0 top-full z-30 mt-1.5 flex max-h-96 w-72 flex-col overflow-hidden rounded-xl border-[0.5px] border-line bg-canvas p-1 shadow-pop">
                  {formMode ? (
                    <div className="flex flex-col gap-2 p-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('header.newWorktree')}</p>
                      <Input
                        autoFocus
                        value={newBranch}
                        onValueChange={setNewBranch}
                        onKeyDown={onFormKeyDown}
                        placeholder={t('header.branchPlaceholder')}
                        disabled={creating}
                      />
                      <p className="truncate text-[11px] text-ink2" title={project.path}>
                        {t('header.worktreeLocation', { name: project.name })}
                      </p>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          className="rounded-lg px-2.5 py-1.5 text-xs text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                          onClick={() => {
                            setFormMode(false)
                            setNewBranch('')
                          }}
                          disabled={creating}
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                          onClick={() => void submitWorktree()}
                          disabled={!newBranch.trim() || creating}
                        >
                          {creating && <LoaderCircle size={11} strokeWidth={2} className="animate-spin" />}
                          {t('header.create')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('header.branches')}</p>
                        {overview.branches.length === 0 && <p className="px-2.5 py-2 text-xs text-ink2">{t('header.noBranches')}</p>}
                        {overview.branches.map((b) => {
                          // The current branch checks out in the main worktree,
                          // which is not a "linked" worktree worth a badge.
                          const linked = b.worktreePath && b.worktreePath !== project.path
                          return (
                            <button
                              key={b.name}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover disabled:opacity-50"
                              title={linked ? t('header.showWorktreeInFinder', { path: b.worktreePath ?? '' }) : t('header.createWorktreeFor', { name: b.name })}
                              disabled={busyBranch !== null}
                              onClick={() => void openBranchWorktree(b)}
                            >
                              <span className="min-w-0 flex-1 truncate">{b.name}</span>
                              {busyBranch === b.name ? (
                                <LoaderCircle size={12} strokeWidth={2} className="shrink-0 animate-spin text-ink2" />
                              ) : (
                                linked && (
                                  <span
                                    className="shrink-0 rounded bg-fill-hover px-1.5 py-px text-[10px] text-ink2"
                                    title={b.worktreePath ?? undefined}
                                  >
                                    worktree
                                  </span>
                                )
                              )}
                              {overview.currentBranch === b.name && <Check size={13} strokeWidth={2} className="shrink-0" />}
                            </button>
                          )
                        })}
                      </div>
                      <div className="mt-1 border-t-[0.5px] border-line pt-1">
                        <button
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                          onClick={() => {
                            setMenuError(null)
                            setNewBranch('')
                            setFormMode(true)
                          }}
                        >
                          <Plus size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                          <span>{t('header.newWorktreeDots')}</span>
                        </button>
                      </div>
                    </>
                  )}
                  {menuError && <p className="break-words border-t-[0.5px] border-line px-2.5 py-2 text-[11px] text-bad">{ue(menuError)}</p>}
                </div>
              )}
            </span>
          )}
        </div>
      )}
      {!project && <div className="flex-1" />}
      {project && (
        <span className="relative">
          <span className="no-drag flex h-[26px] items-center overflow-hidden rounded-lg border-[0.5px] border-line bg-panel">
            <button
              className={openSegment}
              title={t('sidebar.showInFinder')}
              onClick={() => runExternal(() => window.pi.app.revealPath(project.path))}
            >
              <FinderIcon size={13} />
            </button>
            <button
              className={openSegment}
              title={t('header.openGhostty')}
              onClick={() => runExternal(() => window.pi.app.openGhostty(project.path))}
            >
              <Ghost size={13} strokeWidth={1.75} />
            </button>
            <button
              className={openSegment}
              title={t('header.openVSCode')}
              onClick={() => runExternal(() => window.pi.app.openVSCode(project.path))}
            >
              <VSCodeIcon size={13} />
            </button>
          </span>
          {menuError && (
            <div
              className="dialog-in absolute right-0 top-full z-30 mt-1.5 w-56 cursor-pointer break-words rounded-xl border-[0.5px] border-line bg-canvas px-2.5 py-2 text-[11px] text-bad shadow-pop"
              onClick={() => setMenuError(null)}
            >
              {ue(menuError)}
            </div>
          )}
        </span>
      )}
    </header>
  )
}
