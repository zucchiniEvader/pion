import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppMeta, ProjectRecord, PromptImage, RuntimeInfo, SessionRecord, SettingsRuntime } from '@/types'
import { useSessionPool } from '@/hooks/useSessionPool'
import { deriveTodoState } from '@/lib/eventReducer'
import { isHomeSurfaceUp, isInertDraft, judgePrewarm, resolveViewedSessionFile, shouldStartPrewarm } from '@/lib/draftDecision'
import { Sidebar } from '@/components/Sidebar'
import { cn } from '@/lib/utils'
import { SettingsDialog, type SettingsSection } from '@/components/SettingsDialog'
import { RemoteAddDialog } from '@/components/RemoteAddDialog'
import { Transcript } from '@/components/Transcript'
import { Composer } from '@/components/Composer'
import { ExtensionPrompt, findQuestionnaire } from '@/components/ExtensionPrompt'
import { BootScreen } from '@/components/BootScreen'
import { Home } from '@/components/Home'
import { SessionHeader } from '@/components/SessionHeader'
import { ImageLightbox } from '@/components/ImageLightbox'
import { TodoPanel } from '@/components/TodoPanel'
import { BoardView } from '@/components/kanban/BoardView'
import { useAllKanbanBoards } from '@/hooks/useAllKanbanBoards'
import { useUpdateCheck } from '@/hooks/useUpdateCheck'
import { useUserErrorMessage } from '@/i18n'

export default function App() {
  const ue = useUserErrorMessage()
  const [meta, setMeta] = useState<AppMeta | null>(null)
  // Boot gate: verify the PI environment before the main UI mounts; a machine
  // without pi is held on the setup guide instead.
  const [boot, setBoot] = useState<'loading' | 'ready' | 'setup'>('loading')
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [sessionsByPath, setSessionsByPath] = useState<Record<string, SessionRecord[]>>({})
  // Session files this app created or opened, per project path; the sidebar
  // shows only these (plus a "show all" browse escape hatch).
  const [trackedByPath, setTrackedByPath] = useState<Record<string, string[]>>({})
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Main-area surface: the conversation (session view) or the project's
  // kanban board. Board state is per project; switching projects keeps it.
  const [mainView, setMainView] = useState<'session' | 'board'>('session')
  const [elapsedSec, setElapsedSec] = useState(0)
  const pool = useSessionPool()
  // Aggregated board data lives here (single owner): the sidebar's review
  // badge and the board view share one subscription — preload dispatches each
  // push channel to the LATEST subscriber only, so a second hook instance
  // would steal BoardView's live updates.
  const kanbanBoards = useAllKanbanBoards(projects)
  const active = pool.activeSession

  // ④ remote runtimes: single subscriber — preload dispatches each push
  // channel to the LATEST subscriber only (same rule as kanban above).
  const [runtimes, setRuntimes] = useState<SettingsRuntime[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const openSettings = useCallback((section: SettingsSection = 'general') => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  const [addFromRuntime, setAddFromRuntime] = useState<SettingsRuntime | null>(null)
  // Update-check subscription is owned HERE (single-subscriber rule): the
  // sidebar badge renders from the result, Settings > Updates drives actions.
  const updateCheck = useUpdateCheck()

  const refreshProjects = useCallback(async () => {
    setProjects(await window.pi.projects.list())
  }, [])

  const refreshRuntimes = useCallback(async () => {
    setRuntimes(await window.pi.settings.list())
  }, [])
  useEffect(() => {
    void refreshRuntimes()
    return window.pi.settings.onChanged(() => {
      void refreshRuntimes()
      // Connection flips change per-project availability projections too.
      void refreshProjects()
    })
  }, [refreshRuntimes, refreshProjects])

  const refreshSessions = useCallback(async (projectPath: string) => {
    // The tracked list is fetched alongside so sessions created/opened since
    // the last pull (main registers them on start) appear immediately.
    const [list, tracked] = await Promise.all([
      window.pi.sessions.list(projectPath),
      window.pi.sessions.tracked(projectPath),
    ])
    // Keep object identity for unchanged rows: sidebar rows are memoized and
    // re-executing 178 rows per 500ms refresh (or per streaming flush) is the
    // renderer's second-biggest CPU item after the transcript itself.
    setSessionsByPath((prev) => {
      const old = prev[projectPath]
      if (!old) return { ...prev, [projectPath]: list }
      const byFile = new Map(old.map((s) => [s.filePath, s]))
      return {
        ...prev,
        [projectPath]: list.map((s) => {
          const o = byFile.get(s.filePath)
          return o && o.title === s.title && o.updatedAt === s.updatedAt && o.messageCount === s.messageCount ? o : s
        }),
      }
    })
    setTrackedByPath((prev) => ({ ...prev, [projectPath]: tracked }))
  }, [])

  const runBootCheck = useCallback(async () => {
    setBoot('loading')
    try {
      const m = await window.pi.app.getMeta()
      setMeta(m)
      setBoot(m.piPath ? 'ready' : 'setup')
      // Projects load as part of boot; the main UI stays empty without this.
      if (m.piPath) await refreshProjects()
    } catch {
      setBoot('setup')
    }
  }, [refreshProjects])

  useEffect(() => {
    void runBootCheck()
  }, [runBootCheck])

  // Lazily fetch each known project's task list once.
  useEffect(() => {
    for (const p of projects) {
      if (sessionsByPath[p.path] === undefined) void refreshSessions(p.path)
    }
  }, [projects, sessionsByPath, refreshSessions])

  // Live session list updates for the open project when PI appends entries.
  useEffect(() => {
    if (!activeProject) return
    const unsubscribe = window.pi.sessions.onChanged(() => {
      void refreshSessions(activeProject.path)
    })
    return unsubscribe
  }, [activeProject, refreshSessions])

  // "工作中 · mm:ss" ticker for the transcript activity divider.
  useEffect(() => {
    if (active?.status === 'running') {
      const timer = setInterval(() => {
        setElapsedSec(active.startedAt ? Math.floor((Date.now() - active.startedAt) / 1000) : 0)
      }, 1000)
      return () => clearInterval(timer)
    }
    setElapsedSec(0)
  }, [active?.status, active?.startedAt])

  const pickProject = useCallback(async () => {
    const record = await window.pi.app.pickProject()
    if (!record) return
    await refreshProjects()
    setActiveProject(record)
    await refreshSessions(record.path)
  }, [refreshProjects, refreshSessions])

  // ④: add a project discovered on a remote runtime (projects.addOn).
  const addProjectOnRuntime = useCallback(
    async (path: string, runtimeId: string) => {
      await window.pi.projects.addOn(path, runtimeId)
      await refreshProjects()
    },
    [refreshProjects],
  )

  const openProject = useCallback(async (project: ProjectRecord) => {
    // A draft prewarmed for another project is stale; drop it so the effect
    // below prewarms for the newly selected one.
    prewarmRef.current = null
    setActiveProject(project)
    // Always refresh (not just when uncached) so the main process moves its
    // session watcher to the newly selected project.
    await refreshSessions(project.path)
  }, [refreshSessions])

  const openSession = useCallback(async (session: SessionRecord) => {
    setMainView('session')
    setComposingNew(false)    // Already live in the pool: just switch foreground, never restart it.
    for (const [rid, s] of pool.sessions) {
      if (s.runtime?.sessionFile === session.filePath) {
        pool.switchActive(rid)
        const project = projects.find((p) => p.path === session.projectPath)
        if (project) setActiveProject(project)
        return
      }
    }
    // A start for this session is already in flight (double-click, rapid
    // switching); starting again would only duplicate work.
    if (pool.pendingStart?.sessionPath === session.filePath) return
    // Pooling: other runtimes keep running in the background; main
    // re-attaches to the target session's live runtime or spawns one.
    const project = projects.find((p) => p.path === session.projectPath)
    if (project) setActiveProject(project)
    await pool.start({ projectPath: session.projectPath, sessionPath: session.filePath })
    await refreshSessions(session.projectPath)
  }, [pool, projects, refreshSessions])

  // Gentle nudge instead of a dead end: with no project selected, new-task
  // attempts point the user at the composer's project selector (no native
  // folder dialog is sprung on them).
  const [projectNudge, setProjectNudge] = useState(0)
  // True while a "新建任务" draft is open: the transcript is replaced by the
  // home surface and the PI runtime is NOT spawned until the first message
  // is actually sent (lazy start keeps new-task entry instant).
  const [composingNew, setComposingNew] = useState(false)
  // The optimistic first message of a draft send: while the PI runtime
  // spawns, the session page (user bubble + starting composer) is already on
  // screen instead of a standalone loading page.
  // First dispatch of a brand-new task, kept optimistically on screen (text +
  // pasted images) while the runtime spawns and the real transcript attaches.
  const [startingMessage, setStartingMessage] = useState<{ text: string; images: PromptImage[] } | null>(null)
  // Set when the user hits stop while the first dispatch is still spawning:
  // startFromHome checks it as soon as start resolves and tears the fresh
  // runtime down instead of sending.
  const cancelStartRef = useRef(false)
  // In-flight/finished prewarm of the new-task page: the draft's PI runtime
  // starts in the background so models load and the first send is instant.
  const prewarmRef = useRef<Promise<RuntimeInfo | null> | null>(null)
  // The one persistent composer's text and focus signal — the composer is
  // never remounted across draft → spawning → live transitions.
  const [draft, setDraft] = useState('')
  const [composerFocus, setComposerFocus] = useState(0)

  const newSession = useCallback(() => {
    // Board view unmounts the composer, so the old "just nudge" path for a
    // missing project left the user stranded on the board (nothing visibly
    // happened). Always open the draft surface; without a project the
    // composer's selector gets the hint, and sending still requires one.
    if (!activeProject) setProjectNudge((n) => n + 1)
    setMainView('session')
    setComposingNew(true)
    setComposerFocus((k) => k + 1)
  }, [activeProject])

  // Home composer: the typed text itself starts a fresh session; without a
  // selected project it keeps the draft and nudges the project selector.
  // Priority: consume the prewarmed draft runtime (background-started when
  // the new-task page opened) so the first send is instant — but only after
  // revalidating it: a prewarm that was evicted, stopped, or already
  // dispatched must fall back to a fresh start instead of sending into a
  // dead runtime or into the background. The view follows the runtime the
  // message actually lands on (switchActive), so a stale activeId can never
  // leave the sent message on an invisible session.
  const startFromHome = useCallback(async (text: string, images: PromptImage[] = []): Promise<boolean> => {
    if (!activeProject) {
      setProjectNudge((n) => n + 1)
      return false
    }
    const optimistic = { text, images }
    // Claim the sending surface BEFORE any await: the prewarm effect refires
    // on every commit where the hero is up and prewarmRef is empty. Consuming
    // prewarmRef (below) opens exactly such a window during the first await —
    // the effect then spawns a competing draft runtime whose start resolves
    // later and steals activeId, yanking the page back to the draft surface
    // while the real conversation runs invisibly. startingMessage is the
    // effect's first guard, so setting it here closes the window.
    setStartingMessage(optimistic)
    const prewarmed = prewarmRef.current
    if (prewarmed) {
      prewarmRef.current = null
      const info = await prewarmed
      // Consumption revalidation (draftDecision.judgePrewarm): the prewarmed
      // runtime must still be a live blank draft for this project — evicted,
      // dispatched, or rebound-to-a-session prewarms fall through to a fresh
      // start instead of sending into a dead or stolen runtime.
      const verdict = judgePrewarm(info, info ? pool.sessions.get(info.runtimeId) : undefined, activeProject.path)
      if (verdict.ok) {
        setComposingNew(false)
        pool.switchActive(verdict.runtimeId)
        try {
          await pool.send(verdict.runtimeId, text, 'prompt', images)
          return true
        } finally {
          setStartingMessage(null)
          // The session file only exists once the runtime has started; list after.
          void refreshSessions(activeProject.path)
        }
      }
    }
    if (composingNew && isInertDraft(active, activeProject.path)) {
      setComposingNew(false)
      try {
        await pool.send(active.runtime.runtimeId, text, 'prompt', images)
        return true
      } finally {
        setStartingMessage(null)
        void refreshSessions(activeProject.path)
      }
    }
    // Leave draft mode and land on the session page immediately; the typed
    // message renders there optimistically while the runtime spawns
    // (startingMessage is already claimed above, before the first await).
    setComposingNew(false)
    try {
      const info = await pool.start({ projectPath: activeProject.path })
      // Stop clicked while spawning: don't send; recycle the fresh runtime
      // and let the composer restore the draft text (false → restore).
      if (cancelStartRef.current) {
        cancelStartRef.current = false
        void pool.stop(info.runtimeId)
        return false
      }
      await pool.send(info.runtimeId, text, 'prompt', images)
      return true
    } finally {
      setStartingMessage(null)
      // The session file only exists once the runtime has started; list after.
      void refreshSessions(activeProject.path)
    }
  }, [activeProject, composingNew, active, pool, refreshSessions])

  // Prewarm whenever the home surface is up with a project selected — the
  // landing page after picking a project, not just an explicit new-task
  // draft. The draft's PI runtime starts in the background so the
  // model/thinking chips load before the first send; shouldStartPrewarm
  // (draftDecision) keeps it from double-starting or re-prewarming an
  // already-warm empty runtime.
  useEffect(() => {
    const path = activeProject?.path
    if (!path) return
    if (
      !shouldStartPrewarm({
        startingMessageActive: startingMessage !== null,
        hydrating: !!active?.hydrating,
        startInFlight: pool.pendingStart != null,
        prewarmInFlight: prewarmRef.current != null,
        homeSurfaceUp: isHomeSurfaceUp(active, composingNew),
        warmDraftAlready: isInertDraft(active, path),
      })
    ) {
      return
    }
    prewarmRef.current = pool.start({ projectPath: path }).catch(() => null)
  }, [startingMessage, active, composingNew, activeProject, pool])

  // "+" on a project row: open a new-task draft whose cwd is THAT project;
  // the runtime spawns when the first message is sent.
  const newTaskForProject = useCallback((project: ProjectRecord) => {
    setActiveProject(project)
    setMainView('session')
    setComposingNew(true)
    setComposerFocus((k) => k + 1)
  }, [])

  // Changing the default model cannot reach pi runtimes already spawned: pi
  // reads settings.json once per process at boot. The warm new-task draft is
  // exactly such a runtime, so push the new default into any inert draft;
  // prewarmed-but-unadopted pool entries are retired daemon-side at adoption
  // (daemon/agent.ts defaultModelChangedSince).
  const onDefaultModelChanged = useCallback((provider: string, modelId: string) => {
    for (const s of pool.sessions.values()) {
      if (isInertDraft(s)) void pool.setModel(s.runtime.runtimeId, provider, modelId).catch(() => undefined)
    }
  }, [pool])

  // Board → transcript jump for a worker session (card drawer / note links).
  // The card knows its project (card.projectPath); a minimal record is enough:
  // openSession keys on filePath/projectPath and re-anchors activeProject.
  const jumpToSession = useCallback((projectPath: string, sessionFile: string) => {
    const base = sessionFile.split('/').pop() ?? sessionFile
    void openSession({
      id: base.replace(/\.jsonl$/, ''),
      filePath: sessionFile,
      projectPath,
      title: base,
      createdAt: '',
      updatedAt: '',
      status: 'unknown',
    })
  }, [openSession])

  // ⌘N / Ctrl+N starts a new task in the current project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void newSession()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession])

  // Rename on the file (session_info record) first; then sync PI's in-memory
  // name if the session happens to be live.
  const renameSession = useCallback(async (session: SessionRecord, name: string) => {
    await window.pi.sessions.rename(session.filePath, name, session.projectPath)
    await refreshSessions(session.projectPath)
    for (const [rid, s] of pool.sessions) {
      if (s.runtime?.sessionFile === session.filePath) void pool.renameSession(rid, name)
    }
  }, [pool, refreshSessions])

  // Archive flips the tracked registry only; the session file stays on disk
  // and returns to the regular list when opened or unarchived.
  const archiveSession = useCallback(async (session: SessionRecord) => {
    await window.pi.sessions.archive(session.filePath, session.projectPath)
    await refreshSessions(session.projectPath)
  }, [refreshSessions])

  const unarchiveSession = useCallback(async (session: SessionRecord) => {
    await window.pi.sessions.track(session.projectPath, session.filePath)
    await refreshSessions(session.projectPath)
  }, [refreshSessions])

  const removeProject = useCallback(async (project: ProjectRecord) => {
    await window.pi.projects.remove(project.id)
    if (activeProject?.path === project.path) setActiveProject(null)
    await refreshProjects()
  }, [activeProject, refreshProjects])

  const activeSessions = activeProject ? sessionsByPath[activeProject.path] ?? [] : []
  // A new-task draft is not "viewing" the previous session: it keeps running
  // in the pool, but the title drops to the project name and the sidebar
  // drops its row highlight until the draft is sent or a session is opened
  // (draftDecision.resolveViewedSessionFile).
  const activeSessionPath = resolveViewedSessionFile(
    composingNew,
    active,
    pool.pendingStart?.sessionPath,
  )

  // Back/forward over view transitions (session ↔ board ↔ home). A location
  // is just the two top-level states; entries whose session has since been
  // removed are skipped instead of blocking navigation.
  const [nav, setNav] = useState<{ stack: { view: 'session' | 'board'; path: string | null }[]; idx: number }>({
    stack: [{ view: 'session', path: null }],
    idx: 0,
  })
  useEffect(() => {
    const loc = { view: mainView, path: mainView === 'board' ? null : activeSessionPath ?? null }
    setNav(({ stack, idx }) => {
      const cur = stack[idx]
      // Applying a history entry re-enters here with an unchanged location: no push.
      if (cur && cur.view === loc.view && cur.path === loc.path) return { stack, idx }
      return { stack: [...stack.slice(0, idx + 1), loc], idx: idx + 1 }
    })
  }, [mainView, activeSessionPath])
  const navGo = (dir: -1 | 1) => {
    const { stack, idx } = nav
    const next = idx + dir
    if (next < 0 || next >= stack.length) return
    const target = stack[next]
    if (target.view === 'board') {
      setMainView('board')
    } else {
      // path=null is the home surface (no session) — a legal destination.
      setMainView('session')
      if (target.path) {
        const rec = Object.values(sessionsByPath).flat().find((s) => s.filePath === target.path) ?? null
        if (!rec) return // target session no longer exists — stay put
        void openSession(rec)
      }
    }
    setNav({ stack, idx: next })
  }
  // Per-session running/unread state keyed by session file, so the sidebar
  // can show a spinner on background runs and a badge on finished-but-unseen
  // ones — not just the foreground session.
  const sessionStatusByFile: Record<string, { running: boolean; unread: boolean }> = {}
  for (const s of pool.sessions.values()) {
    const file = s.runtime?.sessionFile ?? s.lastStart?.sessionPath
    if (file) sessionStatusByFile[file] = { running: s.status === 'running', unread: s.unread }
  }
  const activeRecord = activeSessions.find((s) => s.filePath === activeSessionPath)
  const title = activeRecord?.title || activeProject?.name || ''

  const pendingRuntimeId = active?.runtime && !composingNew ? active.runtime.runtimeId : null
  const pendingRequest = pendingRuntimeId ? active?.interactive[0] : undefined
  // Correlate a pending select/input prompt with a running ask_user_question
  // tool call so the card can show "question k of N" and the upcoming questions.
  const pendingMethod = (pendingRequest?.event as { method?: string } | undefined)?.method
  const pendingTitle = ((pendingRequest?.event as { title?: string; message?: string } | undefined)?.title
    ?? (pendingRequest?.event as { message?: string } | undefined)?.message) ?? ''
  const questionnaire =
    pendingRequest && (pendingMethod === 'select' || pendingMethod === 'input')
      ? findQuestionnaire(active?.transcript ?? [], pendingTitle)
      : null

  // Auto-answer the extension's "Type your answer:" follow-up input with the
  // text already typed into the sentinel's input box. Stash expires so a
  // follow-up that never arrives can't hijack a later, unrelated input.
  const customAnswerRef = useRef<{ runtimeId: string; text: string; at: number } | null>(null)
  useEffect(() => {
    const stash = customAnswerRef.current
    if (!stash) return
    if (Date.now() - stash.at > 15_000) {
      customAnswerRef.current = null
      return
    }
    if (!pendingRequest || !pendingRuntimeId || stash.runtimeId !== pendingRuntimeId) return
    if ((pendingRequest.event as { method?: string }).method !== 'input') return
    customAnswerRef.current = null
    void pool.respondExtension(pendingRuntimeId, (pendingRequest.event as { id: string }).id, { value: stash.text })
  }, [pendingRequest, pendingRuntimeId, pool])

  // Todo list docked above the composer: the last `todo` tool snapshot of the
  // active session. Hidden on the new-task draft so a finished task's list
  // doesn't hover over a fresh draft.
  const todos = useMemo(() => (composingNew ? [] : deriveTodoState(active?.transcript ?? [])), [composingNew, active?.transcript])

  // pi-plan-mode reports through setStatus("plan-mode", "plan active" | …);
  // surface the first non-empty plan-ish status for the composer pill.
  const planStatus = (() => {
    for (const [key, value] of Object.entries(active?.statuses ?? {})) {
      if (key.includes('plan') && value) return value
    }
    return null
  })()

  const crashed = !composingNew && !!active?.crashed

  // The active runtime is an untouched prewarm (no session file, no messages,
  // no dispatch in flight — draftDecision.isInertDraft): the home surface and
  // draft composer stay up around it instead of collapsing into an empty
  // transcript view. A runtime that has received ANY dispatch is no longer a
  // draft — extension commands like /plan stream no transcript events, so
  // emptiness alone would otherwise trap the page on the home surface forever.
  const draftRuntime = startingMessage === null && isInertDraft(active)

  // Home hero: greeting + starter chips in the space above the composer.
  // Shown whenever no conversation is on screen — landing (with or without a
  // prewarmed draft runtime) or a new-task draft. While the runtime spawns
  // for a fresh task it stays up so the page never blanks out; for a history
  // session open (pendingStart with a session file) it yields.
  const homeHero =
    startingMessage === null &&
    !active?.hydrating &&
    !pool.pendingStart?.sessionPath &&
    isHomeSurfaceUp(active, composingNew) && (
    <Home
      crashed={crashed}
      onRestore={() => pool.activeId && void pool.restart(pool.activeId)}
      onStarter={(prompt) => {
        setDraft(prompt)
        setComposerFocus((k) => k + 1)
      }}
    />
  )

  // Draft send, spawn window: only the conversation area is pending — the
  // typed message already renders as a user bubble, and the persistent
  // composer below keeps its place (send button spinning). The bubble stays
  // up until the real transcript has content (runtime attach + first event
  // is a handoff, not a blank flash); for extension-intercepted commands
  // (/plan) nothing is ever recorded, so it correctly disappears when the
  // dispatch resolves.
  const startingTranscript = startingMessage !== null && (!active || active.transcript.length === 0) && (
    <Transcript
      key="pending-first"
      sessionKey={null}
      messages={[{
        id: 'pending-first',
        role: 'user',
        parts: [
          { type: 'text', text: startingMessage.text },
          ...startingMessage.images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
        ],
      }]}
    />
  )

  // Startup gate: hold the splash (or setup guide) until PI checks out.
  if (boot !== 'ready') {
    return (
      <div className="grid h-full place-items-center bg-canvas text-ink">
        <BootScreen phase={boot} problem={meta?.problem?.reason} onRecheck={() => void runBootCheck()} />
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden bg-canvas text-ink">
      <div
        className={cn(
          'h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
          sidebarOpen ? 'w-[300px]' : 'w-0',
        )}
      >
        <Sidebar
          meta={meta}
          projects={projects}
          sessionsByPath={sessionsByPath}
          trackedFilesByPath={trackedByPath}
          activeProjectPath={activeProject?.path ?? null}
          activeSessionPath={activeSessionPath}
          sessionStatusByFile={sessionStatusByFile}
          onPickProject={() => void pickProject()}
          onAddFromRuntime={(r) => setAddFromRuntime(r)}
          onOpenSettings={openSettings}
          updateResult={updateCheck.result}
          runtimes={runtimes}
          onOpenProject={(p) => void openProject(p)}
          onOpenSession={openSession}
          onNewTask={() => void newSession()}
          boardActive={mainView === 'board'}
          boardReviewCount={kanbanBoards.allCards.filter((c) => c.status === 'review' && !c.archived).length}
          onToggleBoard={() => setMainView((v) => (v === 'board' ? 'session' : 'board'))}
          onNewTaskForProject={(p) => void newTaskForProject(p)}
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onUnarchiveSession={unarchiveSession}
          onRemoveProject={(p) => void removeProject(p)}
          onCollapse={() => setSidebarOpen(false)}
          navBack={nav.idx > 0}
          navForward={nav.idx < nav.stack.length - 1}
          onNavBack={() => navGo(-1)}
          onNavForward={() => navGo(1)}
        />
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* The session titlebar is not part of the board surface. */}
        {mainView !== 'board' && (
          <SessionHeader
            sidebarOpen={sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            navBack={nav.idx > 0}
            navForward={nav.idx < nav.stack.length - 1}
            onNavBack={() => navGo(-1)}
            onNavForward={() => navGo(1)}
            title={title}
            project={activeProject}
          />
        )}

        {mainView === 'board' ? (
          <BoardView projects={projects} runtimes={runtimes} kanban={kanbanBoards} onViewSession={jumpToSession} />
        ) : (
          <>
        {homeHero}
        {startingTranscript}
        {/* The real transcript yields while the optimistic first-message
            bubble covers the empty window (both are flex-1; mounting both
            would split the height and shove the bubble to the middle). An
            exited session keeps its transcript on screen too — the runtime
            is gone but the conversation must stay visible. */}
        {activeProject && (active?.runtime || active?.exited) && !active.hydrating && !pool.pendingStart && !composingNew && !(startingMessage !== null && active.transcript.length === 0) && (active.transcript.length > 0 || active.status !== 'idle' || active.lastDispatchAt != null) && (
          <Transcript
            key={activeSessionPath ?? 'none'}
            sessionKey={activeSessionPath}
            messages={active.transcript}
            running={active.status === 'running'}
            elapsedSec={elapsedSec}
            completedMs={active.lastRunMs ?? undefined}
          />
        )}

        {/* The composer is independent of the conversation state: the same
            instance serves the new-task draft, the runtime spawn window, and
            the live session, docked at the bottom the whole time. mt-auto
            pins it down even when no flex-1 surface (hero/transcript) is
            mounted above — the session-switch/load gap windows. */}
        <TodoPanel todos={todos} />
        <div className="relative mt-auto shrink-0">
            {/* Question-style prompts float above the composer; modal
                prompts portal out of this layer to the screen center. */}
            {pendingRequest && pendingRuntimeId && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-full max-w-3xl -translate-x-1/2">
                <div className="pointer-events-auto">
                  <ExtensionPrompt
                    key={(pendingRequest.event as { id: string }).id}
                    request={pendingRequest}
                    questionnaire={questionnaire}
                    onCustomAnswer={(text) => {
                      if (pendingRuntimeId) customAnswerRef.current = { runtimeId: pendingRuntimeId, text, at: Date.now() }
                    }}
                    onRespond={(response) => void pool.respondExtension(
                      pendingRuntimeId,
                      (pendingRequest.event as { id: string }).id,
                      response,
                    )}
                  />
                </div>
              </div>
            )}
            <Composer
              mode={composingNew || !active?.runtime || draftRuntime ? 'draft' : 'live'}
              status={active?.status ?? (pool.pendingStart ? 'starting' : 'idle')}
              runtime={active?.runtime ?? null}
              draft={draft}
              onDraftChange={setDraft}
              onSend={(text, intent, images) => {
                if (!composingNew && active?.runtime) {
                  return pool.send(active.runtime.runtimeId, text, intent, images).then(() => true)
                }
                // An exited session's transcript is on screen: resume the same
                // conversation file instead of forking a blank new task.
                if (!composingNew && active?.exited && active.lastSessionFile && activeProject) {
                  // Images only ride on prompt, so they force a fresh prompt
                  // instead of the queued intent.
                  const resumeIntent = images?.length ? 'prompt' as const : intent
                  return pool.start({ projectPath: activeProject.path, sessionPath: active.lastSessionFile })
                    .then((info) => pool.send(info.runtimeId, text, resumeIntent, images))
                    .then(() => true)
                }
                return startFromHome(text, images)
              }}
              onAbort={() => {
                if (active?.runtime) void pool.abort(active.runtime.runtimeId)
                else if (startingMessage !== null) cancelStartRef.current = true
              }}
              pendingDispatch={startingMessage !== null && !active?.runtime}
              onSetModel={(provider, modelId) =>
                active?.runtime ? pool.setModel(active.runtime.runtimeId, provider, modelId) : Promise.resolve()}
              onSetThinkingLevel={(level) =>
                active?.runtime ? pool.setThinkingLevel(active.runtime.runtimeId, level) : Promise.resolve()}
              onGetModels={() =>
                active?.runtime ? pool.getAvailableModels(active.runtime.runtimeId) : Promise.resolve([])}
              onGetThinkingLevels={() =>
                active?.runtime ? pool.getAvailableThinkingLevels(active.runtime.runtimeId) : Promise.resolve([])}
              onGetCommands={() =>
                active?.runtime ? pool.getAvailableCommands(active.runtime.runtimeId) : Promise.resolve([])}
              planStatus={composingNew ? null : planStatus}
              projects={projects}
              activeProject={activeProject}
              nudgeSignal={projectNudge}
              onSelectProject={(p) => void openProject(p)}
              onBrowseProjects={() => void pickProject()}
              focusKey={composerFocus}
            />
        </div>
          </>
        )}

        {(active?.error ?? pool.error) && (
          <div className="border-t-[0.5px] border-bad/30 bg-tint-bad px-4 py-2 text-xs text-bad">{ue(active?.error ?? pool.error)}</div>
        )}
      </main>
      <ImageLightbox />
      {settingsOpen && (
        <SettingsDialog
          meta={meta}
          runtimes={runtimes}
          onRefresh={() => refreshRuntimes()}
          initialSection={settingsSection}
          update={updateCheck}
          onDefaultModelChanged={onDefaultModelChanged}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {addFromRuntime && (
        <RemoteAddDialog runtime={runtimes.find((r) => r.id === addFromRuntime.id) ?? addFromRuntime} onAdd={addProjectOnRuntime} onClose={() => setAddFromRuntime(null)} />
      )}
    </div>
  )
}
