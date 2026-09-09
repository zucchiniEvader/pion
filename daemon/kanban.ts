// Kanban host (goal.md §6, M2-2): per-project event-log stores, runState
// projection, dispatch, review forwarding, and the settled tap. Bodies were
// moved verbatim from electron/main/index.ts; pushes now leave via
// server.broadcast('kanban.changed') instead of sendToRenderer. No electron
// imports — the bundled bridge resolves via the --resources boot argument.
//
// Runtime couplings (runState / dispatch / review forward) import from
// daemon/agent.ts; the reverse direction (agent → kanban) is wired through
// onAgentEvent + setSessionRestartedHook so the dependency stays
// one-directional.
import { stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CardRunState,
  CardStatus,
  KanbanAssignInput,
  KanbanBoard,
  KanbanCard,
  KanbanChangeEvent,
  KanbanCreateInput,
  KanbanDispatchInput,
  KanbanUpdateInput,
  RuntimeInfo,
} from '../src/types'
import { KANBAN_UNASSIGNED } from '../src/types'
import { KANBAN_STATUSES, cardToEvents } from '../src/lib/kanbanReducer'
import { KanbanStore } from './kanban-store'
import { loadProjects } from './projects'
import { assertSessionFile, archiveTrackedSession } from './sessions'
import { onAgentEvent, setSessionRestartedHook, startRuntime, runtimeForSessionFile, getRuntime, sessionFileForRuntime } from './agent'
import type { DaemonServer } from './server'

let userData = ''
let resourcesDir = ''

// ──────────────────────────────────────────────────────────────────────────
// Stores
// ──────────────────────────────────────────────────────────────────────────

const kanbanStores = new Map<string, KanbanStore>()
// Sessions whose runtime died unexpectedly: their cards project runState
// 'failed' until the session is successfully started again.
const kanbanFailedFiles = new Set<string>()
// Cards with a dispatch currently in flight (P2): runState 'starting'.
const kanbanDispatchingCards = new Set<string>()

let broadcastKanbanChanged: ((projectPath: string) => void) | null = null

async function getKanbanStore(projectPath: string): Promise<KanbanStore> {
  let store = kanbanStores.get(projectPath)
  if (!store) {
    // Unassigned cards live in a global event log in userData — same schema,
    // same append-only rules, same lazy "load never creates" guarantee.
    const file =
      projectPath === KANBAN_UNASSIGNED
        ? join(userData, 'kanban', 'events.jsonl')
        : undefined
    store = file
      ? new KanbanStore(projectPath, () => notifyKanbanChanged(projectPath), file)
      : new KanbanStore(projectPath, () => notifyKanbanChanged(projectPath))
    kanbanStores.set(projectPath, store)
    await store.load()
  }
  return store
}

function notifyKanbanChanged(projectPath: string): void {
  broadcastKanbanChanged?.(projectPath)
}

// Cards assigned to this session live in at most one store; push only when a
// store actually cares (runtime lifecycle events arrive for every pool member).
function notifyKanbanChangedForSession(sessionFile: string | undefined): void {
  if (!sessionFile) return
  for (const [projectPath, store] of kanbanStores) {
    if (store.cards.some((c) => c.assignee?.sessionFile === sessionFile)) {
      notifyKanbanChanged(projectPath)
      return
    }
  }
}

// runState is a runtime-pool projection (design §3): never persisted, never
// written to the event log, recomputed for every snapshot.
function deriveKanbanRunState(card: KanbanCard): CardRunState {
  if (kanbanDispatchingCards.has(card.id)) return 'starting'
  const sessionFile = card.assignee?.sessionFile
  if (!sessionFile) return 'idle'
  const runtime = runtimeForSessionFile(sessionFile)
  if (!runtime) return kanbanFailedFiles.has(sessionFile) ? 'failed' : 'idle'
  return runtime.snapshot().isStreaming ? 'running' : 'settled'
}

function kanbanCardWithRunState(projectPath: string, card: KanbanCard): KanbanCard {
  return { ...card, projectPath, runState: deriveKanbanRunState(card) }
}

function kanbanBoardWithRunState(projectPath: string): KanbanBoard {
  const store = kanbanStores.get(projectPath)
  return {
    projectPath,
    cards: (store?.cards ?? []).map((card) => kanbanCardWithRunState(projectPath, card)),
  }
}

// The bundled bridge extension: resolves inside the resources dir passed at
// boot (`--resources`; Electron main computes it — dev = repo resources/,
// packaged = process.resourcesPath). Behavior-equivalent to the old
// app.getAppPath()/process.resourcesPath probe in main.
function kanbanBridgePath(): string {
  return join(resourcesDir, 'kanban-bridge.ts')
}

// Dispatch prompt template (design §6, v1 fixed).
function renderDispatchPrompt(card: KanbanCard): string {
  const lines = [
    `[任务卡 ${card.id}] ${card.title}`,
    '',
    ...(card.body ? [card.body, ''] : []),
    ...(card.acceptance?.length ? ['验收标准：', ...card.acceptance.map((a) => `- ${a}`), ''] : []),
    '工作方式：',
    `- 本会话已绑定该任务卡。开始前先 kanban_read(cardId="${card.id}") 读取详情。`,
    '- 关键节点（完成子步骤、发现阻塞、方案变更）调用 kanban_report(cardId, note=…) 记录。',
    '- 全部完成：kanban_report(cardId, status="review", note=结论与改动说明)。',
    '- 被阻塞：kanban_report(cardId, status="blocked", note=原因)。',
  ]
  return lines.join('\n')
}

// Cross-store migration (unassigned → project): re-emit the card's state as
// its reconstructive event sequence into the target store (same id, notes in
// order, status, assignee) and archive the origin copy for audit.
async function moveKanbanCardToProject(fromPath: string, toPath: string, cardId: string): Promise<KanbanCard> {
  const from = await getKanbanStore(fromPath)
  const to = await getKanbanStore(toPath)
  const card = from.card(cardId)
  if (card.archived) throw new Error('err.kanban.archivedMove')
  if (to.cards.some((c) => c.id === cardId)) throw new Error('err.kanban.duplicateCard')
  await to.importCardEvents(cardToEvents(card, new Date().toISOString()))
  await from.archive(cardId)
  notifyKanbanChanged(fromPath)
  notifyKanbanChanged(toPath)
  return to.card(cardId)
}

// Stable idle boundary of a dispatched worker: if its card is still
// in_progress (the agent never reported review), file a system note and move
// it to review so the dispatch→report→review loop always converges (§8).
async function settleKanbanCard(sessionFile: string): Promise<void> {
  try {
    for (const [, store] of kanbanStores) {
      const card = store.cards.find((c) => c.assignee?.sessionFile === sessionFile && c.status === 'in_progress' && !c.archived)
      if (!card) continue
      await store.addNote(card.id, 'system', '会话已结束，未收到汇报；自动移入 Review 待审核。')
      await store.move(card.id, 'review', 'system')
      return
    }
  } catch {
    /* best-effort: the board keeps its last known state */
  }
}

// Review feedback (design §评论转发): a comment on a review card goes to the
// executing session and steers the reply back through kanban_report, so the
// review conversation lands in the card's timeline. Best-effort: failures are
// filed as system notes instead of failing the user's comment.
async function forwardReviewComment(projectPath: string, store: KanbanStore, card: KanbanCard, comment: string): Promise<void> {
  const sessionFile = card.assignee?.sessionFile
  if (!sessionFile) return
  try {
    const existing = runtimeForSessionFile(sessionFile)
    if (existing?.snapshot().isStreaming) throw new Error('err.kanban.sessionBusy')
    let runtime = existing
    if (!runtime) {
      // Cold-start bound to the session WITH the bridge: the reply must go
      // through kanban_report, which only a bridge-carrying runtime has.
      if (!existsSync(kanbanBridgePath())) throw new Error('err.kanban.bridgeMissing')
      const info = await startRuntime({ projectPath, sessionPath: sessionFile, extensions: [kanbanBridgePath()] })
      runtime = getRuntime(info.runtimeId)
    }
    if (!runtime) throw new Error('err.kanban.sessionStartFailed')
    await runtime.command({ type: 'prompt', message: renderReviewFeedbackPrompt(card, comment) })
    await store.addNote(card.id, 'system', '评论已转发给执行会话。')
  } catch (e) {
    await store
      .addNote(card.id, 'system', `评论转发失败：${e instanceof Error ? e.message : String(e)}`)
      .catch(() => undefined)
  }
}

function renderReviewFeedbackPrompt(card: KanbanCard, comment: string): string {
  return [
    `[任务卡 ${card.id}] ${card.title} — 审核反馈`,
    '',
    comment,
    '',
    '工作方式：',
    `- 以上是用户在审核（review）阶段的反馈，本会话已绑定该卡片。`,
    `- 处理完反馈（或需要澄清时）用 kanban_report(cardId="${card.id}", note=结论) 把结果汇报回看板。`,
  ].join('\n')
}

// ──────────────────────────────────────────────────────────────────────────
// Input validation (moved verbatim; Electron main's preload mirrors it)
// ──────────────────────────────────────────────────────────────────────────

// Git endpoints write to disk (worktree add), so unlike the read-only
// session listings they require the path to be a registered project that
// still exists on disk. (The git handlers keep a copy in main until M2-3.)
async function assertProjectDirectory(projectPath: string): Promise<void> {
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('projectPath must be a non-empty string')
  const projects = await loadProjects()
  if (!projects.some((p) => p.path === projectPath)) throw new Error('Not a registered project.')
  const info = await stat(projectPath).catch(() => null)
  if (!info?.isDirectory()) throw new Error('Project directory no longer exists.')
}

// Card ops accept either a registered project or the unassigned store;
// dispatch/assign keep requiring a real project (execution needs a home).
async function assertKanbanTarget(projectPath: string): Promise<void> {
  if (projectPath === KANBAN_UNASSIGNED) return
  await assertProjectDirectory(projectPath)
}

function assertKanbanCardId(cardId: unknown): string {
  if (typeof cardId !== 'string' || !cardId) throw new Error('cardId must be a non-empty string')
  return cardId
}

function asKanbanCreateInput(input: unknown): KanbanCreateInput {
  if (!input || typeof input !== 'object') throw new Error('input must be an object')
  const v = input as Record<string, unknown>
  if (typeof v.title !== 'string') throw new Error('title must be a string')
  if (v.body !== undefined && typeof v.body !== 'string') throw new Error('body must be a string')
  if (v.acceptance !== undefined) {
    if (!Array.isArray(v.acceptance) || v.acceptance.length > 20 || v.acceptance.some((a) => typeof a !== 'string' || a.length > 500)) {
      throw new Error('acceptance must be an array of at most 20 strings (500 chars each)')
    }
  }
  return {
    title: v.title,
    ...(v.body !== undefined ? { body: v.body } : {}),
    ...(v.acceptance !== undefined ? { acceptance: v.acceptance as string[] } : {}),
  }
}

function asKanbanUpdateInput(patch: unknown): KanbanUpdateInput {
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object')
  const v = patch as Record<string, unknown>
  if (v.title !== undefined && typeof v.title !== 'string') throw new Error('title must be a string')
  if (v.body !== undefined && typeof v.body !== 'string') throw new Error('body must be a string')
  if (v.acceptance !== undefined) {
    if (!Array.isArray(v.acceptance) || v.acceptance.length > 20 || v.acceptance.some((a) => typeof a !== 'string' || a.length > 500)) {
      throw new Error('acceptance must be an array of at most 20 strings (500 chars each)')
    }
  }
  return {
    ...(v.title !== undefined ? { title: v.title } : {}),
    ...(v.body !== undefined ? { body: v.body } : {}),
    ...(v.acceptance !== undefined ? { acceptance: v.acceptance as string[] } : {}),
  }
}

function asKanbanAssignInput(input: unknown): KanbanAssignInput {
  if (!input || typeof input !== 'object') throw new Error('input must be an object')
  const v = input as Record<string, unknown>
  if (typeof v.sessionFile !== 'string' || !v.sessionFile) throw new Error('sessionFile must be a non-empty string')
  if (v.model !== undefined && typeof v.model !== 'string') throw new Error('model must be a string')
  if (v.label !== undefined && typeof v.label !== 'string') throw new Error('label must be a string')
  // Path allowlist: the assigned session must be a PI session file.
  assertSessionFile(v.sessionFile)
  return {
    sessionFile: v.sessionFile,
    ...(v.model ? { model: v.model } : {}),
    ...(v.label ? { label: v.label } : {}),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Method registration
// ──────────────────────────────────────────────────────────────────────────

/** Stops a project's kanban watcher (projects.remove teardown). */
export function stopKanbanStore(projectPath: string): void {
  kanbanStores.get(projectPath)?.stop()
  kanbanStores.delete(projectPath)
}

/** Stops every store watcher (daemon shutdown). */
export function shutdownKanban(): void {
  for (const store of kanbanStores.values()) store.stop()
  kanbanStores.clear()
}

export function registerKanbanMethods(server: DaemonServer, userDataDir: string, resources: string): void {
  userData = userDataDir
  resourcesDir = resources
  broadcastKanbanChanged = (projectPath) => server.broadcast('kanban.changed', { projectPath } satisfies KanbanChangeEvent)

  // Runtime-lifecycle couplings that used to live inside main's
  // forwardRuntimeEvent: unexpected exit → failed marking; settled →
  // settle tap + board refresh; session restart → clear failed marking.
  onAgentEvent((envelope) => {
    if (
      envelope.event.type === 'agent_start' ||
      envelope.event.type === 'agent_settled' ||
      envelope.event.type === 'runtime_exit'
    ) {
      const sessionFile = sessionFileForRuntime(envelope.runtimeId)
      if (envelope.event.type === 'runtime_exit' && envelope.event.expected !== true && sessionFile) {
        kanbanFailedFiles.add(sessionFile)
      }
      if (envelope.event.type === 'agent_settled' && sessionFile) void settleKanbanCard(sessionFile)
      notifyKanbanChangedForSession(sessionFile)
    }
  })
  setSessionRestartedHook((sessionFile) => kanbanFailedFiles.delete(sessionFile))

  server.register('kanban.list', async (params) => {
    const { projectPath } = params as { projectPath: string }
    await assertKanbanTarget(projectPath)
    await getKanbanStore(projectPath)
    return kanbanBoardWithRunState(projectPath)
  })
  server.register('kanban.create', async (params) => {
    const { projectPath, input } = params as { projectPath: string; input: unknown }
    await assertKanbanTarget(projectPath)
    const store = await getKanbanStore(projectPath)
    return kanbanCardWithRunState(projectPath, await store.create(asKanbanCreateInput(input)))
  })
  server.register('kanban.update', async (params) => {
    const { projectPath, cardId, patch } = params as { projectPath: string; cardId: unknown; patch: unknown }
    await assertKanbanTarget(projectPath)
    const store = await getKanbanStore(projectPath)
    return kanbanCardWithRunState(projectPath, await store.update(assertKanbanCardId(cardId), asKanbanUpdateInput(patch)))
  })
  server.register('kanban.move', async (params) => {
    const { projectPath, cardId, to } = params as { projectPath: string; cardId: unknown; to: CardStatus }
    await assertKanbanTarget(projectPath)
    if (typeof to !== 'string' || !(KANBAN_STATUSES as readonly string[]).includes(to)) {
      throw new Error(`to must be one of: ${KANBAN_STATUSES.join(', ')}`)
    }
    const store = await getKanbanStore(projectPath)
    const id = assertKanbanCardId(cardId)
    // A user move into Done is the human sign-off; file it in the card's
    // timeline so the completion is auditable like agent reports (§动态).
    // Agent moves land via the bridge's direct event writes, not here.
    const wasDone = store.card(id).status === 'done'
    const card = await store.move(id, to)
    if (to === 'done' && !wasDone) await store.addNote(id, 'user', '手动标记完成。')
    // Marking a card done is the human sign-off: archive the bound session so
    // the sidebar collapses it into the archive group. Best-effort — the move
    // already landed; a registry failure becomes a system note, never an error.
    if (to === 'done' && !wasDone && card.assignee?.sessionFile) {
      try {
        await archiveTrackedSession(card.assignee.sessionFile)
        await store.addNote(id, 'system', '已归档关联会话。')
      } catch (e) {
        await store
          .addNote(id, 'system', `归档关联会话失败：${e instanceof Error ? e.message : String(e)}`)
          .catch(() => undefined)
      }
    }
    return kanbanCardWithRunState(projectPath, card)
  })
  server.register('kanban.note', async (params) => {
    const { projectPath, cardId, text } = params as { projectPath: string; cardId: unknown; text: string }
    await assertKanbanTarget(projectPath)
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string')
    const store = await getKanbanStore(projectPath)
    const id = assertKanbanCardId(cardId)
    const card = await store.addNote(id, 'user', text)
    // Review feedback loop: on a review card the comment is also delivered to
    // the executing session (fire-and-forget — the comment must not wait on a
    // runtime spawn; failures land as system notes in the timeline).
    if (card.status === 'review' && card.assignee?.sessionFile) {
      void forwardReviewComment(projectPath, store, card, text.trim())
    }
    return kanbanCardWithRunState(projectPath, card)
  })
  server.register('kanban.assign', async (params) => {
    const { projectPath, cardId, input } = params as { projectPath: string; cardId: unknown; input: unknown }
    await assertProjectDirectory(projectPath)
    const store = await getKanbanStore(projectPath)
    return kanbanCardWithRunState(projectPath, await store.assign(assertKanbanCardId(cardId), asKanbanAssignInput(input)))
  })
  server.register('kanban.archive', async (params) => {
    const { projectPath, cardId } = params as { projectPath: string; cardId: unknown }
    await assertKanbanTarget(projectPath)
    const store = await getKanbanStore(projectPath)
    await store.archive(assertKanbanCardId(cardId))
    return null
  })
  // Unassigned → project migration: the execution-time project gate.
  server.register('kanban.moveProject', async (params) => {
    const { projectPath, cardId, toProjectPath } = params as { projectPath: string; cardId: unknown; toProjectPath: string }
    await assertKanbanTarget(projectPath)
    if (toProjectPath === KANBAN_UNASSIGNED) throw new Error('err.kanban.alreadyUnassigned')
    await assertProjectDirectory(toProjectPath)
    return moveKanbanCardToProject(projectPath, toProjectPath, assertKanbanCardId(cardId))
  })
  // Dispatch: cold-start a bridge-carrying runtime (prewarms carry no -e),
  // bind the card, move it in_progress, and send the dispatch prompt. The
  // runState starting projection covers the spawn window.
  server.register('kanban.dispatch', async (params): Promise<RuntimeInfo> => {
    const { projectPath, cardId, input } = params as { projectPath: string; cardId: unknown; input: KanbanDispatchInput }
    await assertProjectDirectory(projectPath)
    assertKanbanCardId(cardId)
    const v = (input ?? {}) as unknown as Record<string, unknown>
    if (typeof v.fresh !== 'boolean') throw new Error('fresh must be a boolean')
    let sessionPath: string | undefined
    if (!v.fresh) {
      if (typeof v.sessionFile !== 'string' || !v.sessionFile) throw new Error('sessionFile is required when fresh is false')
      assertSessionFile(v.sessionFile)
      sessionPath = v.sessionFile
    }
    const modelId = typeof v.modelId === 'string' && v.modelId ? v.modelId : undefined
    const store = await getKanbanStore(projectPath)
    const card = store.card(cardId as string)
    if (card.archived) throw new Error('err.kanban.dispatchArchived')
    const runState = deriveKanbanRunState(card)
    if (runState === 'running' || runState === 'starting') throw new Error('err.kanban.dispatchRunning')
    if (!existsSync(kanbanBridgePath())) throw new Error('err.kanban.bridgeMissingDispatch')
    kanbanDispatchingCards.add(cardId as string)
    try {
      const info = await startRuntime({
        projectPath,
        ...(sessionPath ? { sessionPath } : {}),
        ...(modelId ? { modelId } : {}),
        extensions: [kanbanBridgePath()],
      })
      if (!info.sessionFile) throw new Error('err.kanban.dispatchNoSession')
      await store.assign(cardId as string, { sessionFile: info.sessionFile, ...(modelId ? { model: modelId } : {}) })
      await store.move(cardId as string, 'in_progress', 'user')
      const runtime = getRuntime(info.runtimeId)
      if (runtime) await runtime.command({ type: 'prompt', message: renderDispatchPrompt(card) })
      notifyKanbanChanged(projectPath)
      return info
    } finally {
      kanbanDispatchingCards.delete(cardId as string)
    }
  })
}
