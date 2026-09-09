import { useEffect, useState, useRef, useCallback } from 'react'
import type { AgentStartOptions, PiAvailableModel, PiCommandInfo, PiEventEnvelope, PromptImage, RuntimeInfo } from '@/types'
import { applyEvent, createTranscript, hydrateTranscript, needsHistoryHydration, type TranscriptMessage } from '@/lib/eventReducer'
import { useI18n } from '@/i18n'

export type RuntimeStatus = 'idle' | 'running' | 'starting' | 'stopping' | 'error'

export interface NotifyEntry {
  id: string
  message: string
  notifyType: string
}

export interface SessionState {
  transcript: TranscriptMessage[]
  runtime: RuntimeInfo | null
  status: RuntimeStatus
  error: string | null
  statuses: Record<string, string>
  notifies: NotifyEntry[]
  interactive: PiEventEnvelope[]
  crashed: boolean
  // True while the transcript is being re-read from disk; the UI holds one
  // loading surface instead of flashing an empty transcript.
  hydrating: boolean
  // True when a run finished while this session was in the background, so the
  // sidebar can badge it until the user foregrounds it again.
  unread: boolean
  // Last start options, so a crashed session can be restarted in place.
  lastStart: AgentStartOptions | null
  // Wall-clock start of the current run; drives the elapsed display.
  startedAt: number | null
  // Duration of the last completed run; drives the "工作完成" tail marker.
  // Per-output, not session-global: reset on agent_start and on crash.
  lastRunMs: number | null
  // Set on the first dispatched prompt. Slash commands intercepted by
  // extensions produce no transcript events at all, so "transcript is empty"
  // cannot be used to decide the home/draft surface once anything was sent.
  lastDispatchAt: number | null
  // The session file this conversation was writing to, kept after the runtime
  // is gone so a follow-up message resumes the same conversation on disk.
  lastSessionFile: string | null
  // True when this session's runtime was stopped by the app (pool stop or LRU
  // eviction) while the conversation stays on screen; the transcript is kept
  // and the next send resumes the session file instead of a blank page.
  exited: boolean
}

function defaultSessionState(): SessionState {
  return {
    transcript: createTranscript(),
    runtime: null,
    status: 'idle',
    error: null,
    statuses: {},
    notifies: [],
    interactive: [],
    crashed: false,
    hydrating: false,
    unread: false,
    lastStart: null,
    startedAt: null,
    lastRunMs: null,
    lastDispatchAt: null,
    lastSessionFile: null,
    exited: false,
  }
}

// Interactive methods block the agent until a response; notify/setStatus/setWidget do not.
const INTERACTIVE_METHODS = new Set(['confirm', 'input', 'select', 'editor'])

// Strip ANSI SGR escapes so extension status text renders as plain text.
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(value: unknown): string {
  return typeof value === 'string' ? value.replace(ANSI_RE, '') : ''
}

// Pool of per-runtime session states. Every PI event is routed by its
// envelope.runtimeId to that runtime's own SessionState, so pooled runtimes
// keep streaming in the background while only `activeId` is on screen.
export function useSessionPool() {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<Map<string, SessionState>>(() => new Map())
  const [activeId, setActiveId] = useState<string | null>(null)
  // Set while an agent.start call is in flight (no runtimeId exists yet).
  const [pendingStart, setPendingStart] = useState<AgentStartOptions | null>(null)
  // Start failures have no runtimeId to hang the error on; pool-level.
  const [error, setError] = useState<string | null>(null)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  // Patch one session immutably (new Map + new state object for StrictMode).
  const patchSession = useCallback((runtimeId: string, patch: (s: SessionState) => SessionState) => {
    setSessions((prev) => {
      const s = prev.get(runtimeId)
      if (!s) return prev
      const next = new Map(prev)
      next.set(runtimeId, patch(s))
      return next
    })
  }, [])

  // Subscribe to the agent event stream for the lifetime of the hook. Events
  // for a runtime not yet known (bootstrap race) lazily create its state.
  useEffect(() => {
    // Streaming CPU is paint-bound: per-token setState → DOM mutation →
    // layout/paint/raster costs far more than the JS itself. Buffer
    // message_update deltas and flush at ~10fps; every other event type
    // flushes the buffer first so ordering is preserved.
    let pending: Array<{ rid: string; event: Record<string, unknown> & { type: string } }> = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const applyOne = (rid: string, event: Record<string, unknown> & { type: string }, envelope?: PiEventEnvelope) => {
      setSessions((prev) => {
        // Expected exit (stop/pool evict). An empty state is a discarded
        // prewarm or cancelled start — drop it. A session the user talked to
        // keeps its transcript with `exited` set: the runtime is gone, but
        // the page must not yank back to the home surface and the next send
        // resumes the same session file.
        if (event.type === 'runtime_exit' && event.expected === true) {
          const s = prev.get(rid)
          if (!s) return prev
          const next = new Map(prev)
          if (s.transcript.length === 0 && s.lastDispatchAt == null) {
            next.delete(rid)
          } else {
            next.set(rid, {
              ...s,
              runtime: null,
              status: 'idle',
              lastSessionFile: s.runtime?.sessionFile ?? s.lastSessionFile,
              exited: true,
            })
          }
          return next
        }
        const next = new Map(prev)
        const s = next.get(rid) ?? defaultSessionState()
        const ns: SessionState = { ...s }
        if (event.type === 'extension_ui_request') {
          const method = event.method as string
          const id = event.id as string
          if (INTERACTIVE_METHODS.has(method)) {
            // Blocks until answered; queue for the response surface.
            if (!s.interactive.some((e) => (e.event as { id: string }).id === id)) {
              ns.interactive = [...s.interactive, envelope!]
            }
          } else if (method === 'notify') {
            // Fire-and-forget; dismissable locally, no round-trip required.
            ns.notifies = [...s.notifies, { id, message: String(event.message ?? ''), notifyType: String(event.notifyType ?? 'info') }]
          } else if (method === 'setStatus') {
            ns.statuses = { ...s.statuses, [String(event.statusKey ?? '')]: stripAnsi(event.statusText) }
          }
          // setWidget registers a widget surface; the MVP has no widget host,
          // so it is acknowledged silently rather than blocking.
          next.set(rid, ns)
          return next
        }
        // applyEvent must stay copy-on-write pure: React StrictMode invokes
        // this updater more than once with the same prev, and any mutation
        // of shared rows/parts duplicates streamed deltas on screen. The
        // clock is captured once per event so both invocations agree.
        const transcript = s.transcript.slice()
        applyEvent(transcript, event, { now: Date.now() })
        ns.transcript = transcript
        if (event.type === 'agent_start') {
          ns.status = 'running'
          ns.startedAt = Date.now()
          ns.lastRunMs = null
        } else if (event.type === 'agent_settled') {
          ns.status = 'idle'
          // Per-output completion: the tail marker becomes "工作完成 · <dur>"
          // using this run's own start→settle window.
          ns.lastRunMs = s.startedAt ? Date.now() - s.startedAt : null
          // Badge sessions that finished in the background; a foreground run
          // that settled stays read (the user was watching it).
          if (activeIdRef.current !== rid) ns.unread = true
        } else if (event.type === 'runtime_exit') {
          // Crash: keep the transcript so the user can see where it died.
          ns.status = 'error'
          ns.runtime = null
          ns.crashed = true
          ns.lastSessionFile = s.runtime?.sessionFile ?? s.lastSessionFile
          ns.lastRunMs = null
        } else if (event.type === 'transport_error') {
          ns.status = 'error'
          ns.error = String(event.error ?? '')
          ns.lastRunMs = null
        }
        next.set(rid, ns)
        return next
      })
    }
    const flush = () => {
      flushTimer = undefined
      const batch = pending
      pending = []
      for (const { rid, event } of batch) applyOne(rid, event)    }
    const unsubscribe = window.pi.agent.onEvent((envelope: PiEventEnvelope) => {
      const rid = envelope.runtimeId
      const event = envelope.event as Record<string, unknown> & { type: string }
      if (event.type === 'message_update') {
        pending.push({ rid, event })
        flushTimer ??= setTimeout(flush, 100)
        return
      }
      if (pending.length) {
        clearTimeout(flushTimer)
        flush()
      }
      applyOne(rid, event, envelope)
    })
    return () => {
      unsubscribe()
      if (flushTimer != null) clearTimeout(flushTimer)
    }
  }, [])

  // Bootstrap: adopt runtimes that survived an app restart, hydrating each
  // from its session file so background sessions reappear with history.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let runtimes: RuntimeInfo[]
      try {
        runtimes = await window.pi.agent.list()
      } catch {
        return
      }
      for (const info of runtimes) {
        if (cancelled) return
        patchSession(info.runtimeId, (s) => ({
          ...s,
          runtime: info,
          status: info.isStreaming ? 'running' : 'idle',
        }))
        const s0 = sessionsRef.current.get(info.runtimeId)
        const hydrate = needsHistoryHydration(s0, info.sessionFile)
        if (hydrate && info.sessionFile) {
          const replaceTail = (s0?.transcript.length ?? 0) > 0
          try {
            const { messages } = await window.pi.sessions.read(info.sessionFile, info.runtimeId)
            if (cancelled) return
            const hydrated = hydrateTranscript(messages)
            // Live events may land during the read; they continue the same
            // rows the disk tail holds, so replace (tail-only background
            // entries) rather than only filling an empty transcript.
            patchSession(info.runtimeId, (s) =>
              s.transcript.length === 0 || replaceTail ? { ...s, transcript: hydrated } : s,
            )
          } catch {
            /* best-effort; live events will still stream in */
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [patchSession])

  const start = useCallback(async (options: AgentStartOptions) => {
    setPendingStart(options)
    setError(null)
    try {
      // Main reuses the pooled runtime when this session is already live, so
      // this returns immediately for a re-attach instead of respawning PI.
      const info = await window.pi.agent.start(options)
      const existing = sessionsRef.current.get(info.runtimeId)
      // Re-attach to a live pooled runtime keeps its in-memory transcript;
      // never-hydrated and background-only entries read the session JSONL
      // (needsHistoryHydration: a runtime the pool never started — kanban
      // review-comment forward / background dispatch — materializes from
      // bare events and holds only the streamed tail, never the history).
      const shouldHydrate = needsHistoryHydration(existing, options.sessionPath)
      const replaceTail = shouldHydrate && existing != null && existing.transcript.length > 0
      setSessions((prev) => {
        const next = new Map(prev)
        const s = next.get(info.runtimeId) ?? defaultSessionState()
        next.set(info.runtimeId, {
          ...s,
          runtime: info,
          status: info.isStreaming ? 'running' : 'idle',
          error: null,
          crashed: false,
          hydrating: shouldHydrate,
          lastStart: options,
          lastSessionFile: info.sessionFile ?? s.lastSessionFile,
          startedAt: info.isStreaming ? (s.startedAt ?? Date.now()) : s.startedAt,
          exited: false,
        })
        return next
      })
      // send()/abort() guard on sessionsRef, and the first command after a
      // fresh start fires before React flushes the update above — lead the
      // ref ahead so the guard already sees the new runtime.
      sessionsRef.current = new Map(sessionsRef.current)
      sessionsRef.current.set(info.runtimeId, {
        ...(sessionsRef.current.get(info.runtimeId) ?? defaultSessionState()),
        runtime: info,
        status: info.isStreaming ? 'running' : 'idle',
      })
      setActiveId(info.runtimeId)
      activeIdRef.current = info.runtimeId
      // Foregrounding a freshly started/reattached session reads it as seen.
      patchSession(info.runtimeId, (s) => (s.unread ? { ...s, unread: false } : s))
      if (shouldHydrate && options.sessionPath) {
        try {
          const { messages } = await window.pi.sessions.read(options.sessionPath, info.runtimeId)
          const hydrated = hydrateTranscript(messages)
          // Live events may have landed during the read; when the entry was
          // background-only they are a tail the disk already contains —
          // replace with full history; otherwise memory stays newer.
          patchSession(info.runtimeId, (s) =>
            s.transcript.length === 0 || replaceTail
              ? { ...s, transcript: hydrated, hydrating: false }
              : { ...s, hydrating: false },
          )
        } catch {
          /* best-effort; live events will still stream in */
          patchSession(info.runtimeId, (s) => ({ ...s, hydrating: false }))
        }
      }
      return info
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setPendingStart(null)
    }
  }, [patchSession])

  // Foreground switch only; main is not involved. Clearing the unread badge
  // here covers every path that foregrounds an already-pooled session.
  const switchActive = useCallback((runtimeId: string) => {
    setActiveId(runtimeId)
    patchSession(runtimeId, (s) => (s.unread ? { ...s, unread: false } : s))
  }, [patchSession])

  // Images are only valid on the prompt wire command (steer/follow_up carry
  // no images field), so they attach only when intent is 'prompt'.
  const send = useCallback(async (
    runtimeId: string,
    message: string,
    intent: 'prompt' | 'steer' | 'follow_up' = 'prompt',
    images?: PromptImage[],
  ) => {
    // A send whose runtime is already gone (evicted draft, crash) must be
    // loud: silently dropped messages look exactly like a lost keystroke.
    if (!sessionsRef.current.get(runtimeId)?.runtime) {
      const msg = t('session.runtimeGone')
      setError(msg)
      throw new Error(msg)
    }
    // Mark the dispatch before the round-trip: extension-intercepted messages
    // (/plan etc.) stream no events, so this flag is what moves the page off
    // the home/draft surface.
    patchSession(runtimeId, (s) => ({ ...s, lastDispatchAt: Date.now() }))
    const command =
      intent === 'prompt' ? { type: 'prompt' as const, message, ...(images?.length ? { images } : {}) }
      : intent === 'steer' ? { type: 'steer' as const, message }
      : { type: 'follow_up' as const, message }
    try {
      const res = await window.pi.agent.command(runtimeId, command)
      setError(null)
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // The daemon-side runtime died (crash/eviction) while this pool still
      // held its id — the runtime_exit event was missed (e.g. across a
      // remote reconnect window). Convert the zombie into the exited state
      // so the composer's resume branch takes over on the next send
      // (lastSessionFile continues the conversation) instead of failing
      // forever with the raw daemon error.
      if (/runtime is no longer available/i.test(msg)) {
        patchSession(runtimeId, (s) => ({
          ...s,
          runtime: null,
          exited: true,
          status: 'idle',
          startedAt: null,
        }))
        const gone = t('session.runtimeGone')
        setError(gone)
        throw new Error(gone)
      }
      setError(msg)
      throw e
    }
  }, [patchSession, t])

  const abort = useCallback(async (runtimeId: string) => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) return
    patchSession(runtimeId, (s) => ({ ...s, status: 'stopping' }))
    try {
      await window.pi.agent.command(runtimeId, { type: 'abort' })
    } catch {
      /* ignore abort errors */
    }
  }, [patchSession])

  // Re-reads the runtime state after a session-affecting command so the
  // composer's model/thinking chips reflect PI's answer immediately.
  const refreshState = useCallback(async (runtimeId: string) => {
    const res = await window.pi.agent.command(runtimeId, { type: 'get_state' })
    const data = res.data as { model?: RuntimeInfo['model']; thinkingLevel?: string } | undefined
    if (!data) return
    patchSession(runtimeId, (s) =>
      s.runtime
        ? {
            ...s,
            runtime: {
              ...s.runtime,
              model: data.model ?? s.runtime.model,
              thinkingLevel: data.thinkingLevel ?? s.runtime.thinkingLevel,
            },
          }
        : s,
    )
  }, [patchSession])

  const setModel = useCallback(async (runtimeId: string, provider: string, modelId: string) => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) throw new Error('No active runtime')
    await window.pi.agent.command(runtimeId, { type: 'set_model', provider, modelId })
    await refreshState(runtimeId)
  }, [refreshState])

  const setThinkingLevel = useCallback(async (runtimeId: string, level: string) => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) throw new Error('No active runtime')
    await window.pi.agent.command(runtimeId, { type: 'set_thinking_level', level })
    await refreshState(runtimeId)
  }, [refreshState])

  const getAvailableModels = useCallback(async (runtimeId: string): Promise<PiAvailableModel[]> => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) return []
    const res = await window.pi.agent.command(runtimeId, { type: 'get_available_models' })
    const data = res.data as { models?: PiAvailableModel[] } | undefined
    return data?.models ?? []
  }, [])

  const getAvailableThinkingLevels = useCallback(async (runtimeId: string): Promise<string[]> => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) return []
    const res = await window.pi.agent.command(runtimeId, { type: 'get_available_thinking_levels' })
    const data = res.data as { levels?: string[] } | undefined
    return data?.levels ?? []
  }, [])

  // Slash-command registry (extensions, prompt templates, skills). Execution
  // itself stays in PI: a prompt starting with "/" is expanded/interpreted
  // by pi's own prompt path.
  const getAvailableCommands = useCallback(async (runtimeId: string): Promise<PiCommandInfo[]> => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) return []
    const res = await window.pi.agent.command(runtimeId, { type: 'get_commands' })
    const data = res.data as { commands?: PiCommandInfo[] } | undefined
    return data?.commands ?? []
  }, [])

  const stop = useCallback(async (runtimeId: string) => {
    patchSession(runtimeId, (s) => ({ ...s, status: 'stopping' }))
    try {
      await window.pi.agent.stop(runtimeId)
    } catch {
      /* already gone */
    }
    setSessions((prev) => {
      if (!prev.has(runtimeId)) return prev
      const next = new Map(prev)
      next.delete(runtimeId)
      return next
    })
  }, [patchSession])

  // Crash recovery or resuming an exited session: drop the dead state and
  // start over from its last options, resuming the same session file when one
  // is known so the conversation continues instead of forking a blank session.
  const restart = useCallback(async (runtimeId: string) => {
    const s = sessionsRef.current.get(runtimeId)
    const opts = s?.lastStart
    if (!opts) return
    const sessionPath = s.lastSessionFile ?? opts.sessionPath
    setSessions((prev) => {
      const next = new Map(prev)
      next.delete(runtimeId)
      return next
    })
    await start(sessionPath ? { ...opts, sessionPath } : opts)
  }, [start])

  const dismissNotify = useCallback((runtimeId: string, id: string) => {
    patchSession(runtimeId, (s) => ({ ...s, notifies: s.notifies.filter((n) => n.id !== id) }))
  }, [patchSession])

  // Keep PI's in-memory session name in sync after a file-level rename; the
  // rename itself already happened via sessions.rename in main. Best-effort:
  // the runtime may already be gone.
  const renameSession = useCallback(async (runtimeId: string, name: string) => {
    if (!sessionsRef.current.get(runtimeId)?.runtime) return
    try {
      await window.pi.agent.command(runtimeId, { type: 'set_session_name', name })
    } catch {
      /* runtime exited; the file-level rename still stands */
    }
  }, [])

  const respondExtension = useCallback(async (runtimeId: string, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    // Remove locally first so the blocking prompt clears immediately; the
    // wire response is best-effort and must not hold the UI open on error.
    patchSession(runtimeId, (s) => ({
      ...s,
      interactive: s.interactive.filter((e) => (e.event as { id: string }).id !== requestId),
    }))
    if (sessionsRef.current.get(runtimeId)?.runtime) {
      try {
        await window.pi.agent.command(runtimeId, { type: 'extension_ui_response', id: requestId, ...response })
      } catch {
        /* the agent may have exited; the request is already cleared locally */
      }
    }
  }, [patchSession])

  const activeSession = (activeId && sessions.get(activeId)) || null

  return {
    sessions,
    activeId,
    activeSession,
    pendingStart,
    error,
    start,
    switchActive,
    stop,
    send,
    abort,
    restart,
    respondExtension,
    dismissNotify,
    renameSession,
    setModel,
    setThinkingLevel,
    getAvailableModels,
    getAvailableThinkingLevels,
    getAvailableCommands,
  }
}
