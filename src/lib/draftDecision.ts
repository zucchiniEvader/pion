// Draft/prewarm decision layer: which runtime gets dispatched to whom.
//
// Every boolean decision around the new-task draft lifecycle lives here as a
// pure function — App.tsx only sequences the side effects (send, switchActive,
// setState ordering) around these verdicts. This state machine produced three
// shipped bugs (goal.md §2.3), so it is now test-protected; the purity suite
// is scripts/draft-decision.purity.test.mjs.
//
// Invariants encoded here (goal.md §2.3):
// - Consumption revalidation: a prewarmed runtime is only consumable while it
//   is still a live, never-dispatched blank draft; anything else falls back
//   to an optimistic fresh start.
// - View follows the message: the caller must switchActive BEFORE sending, so
//   activeId can never point at a session the message did not land on.
//
// Deliberately dependency-free: types below are structural subsets of
// SessionState/RuntimeInfo, so the module bundles standalone and tests
// construct minimal fixtures.

/** Minimal structural snapshot of a pooled session state (SessionState ⊇ this). */
export interface DraftSnapshot {
  runtime: { runtimeId: string; cwd: string } | null
  transcript: { length: number }
  lastStart: { sessionPath?: string } | null
  lastDispatchAt: number | null
}

/**
 * An untouched blank draft runtime: alive, never received ANY dispatch, never
 * bound to a session file. With `projectPath` given, its cwd must belong to
 * that project.
 *
 * This is the shared primitive behind three decision points: reusing the
 * active draft (startFromHome), keeping the home hero up (draftRuntime), and
 * skipping a redundant prewarm. Note transcript emptiness alone is NOT draft
 * evidence — extension-intercepted commands (/plan) stream no transcript
 * events, hence the lastDispatchAt check.
 */
export function isInertDraft(
  s: (DraftSnapshot & { exited?: boolean }) | null | undefined,
  projectPath?: string,
): s is DraftSnapshot & { runtime: { runtimeId: string; cwd: string } } {
  return (
    !!s?.runtime &&
    s.lastStart?.sessionPath == null &&
    s.transcript.length === 0 &&
    s.lastDispatchAt == null &&
    (projectPath == null || s.runtime.cwd === projectPath)
  )
}

/**
 * Whether the home surface (greeting + starter chips) should cover the active
 * session: nothing live on screen, or an explicit new-task draft, or the
 * active runtime is itself an untouched prewarm.
 */
export function isHomeSurfaceUp(
  s: (DraftSnapshot & { exited?: boolean }) | null | undefined,
  composingNew: boolean,
): boolean {
  return (!s || (!s.runtime && !s.exited)) || composingNew || isInertDraft(s)
}

export type PrewarmVerdict =
  | { ok: true; runtimeId: string }
  | { ok: false; reason: 'no-runtime-info' | 'project-mismatch' | 'not-a-blank-draft' }

/**
 * Consumption revalidation for a prewarmed draft, run after the prewarm
 * promise resolves and before any send. A runtime that was evicted, crashed,
 * already dispatched, opened onto another project, or — the subtle one —
 * REBOUND to an existing session file (main's bind fast path reuses the
 * prewarm process via switch_session, so `lastStart.sessionPath` gets set)
 * must never carry a draft message; the caller falls back to a fresh start.
 */
export function judgePrewarm(
  info: { runtimeId: string; cwd: string } | null | undefined,
  state: DraftSnapshot | null | undefined,
  projectPath: string,
): PrewarmVerdict {
  if (!info) return { ok: false, reason: 'no-runtime-info' }
  if (info.cwd !== projectPath) return { ok: false, reason: 'project-mismatch' }
  if (!isInertDraft(state)) return { ok: false, reason: 'not-a-blank-draft' }
  return { ok: true, runtimeId: info.runtimeId }
}

/** Guard chain of the prewarm effect; every field blocks, all must clear. */
export interface PrewarmGuards {
  /** Optimistic first message on screen: a dispatch already owns the surface. */
  startingMessageActive: boolean
  /** Transcript is being re-read from disk; the surface is in transition. */
  hydrating: boolean
  /** Any pool.start is in flight (session bind or draft spawn). */
  startInFlight: boolean
  /** A prewarm promise is already parked in prewarmRef. */
  prewarmInFlight: boolean
  /** Home surface is actually up (isHomeSurfaceUp). */
  homeSurfaceUp: boolean
  /** The active runtime is already a warm blank draft for this project. */
  warmDraftAlready: boolean
}

/** Whether the prewarm effect should boot a background draft runtime. */
export function shouldStartPrewarm(g: PrewarmGuards): boolean {
  return (
    !g.startingMessageActive &&
    !g.hydrating &&
    !g.startInFlight &&
    !g.prewarmInFlight &&
    g.homeSurfaceUp &&
    !g.warmDraftAlready
  )
}

/**
 * Which session file owns the current view (header title, sidebar highlight,
 * transcript key). A new-task draft owns nothing — even while a background
 * runtime keeps streaming — so the draft page never masquerades as a session.
 */
export function resolveViewedSessionFile(
  composingNew: boolean,
  s:
    | {
        runtime: { sessionFile?: string } | null
        lastStart: { sessionPath?: string } | null
        lastSessionFile: string | null
      }
    | null
    | undefined,
  pendingSessionFile: string | null | undefined,
): string | null {
  if (composingNew) return null
  return s?.runtime?.sessionFile ?? s?.lastStart?.sessionPath ?? s?.lastSessionFile ?? pendingSessionFile ?? null
}
