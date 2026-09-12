// Daemon wire contract (goal.md v3 §5) — versioned frames + method table.
// Shared by pion-daemon (daemon/) and the Electron main proxy
// (electron/main/daemon-client.ts). DTOs reuse src/types.ts so the daemon
// speaks exactly the shapes the IPC handlers already return; when a handler
// migrates, its body moves without reshaping its data.
// Portable types only: included by tsconfig.node.json, must stay dependency-free.

import type {
  AgentStartOptions,
  AuthStateResult,
  CronCreateInput,
  CronJob,
  GitFileDiff,
  GitOverview,
  GitStatusResult,
  TerminalAttachResult,
  TerminalDataEvent,
  TerminalExitEvent,
  KanbanAssignInput,
  KanbanBoard,
  KanbanCard,
  KanbanChangeEvent,
  KanbanCreateInput,
  KanbanDispatchInput,
  KanbanUpdateInput,
  PiEventEnvelope,
  ProjectRecord,
  RpcCommand,
  RpcResponse,
  RuntimeInfo,
  SessionChangeEvent,
  SessionRecord,
  UpdateCheckResult,
  UpdateProgressEvent,
  WorktreeCreated,
} from '../src/types'

// ──────────────────────────────────────────────────────────────────────────
// Versioning (decision §5.4: handshake declares the protocol; mismatch is a
// hard refusal with a readable error, never silent degradation)
// ──────────────────────────────────────────────────────────────────────────

export const DAEMON_PROTOCOL = 'pion-daemon/3'
export const DAEMON_PROTOCOL_VERSION = 3
// v1 (stdio owner 载体,单控制端) 冻结于 3870ae3 / 2026-09-01,见 goal.md §10。
// v2 增量:WS 监听载体(④ 单 remote)、--stay-resident 常驻、projects.discover、
// daemon.shutdown;帧格式与 v1 完全一致(协议冻结规则:升版本号,不静默改语义)。
// v3 增量:多客户端——hello/token 通过的连接全部成为对等客户端(上限 MAX_CLIENTS,
// 见 daemon/server.ts),事件广播到全部连接(seq 仍是 daemon 全局单调计数,跨重连
// 不重置);'conflict' 语义改为「runtime busy / 客户端数上限」,不再表示第二控制端;
// agent.command 对 streaming runtime 的 prompt 返回 conflict(busy);
// daemon.shutdown 仅限 owner 载体(stdio / dial-home),监听载体返回 unauthorized。
// v3 期间新增的 additive 方法(daemon.info、settings.auth*)不升版本号:老客户端
// 从不调用它们,新客户端对老 daemon 得到 not_found,没有静默降级。

// ──────────────────────────────────────────────────────────────────────────
// Error envelope (decision §5.8: same success/error semantics as today's
// IPC handlers; the proxy only adds connection-level codes)
// ──────────────────────────────────────────────────────────────────────────

export type DaemonErrorCode =
  /** Token missing/wrong, or hello frames out of order. */
  | 'unauthorized'
  /** Handshake protocol name/version mismatch. */
  | 'version_mismatch'
  /** Invalid or missing params (mirrors today's preload/main validation). */
  | 'bad_request'
  /** Unknown method or referenced entity does not exist. */
  | 'not_found'
  /** v3: a `prompt` sent to a streaming runtime, or the client cap was
   * reached at hello. (v1/v2 meaning "second control client" is gone —
   * v3 serves multiple peers.) */
  | 'conflict'
  /** Connection-level: daemon unreachable, spawn failed, handshake dropped. */
  | 'unavailable'
  /** Handler threw an unexpected error. */
  | 'internal'

export interface DaemonError {
  code: DaemonErrorCode
  message: string
}

// ──────────────────────────────────────────────────────────────────────────
// Frames
// ──────────────────────────────────────────────────────────────────────────

/** client → daemon, first frame on a network-carrier connection (④ remote
 * WS/TCP). The stdio owner client sends no hello — the pipe is the credential.
 * v3: every connection that passes the gate becomes a peer client (up to the
 * daemon's MAX_CLIENTS cap); all clients may call all methods. */
export interface HelloFrame {
  type: 'hello'
  protocol: string
  token: string
  /** Opaque; echoed in logs only. */
  clientId?: string
}

/** daemon → client, on successful handshake. lastSeq is the daemon-wide event
 * sequence at attach time (v3: the counter is global, not per client — every
 * client receives every event with the same seq). Carrier semantics: over
 * stdio the daemon sends hello_ok unprompted once it is serving (the pipe is
 * the credential — no client hello, no token). Over the ④ remote carriers,
 * the client must send `hello` first and the daemon checks protocol + token
 * before hello_ok. */
export interface HelloOkFrame {
  type: 'hello_ok'
  protocol: string
  daemonVersion: string
  lastSeq: number
}

/** daemon → client, before closing on failed handshake. */
export interface HelloErrorFrame {
  type: 'hello_error'
  error: DaemonError
}

/** client → daemon request. One outstanding id per call; ids are client-chosen
 * and only correlated within the connection. */
export interface CallFrame {
  type: 'call'
  id: string
  method: DaemonMethodName
  params?: unknown
}

export type ResultFrame =
  | { type: 'result'; id: string; ok: true; value: unknown }
  | { type: 'result'; id: string; ok: false; error: DaemonError }

/** daemon → client push, broadcast to every handshaken client (v3). seq is
 * the daemon-wide monotonic counter with no gaps in ordered delivery on a
 * given connection; a detected gap (seq > lastSeq + 1) means the client MUST
 * re-hydrate (decision §5.3) — there is no incremental catch-up protocol. */
export interface DaemonEventFrame {
  type: 'event'
  channel: DaemonEventChannel
  seq: number
  payload: DaemonEventMap[DaemonEventChannel]
}

export type ClientFrame = HelloFrame | CallFrame
export type DaemonFrame = HelloOkFrame | HelloErrorFrame | ResultFrame | DaemonEventFrame

// ──────────────────────────────────────────────────────────────────────────
// Runtime attachment (goal.md v3 §9 seam)
// ──────────────────────────────────────────────────────────────────────────

/** §9 seam: the runtime a project record belongs to. Value semantics v2:
 * the main proxy assigns it from the serving connection — 'local' for the
 * spawned owner daemon, the settings entry id for a remote runtime (④).
 * `connected` (v2, proxy-set, main-only semantics) marks the owning
 * connection's liveness; remote-only at the daemon layer (a daemon only
 * ever knows about itself, so the wire value is always 'local'). */
export interface RuntimeAttachment {
  runtime: string
  connected?: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// Event channels (daemon → client push; payload = today's renderer push DTOs)
// ──────────────────────────────────────────────────────────────────────────

export type DaemonEventChannel =
  | 'agent.event'
  | 'sessions.changed'
  | 'kanban.changed'
  | 'version-check.result'
  | 'version-check.progress'
  | 'terminal.data'
  | 'terminal.exit'

export interface DaemonEventMap {
  'agent.event': PiEventEnvelope
  'sessions.changed': SessionChangeEvent
  'kanban.changed': KanbanChangeEvent
  'version-check.result': UpdateCheckResult
  'version-check.progress': UpdateProgressEvent
  /** v3 additive: pty output/exit for the integrated terminal (daemon-side
   * host, used by remote runtimes; the LOCAL terminal is main-hosted). */
  'terminal.data': TerminalDataEvent
  'terminal.exit': TerminalExitEvent
}

// ──────────────────────────────────────────────────────────────────────────
// Method table (goal.md §6: everything that migrates to the daemon).
// M1 implements `ping` only; the rest are declared now so the contract is
// complete before any handler moves. Params/results mirror the existing
// ipcMain.handle signatures one-to-one.
// Not in the table (client-local, stays in Electron main): app.meta,
// app.pickProject, app.revealPath, app.openExternal, app.openGhostty,
// app.openVSCode — see docs/daemon-protocol.md §5.
// ──────────────────────────────────────────────────────────────────────────

export interface DaemonMethodMap {
  /** M1 smoke method. */
  ping: { params: Record<string, never>; result: { pong: true; pid: number; uptimeMs: number } }

  // projects (results carry the §9 runtime-attachment field, constant 'local'
  // in phase ③)
  'projects.list': { params: Record<string, never>; result: Array<ProjectRecord & RuntimeAttachment> }
  /** v2: optional runtimeId — proxy-level routing key ('local' by default).
   * A daemon never sees it (it only ever knows its own machine). */
  'projects.add': { params: { path: string; runtimeId?: string }; result: ProjectRecord & RuntimeAttachment }
  'projects.remove': { params: { id: string }; result: null }
  'projects.extensions': { params: { projectPath: string }; result: string[] }
  /** v2: enumerate candidate project directories on THIS machine — dirs that
   * directly contain PI session buckets, newest first. Remote clients offer
   * these in the add-project flow (goal.md §9: no remote file browser). */
  'projects.discover': { params: Record<string, never>; result: string[] }
  /** v2: graceful shutdown (resident mode / tests). Responds ok, then exits
   * after a short drain. Over stdio the owner rarely needs it (stdin close
   * already shuts the daemon down). v3: owner carriers only (stdio /
   * dial-home); listen carriers (ws/tcp) get `unauthorized` — in pure listen
   * mode the supervisor (launchd/systemd) owns the lifecycle via SIGTERM. */
  'daemon.shutdown': { params: Record<string, never>; result: null }

  /** v3 additive (backward-compatible: old clients never call it, new clients
   * on old daemons get not_found and fall back). Reports the live network
   * listeners so a client can render a scannable `pion://` connect QR for
   * phone-class peers without guessing the derived WS port. `port` is the
   * ACTUAL bound port (an ephemeral `--listen-ws host:0` binds a random port;
   * a derived default that walked up from a busy port reports where it
   * landed). */
  'daemon.info': {
    params: Record<string, never>
    result: {
      daemonVersion: string
      protocolVersion: number
      listeners: Array<{ kind: 'ws' | 'tcp'; host: string; port: number }>
    }
  }

  /** v3 additive, same shape as `daemon.info`: old clients never call these,
   * a new client on an older daemon gets `not_found` (loud, not silent).
   * settings Providers: the local pi's credentials. Reads and writes
   * `~/.pi/agent/auth.json`; a remote runtime's keys are written by ITS daemon
   * through these same methods. Values never leave the daemon — results carry
   * provider ids and credential kinds only. */
  'settings.authState': { params: Record<string, never>; result: AuthStateResult }
  'settings.authSetKey': { params: { provider: string; key: string }; result: AuthStateResult }
  'settings.authRemove': { params: { provider: string }; result: AuthStateResult }

  // sessions
  'sessions.list': { params: { projectPath: string; force?: boolean }; result: SessionRecord[] }
  'sessions.read': { params: { filePath: string }; result: { messages: unknown[] } }
  'sessions.tracked': { params: { projectPath: string }; result: string[] }
  'sessions.rename': { params: { filePath: string; name: string }; result: null }
  /** Returns the registry entries removed by the archive. */
  'sessions.archive': { params: { filePath: string }; result: string[] }
  'sessions.track': { params: { projectPath: string; filePath: string }; result: null }

  // agent runtime
  'agent.start': { params: AgentStartOptions; result: RuntimeInfo }
  /** v3: a `prompt` while the runtime is streaming fails with `conflict`
   * (busy) instead of racing the run — with multiple clients the daemon, not
   * any single client's UI, is the authority. `steer` / `follow_up` / `abort`
   * / `get_state` keep their while-running semantics. */
  'agent.command': { params: { runtimeId: string; command: RpcCommand }; result: RpcResponse }
  'agent.stop': { params: { runtimeId: string }; result: boolean }
  'agent.list': { params: Record<string, never>; result: RuntimeInfo[] }

  // kanban
  'kanban.list': { params: { projectPath: string }; result: KanbanBoard }
  'kanban.create': { params: { projectPath: string; input: KanbanCreateInput }; result: KanbanCard }
  'kanban.update': { params: { projectPath: string; cardId: string; patch: KanbanUpdateInput }; result: KanbanCard }
  'kanban.move': { params: { projectPath: string; cardId: string; to: string }; result: KanbanCard }
  'kanban.note': { params: { projectPath: string; cardId: string; text: string }; result: KanbanCard }
  'kanban.assign': { params: { projectPath: string; cardId: string; input: KanbanAssignInput }; result: KanbanCard }
  'kanban.archive': { params: { projectPath: string; cardId: string }; result: null }
  'kanban.dispatch': { params: { projectPath: string; cardId: string; input: KanbanDispatchInput }; result: RuntimeInfo }
  'kanban.moveProject': { params: { projectPath: string; cardId: string; toProjectPath: string }; result: KanbanCard }

  // git
  'git.overview': { params: { projectPath: string }; result: GitOverview }
  'git.createWorktree': { params: { projectPath: string; branch: string }; result: WorktreeCreated }
  /** v3 additive (same rule as cron.*): working-tree change list for the
   * right-side changes panel; old daemons answer not_found. */
  'git.changedFiles': { params: { projectPath: string }; result: GitStatusResult }
  /** v3 additive: unified diff of one changed path (panel drill-down). */
  'git.fileDiff': { params: { projectPath: string; path: string }; result: GitFileDiff }

  // terminal (v3 additive): daemon-side pty host for REMOTE runtimes — the
  // local terminal stays client-local in Electron main. node-pty is loaded
  // lazily; a daemon without it answers 'err.terminal.unavailable'.
  'terminal.attach': { params: { projectPath: string }; result: TerminalAttachResult }
  'terminal.input': { params: { projectPath: string; data: string }; result: null }
  'terminal.resize': { params: { projectPath: string; cols: number; rows: number }; result: null }
  'terminal.kill': { params: { projectPath: string }; result: null }

  // version-check (pi + extensions; cache path comes from --user-data)
  'version-check.result': { params: Record<string, never>; result: UpdateCheckResult | null }
  'version-check.recheck': { params: Record<string, never>; result: UpdateCheckResult | null }
  'version-check.update': { params: Record<string, never>; result: { started: boolean; error?: string } }

  // cron (v3 additive, same rule as daemon.info: old clients never call,
  // new clients on an old daemon get not_found). Scheduled prompts: the
  // daemon fires startRuntime + prompt on the job's cron expression while
  // it runs; jobs persist in <userData>/cron.json and simply resume at the
  // next occurrence after a restart (no catch-up for missed runs).
  'cron.list': { params: { projectPath: string }; result: CronJob[] }
  'cron.create': { params: CronCreateInput; result: CronJob }
  'cron.remove': { params: { id: string }; result: null }
  'cron.setEnabled': { params: { id: string; enabled: boolean }; result: CronJob }
  'cron.runNow': { params: { id: string }; result: null }
}

export type DaemonMethodName = keyof DaemonMethodMap & string
