// Shared contract between Electron main, preload, and renderer.
// Both tsconfig.node.json (main/preload) and tsconfig.web.json (renderer)
// include this file, so it must use only portable types.

// ──────────────────────────────────────────────────────────────────────────
// IPC channel whitelist
// ──────────────────────────────────────────────────────────────────────────

export const IPC = {
  // app
  APP_META: 'app:meta',
  APP_PICK_PROJECT: 'app:pick-project',
  APP_REVEAL_PATH: 'app:reveal-path',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_OPEN_GHOSTTY: 'app:open-ghostty',
  APP_OPEN_VSCODE: 'app:open-vscode',
  /** settings General: nativeTheme.themeSource sync (docs/settings-design.md §4). */
  APP_SET_THEME: 'app:set-theme',
  /** settings Updates: GUI app latest-release probe (client-local, 24h cache). */
  APP_GUI_LATEST: 'app:gui-latest',
  /** settings Providers: read-only view of the local pi's ~/.pi/agent/models.json. */
  APP_PROVIDERS_LOCAL: 'app:providers-local',
  /** settings Providers: pi's stored credentials (auth.json), values redacted. */
  APP_AUTH_STATE: 'app:auth-state',
  /** settings Providers: stores an API key in pi's auth.json. */
  APP_AUTH_SET_KEY: 'app:auth-set-key',
  /** settings Providers: removes a stored API key from pi's auth.json. */
  APP_AUTH_REMOVE: 'app:auth-remove',
  /** settings Providers: full model catalog (pi --list-models, client-local). */
  APP_MODELS_LIST: 'app:models-list',
  /** settings Providers: writes defaultProvider/defaultModel into pi's settings.json. */
  APP_DEFAULT_MODEL_SET: 'app:default-model-set',
  // git (project branch / worktree)
  GIT_OVERVIEW: 'git:overview',
  GIT_WORKTREE_CREATE: 'git:worktree-create',
  // projects (recent)
  PROJECTS_LIST: 'projects:list',
  PROJECTS_ADD: 'projects:add',
  PROJECTS_REMOVE: 'projects:remove',
  PROJECTS_EXTENSIONS: 'projects:extensions',
  /** Candidate project dirs on a runtime's machine (remote add flow). */
  PROJECTS_DISCOVER: 'projects:discover',
  /** Add a project onto a specific runtime (④ remote add flow). */
  PROJECTS_ADD_ON: 'projects:add-on',
  // sessions
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_CHANGED: 'sessions:changed',
  SESSIONS_TRACKED: 'sessions:tracked',
  SESSIONS_RENAME: 'sessions:rename',
  /** Removes a session file from this app's tracked registry (→ archive). */
  SESSIONS_ARCHIVE: 'sessions:archive',
  /** Registers a session file as opened by this app (← archive). */
  SESSIONS_TRACK: 'sessions:track',
  // agent runtime
  AGENT_START: 'agent:start',
  AGENT_COMMAND: 'agent:command',
  AGENT_STOP: 'agent:stop',
  AGENT_LIST: 'agent:list',
  AGENT_EVENT: 'agent:event',
  // kanban (docs/kanban-design.md §4; dispatch lands with P2)
  KANBAN_LIST: 'kanban:list',
  KANBAN_CREATE: 'kanban:create',
  KANBAN_UPDATE: 'kanban:update',
  KANBAN_MOVE: 'kanban:move',
  KANBAN_NOTE: 'kanban:note',
  KANBAN_ASSIGN: 'kanban:assign',
  KANBAN_ARCHIVE: 'kanban:archive',
  KANBAN_DISPATCH: 'kanban:dispatch',
  /** Moves an unassigned card into a project store (execution-time gate). */
  KANBAN_MOVE_PROJECT: 'kanban:move-project',
  KANBAN_CHANGED: 'kanban:changed',
  // version-check (pi + extensions upgrade availability)
  VERSION_CHECK_RESULT: 'version-check:result',
  VERSION_CHECK_RECHECK: 'version-check:recheck',
  /** Starts an in-app `pi update --all --no-approve` (explicit user action). */
  VERSION_CHECK_UPDATE: 'version-check:update',
  /** main→renderer push: streamed update output + lifecycle. */
  VERSION_CHECK_PROGRESS: 'version-check:progress',
  // GUI self-update (electron-updater + GitHub Releases, settings Updates)
  APP_UPDATE_CHECK: 'app:update-check',
  APP_UPDATE_DOWNLOAD: 'app:update-download',
  APP_UPDATE_INSTALL: 'app:update-install',
  /** main→renderer push: state machine transitions. */
  APP_UPDATE_STATUS: 'app:update-status',
  // pi bootstrap (first-run setup page): runs pi.dev's official installer in
  // main — client-local, so it works while the daemon is down and while pi —
  // the thing the daemon runs — is missing.
  APP_PI_INSTALL: 'app:pi-install',
  /** main→renderer push: installer stdout/stderr + lifecycle. */
  APP_PI_INSTALL_PROGRESS: 'app:pi-install-progress',
  // settings (④ runtimes: local + remote daemon connections)
  SETTINGS_LIST: 'settings:list',
  SETTINGS_ADD_REMOTE: 'settings:add-remote',
  SETTINGS_REMOVE_REMOTE: 'settings:remove-remote',
  SETTINGS_RECONNECT: 'settings:reconnect',
  SETTINGS_TEST: 'settings:test',
  SETTINGS_CHANGED: 'settings:changed',
  /** iOS connect QR for a runtime: main composes the pion:// link (token
   * stays main-side until the user explicitly asks to show it). */
  SETTINGS_QR: 'settings:qr',
  // ④ R3-2 dial-home pairing: local pairing listener + one-time pair tokens
  SETTINGS_PAIRING_START: 'settings:pairing-start',
  SETTINGS_PAIRING_CANCEL: 'settings:pairing-cancel',
  SETTINGS_SET_LISTENER: 'settings:set-listener',
  SETTINGS_STATUS: 'settings:status',
} as const

/**
 * Sentinel "project" for cards created without one. They live in a global
 * event log in the app's userData (same schema/append-only rules) and MUST be
 * moved into a real project before dispatch/assign — execution requires a
 * project, creation does not.
 */
export const KANBAN_UNASSIGNED = '__unassigned__'

// ──────────────────────────────────────────────────────────────────────────
// App / project / session DTOs
// ──────────────────────────────────────────────────────────────────────────

export interface AppMeta {
  version: string
  platform: string
  homeDir: string
  piPath: string | null
  piVersion: string | null
  problem?: { reason: string }
}

/** Appearance preference (settings General); 'system' follows the OS. */
export type ThemeSetting = 'system' | 'light' | 'dark'

/** GUI app latest-release probe (settings Updates). `latest` is null when the
 * app has no configured release feed (package.json repository) or the check
 * failed (offline) — the UI degrades to current-version-only. */
export interface GuiUpdateInfo {
  version: string
  latest: string | null
  /** Releases page URL when a repository is configured. */
  releaseUrl: string | null
  checkedAt: string
}

/** Self-update state machine (electron-updater, settings Updates). 'dev' =
 * unpackaged run, which can never self-update. */
export interface AppUpdateStatus {
  state: 'dev' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  /** Download progress 0..100 while state === 'downloading'. */
  percent?: number
  /** New version string once known. */
  version?: string
  /** Error message when state === 'error'. */
  message?: string
}

/** One custom provider from the local pi's ~/.pi/agent/models.json (settings
 * Providers, read-only). Keys are redacted to a boolean — plaintext never
 * enters the renderer. Local-only by design (settings-design.md §5 P2);
 * remote runtimes get their own view with daemon methods (protocol v2). */
export interface ProviderSummary {
  name: string
  baseUrl: string
  api: string
  modelCount: number
  hasApiKey: boolean
}

export interface ProvidersLocalResult {
  /** Source models.json path, for open-in-editor / reveal. */
  path: string | null
  /** pi's settings.json defaults (editable via app.setDefaultModel). */
  defaultProvider: string | null
  defaultModel: string | null
  providers: ProviderSummary[]
}

/** One provider the GUI can store an API key for: pi's built-in API-key
 * providers plus the user's models.json providers (custom). */
export interface AuthProviderCandidate {
  id: string
  name: string
  /** pi's environment variable for a built-in provider (the alternative to
   * storing a key: export it before launching pi). */
  env?: string
  /** Declared in the user's models.json rather than pi's built-in catalog. */
  custom?: boolean
}

/** One credential in pi's ~/.pi/agent/auth.json. Never carries a value. */
export interface ConfiguredAuthProvider {
  id: string
  name: string
  kind: 'api_key' | 'oauth'
  /** api_key entries can be replaced/removed here; oauth entries are pi's own
   * `/login` (`refresh`/rotation semantics live there) and stay read-only. */
  removable: boolean
}

export interface AuthStateResult {
  configured: ConfiguredAuthProvider[]
  candidates: AuthProviderCandidate[]
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  lastOpenedAt: string
  /** ④: owning runtime id ('local' or a settings runtime id), assigned by the
   * main proxy from the serving connection; absent on pre-v2 records. */
  runtime?: string
  /** Whether the owning runtime's daemon is currently reachable. */
  connected?: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// Settings — runtime registry (④ remote runtimes, goal.md §9)
// ──────────────────────────────────────────────────────────────────────────

/** One runtime the app can route projects to. 'local' is the builtin spawned
 * daemon (id fixed, non-removable); 'remote' entries come from settings.
 * `connected` reflects the live connection state (renderer offline badges).
 * Tokens never appear here — they stay encrypted in main's userData. */
export interface SettingsRuntime {
  id: string
  name: string
  host?: string
  port?: number
  kind: 'local' | 'remote'
  connected: boolean
}

export interface SettingsRuntimeChange {
  id: string
  connected: boolean
}

/** `pion://` connect payload for the iOS app's scan-to-add flow (settings
 * Runtimes → QR). `url` embeds the token by design — it is only materialized
 * on explicit user action, like the pairing command preview. `assumed` marks
 * a fallback: the daemon could not be asked (daemon.info) for its WS
 * listener, so the dual-port default (tcp port+1) is used. */
export interface SettingsQrInfo {
  url: string
  host: string
  wsPort: number
  assumed: boolean
}

/** ④ R3-2: dial-home pairing session started in main. `token` is present
 * only while pairing is active (pairing needs to display the dial command;
 * runtime LIST entries never carry tokens). */
export interface SettingsPairingInfo {
  port: number
  token: string
  /** All non-internal IPv4 addresses, for the command preview. */
  hosts: string[]
  /** Ready-to-run remote command preview using hosts[0]. */
  command: string
  /** Local path of the single-file daemon bundle to copy to the remote
   * machine (kept fresh in userData; the command references its filename). */
  daemonFile: string
  expiresAt: string
}

/** ④ R3-2: dial-home listener + pairing status (pull-based settings page). */
export interface SettingsStatus {
  listenerEnabled: boolean
  listenerPort: number | null
  pairing: { active: true; token: string; expiresAt: string } | null
}

/** Result envelope for settings.addRemote / settings.test — connection
 * attempts can fail visibly without throwing. */
export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'failed' | 'unknown'

// ──────────────────────────────────────────────────────────────────────────
// Git (branch / worktree overview)
// ──────────────────────────────────────────────────────────────────────────

export interface GitBranchInfo {
  name: string
  /** Absolute path of the worktree this branch is checked out in, if any. */
  worktreePath: string | null
}

export interface GitOverview {
  isRepo: boolean
  currentBranch: string | null
  branches: GitBranchInfo[]
}

export interface WorktreeCreated {
  path: string
}

export interface SessionRecord {
  id: string
  filePath: string
  projectPath: string
  title: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  model?: string
  provider?: string
  thinkingLevel?: string
  messageCount?: number
  preview?: string
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime info (get_state projection)
// ──────────────────────────────────────────────────────────────────────────

export interface PiModelInfo {
  id?: string
  name?: string
  provider?: string
}

/** One entry of pi's get_commands registry listing (extensions, prompt
 * templates, and skills). */
export interface PiCommandInfo {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  sourceInfo?: PiCommandSourceInfo
}

/** Where a command came from, as pi reports it. Adapters for community plugins
 * key on `source` ("npm:<package>"); the directory fields let a plugin loaded
 * from a local checkout match too. */
export interface PiCommandSourceInfo {
  path?: string
  source?: string
  scope?: string
  origin?: string
  baseDir?: string
}

/** One entry of pi's get_available_models registry listing. */
export interface PiAvailableModel {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
}

/** pi `get_session_stats` → `data.contextUsage` (mirrors pi's ContextUsage).
 * The current context-window estimate, i.e. what pi itself shows in its footer
 * and feeds to its compaction policy — not a cumulative session total. */
export interface ContextUsage {
  /** Estimated context tokens; null right after compaction, before the next
   * LLM response reports usage again. */
  tokens: number | null
  contextWindow: number
  /** tokens as a percentage of contextWindow; null while tokens is unknown. */
  percent: number | null
}

export interface RuntimeInfo {
  runtimeId: string
  cwd: string
  sessionId?: string
  sessionFile?: string
  isStreaming: boolean
  isCompacting?: boolean
  thinkingLevel?: string
  model?: PiModelInfo | null
  /** Started with --no-extensions because one of pi's extensions failed to
   * load; the rest of the user's extensions are unavailable in this runtime. */
  extensionsDisabled?: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// RPC commands (renderer → main → pi stdin)
// ──────────────────────────────────────────────────────────────────────────

export type RpcCommand =
  | { type: 'new_session'; parentSession?: string }
  | { type: 'prompt'; message: string; images?: PromptImage[] }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'get_state' }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'set_session_name'; name: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'get_available_models' }
  | { type: 'get_available_thinking_levels' }
  | { type: 'get_commands' }
  | { type: 'get_session_stats' }
  | {
      type: 'extension_ui_response'
      id: string
      value?: string
      confirmed?: boolean
      cancelled?: boolean
    }

export interface PromptImage {
  type: 'image'
  data: string
  mimeType: string
}

export interface AgentStartOptions {
  projectPath: string
  sessionPath?: string
  provider?: string
  modelId?: string
  thinking?: string
  /**
   * Main-internal only: preload/main strip this from every renderer request,
   * so the renderer can never inject extension paths (design §4). Kanban
   * dispatch passes the bundled kanban-bridge here.
   */
  extensions?: string[]
}

// ──────────────────────────────────────────────────────────────────────────
// RPC response (pi stdout → main → renderer)
// ──────────────────────────────────────────────────────────────────────────

export interface RpcResponse {
  type: 'response'
  id: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

// ──────────────────────────────────────────────────────────────────────────
// PI events (pi stdout → main → renderer via AGENT_EVENT channel)
// ──────────────────────────────────────────────────────────────────────────

export interface PiEventEnvelope {
  runtimeId: string
  event: PiEvent
}

// The union of PI RPC events we care about. Unknown event types are forwarded
// as-is in the generic `Record<string, unknown>` arm; the renderer's reducer
// ignores anything it does not recognize.
export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages?: unknown[]; willRetry?: boolean }
  | { type: 'agent_settled' }
  | { type: 'turn_start'; message?: unknown }
  | { type: 'turn_end'; message?: unknown; toolResults?: unknown[] }
  | { type: 'message_start'; message?: unknown }
  | { type: 'message_update'; assistantMessageEvent?: AssistantMessageEvent; usage?: unknown }
  | { type: 'message_end'; message?: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult?: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; willRetry?: boolean }
  | { type: 'auto_retry_start' }
  | { type: 'auto_retry_end' }
  | { type: 'session_action_update'; actions?: unknown }
  | { type: 'entry_appended'; entry?: unknown }
  | { type: 'extension_ui_request'; id: string; method: string; [key: string]: unknown }
  | { type: 'extension_error'; error?: string; extensionPath?: string }
  | { type: 'runtime_exit'; code: number | null; signal: string | null; expected?: boolean }
  | { type: 'transport_error'; error: string }
  | { type: 'transport_limit'; kind: string; error: string }
  | { type: 'orphan_response'; command: string }
  | { type: 'ready' }
  | { type: 'available_commands_update' }
  | (Record<string, unknown> & { type: string })

export interface AssistantMessageEvent {
  type: string // text_start, text_delta, text_end, thinking_*, toolcall_*
  delta?: string
  contentIndex?: number
  toolCall?: {
    type?: string
    id?: string
    name?: string
    arguments?: unknown
    args?: unknown
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Session list / read DTOs
// ──────────────────────────────────────────────────────────────────────────

export interface SessionChangeEvent {
  filePath?: string
  projectPath?: string
}

// ──────────────────────────────────────────────────────────────────────────
// Kanban (docs/kanban-design.md — DTOs are the shared contract; the event
// log <project>/.pion/kanban/events.jsonl is the only truth)
// ──────────────────────────────────────────────────────────────────────────

export type CardStatus = 'todo' | 'in_progress' | 'review' | 'done'

/**
 * Runtime-only projection derived by main from the runtime pool for the
 * card's assigned session; never persisted. Restart falls back to idle.
 */
export type CardRunState = 'idle' | 'starting' | 'running' | 'settled' | 'failed'

/** Who performed an action: the user, a worker agent, or the system (main). */
export type KanbanActor = 'user' | 'agent' | 'system'

export interface KanbanNote {
  id: string
  source: KanbanActor
  text: string
  /** Fold-time copy of the note_added event's ts; set by the reducer. */
  at?: string
  /** Worker session that produced an agent note; used for transcript jump. */
  sessionFile?: string
}

export interface KanbanCard {
  id: string // 'k_' + 8 random chars
  title: string
  body?: string // markdown
  acceptance?: string[]
  status: CardStatus
  assignee?: { sessionFile?: string; model?: string; label?: string }
  runState: CardRunState
  notes: KanbanNote[]
  /** Archived cards stay in the log for audit; hidden by default on the board. */
  archived?: boolean
  /**
   * Projection field stamped by kanban:list: which project store this card
   * belongs to. Not an event field — a card's project IS its store location
   * (<project>/.pion/kanban/); the aggregated all-projects board relies on it
   * for filtering and for routing ops/dispatch to the right store.
   */
  projectPath?: string
  createdAt: string
  updatedAt: string
}

export interface KanbanBoard {
  projectPath: string
  cards: KanbanCard[]
}

/**
 * Append-only event schema v1 (docs/kanban-design.md §2). One JSON object per
 * line in events.jsonl; unknown types are skipped on replay (forward compat).
 */
export type KanbanEvent =
  | { v: 1; type: 'card_created'; id: string; title: string; body?: string; acceptance?: string[]; ts: string }
  | { v: 1; type: 'card_updated'; id: string; title?: string; body?: string; acceptance?: string[]; ts: string }
  | { v: 1; type: 'card_moved'; id: string; to: CardStatus; by: KanbanActor; ts: string }
  | { v: 1; type: 'card_assigned'; id: string; sessionFile?: string; model?: string; label?: string; ts: string }
  | { v: 1; type: 'note_added'; id: string; note: KanbanNote; ts: string }
  | { v: 1; type: 'card_archived'; id: string; ts: string }

export interface KanbanCreateInput {
  title: string
  body?: string
  acceptance?: string[]
}

export interface KanbanUpdateInput {
  title?: string
  body?: string
  acceptance?: string[]
}

/** Binds a card to an existing session without dispatching it. */
export interface KanbanAssignInput {
  sessionFile: string
  model?: string
  label?: string
}

/** Dispatches a card to an agent: fresh session, or an explicit session file. */
export interface KanbanDispatchInput {
  fresh: boolean
  sessionFile?: string
  modelId?: string
}

export interface KanbanChangeEvent {
  projectPath: string
}

// ──────────────────────────────────────────────────────────────────────────
// Version check (pi + installed extensions upgrade availability)
// ──────────────────────────────────────────────────────────────────────────

export interface UpdateCheckEntry {
  /** "pi" for the pi executable itself, "extension" for an installed package. */
  kind: 'pi' | 'extension'
  /** npm package name, e.g. "@earendil-works/pi-coding-agent" or "pi-mcp-adapter". */
  name: string
  /** Installed version, or null if it could not be read. */
  installed: string | null
  /** Latest version from the npm registry, or null if the lookup failed. */
  latest: string | null
  /** True when latest is strictly greater than installed (update available). */
  outdated: boolean
}

export interface UpdateCheckResult {
  /** Epoch ms of the check. */
  checkedAt: number
  entries: UpdateCheckEntry[]
  /** Number of entries with outdated === true (convenience for the badge). */
  outdatedCount: number
  /** Present when the whole check could not run (no pi / no network). */
  error?: string
}

/** Streamed progress of an in-app `pi update --all --no-approve` run. */
export interface UpdateProgressEvent {
  /** True from spawn until process exit. */
  running: boolean
  /** One streamed stdout/stderr line (present on line events). */
  line?: string
  /** Present on the terminal event: process exited. */
  done?: boolean
  /** Exit code when done (0 = success). */
  code?: number
  /** Present when the update could not be started at all. */
  error?: string
}

// ──────────────────────────────────────────────────────────────────────────
// Preload API surface (context-isolated)
// ──────────────────────────────────────────────────────────────────────────

export interface PiGuiApi {
  app: {
    getMeta: () => Promise<AppMeta>
    pickProject: () => Promise<ProjectRecord | null>
    revealPath: (path: string) => Promise<void>
    openExternal: (url: string) => Promise<void>
    /** Opens a directory in the Ghostty terminal app. */
    openGhostty: (path: string) => Promise<void>
    /** Opens a directory in VS Code. */
    openVSCode: (path: string) => Promise<void>
    /** Syncs the appearance preference to nativeTheme.themeSource. */
    setTheme: (theme: ThemeSetting) => Promise<void>
    /** GUI latest-release probe (24h-cached in main; null latest when no
     * release feed is configured or offline). */
    guiUpdate: () => Promise<GuiUpdateInfo>
    /** In-app self-update (electron-updater + GitHub Releases). */
    appUpdate: {
      status: () => Promise<AppUpdateStatus>
      check: () => Promise<AppUpdateStatus>
      download: () => Promise<AppUpdateStatus>
      install: () => Promise<void>
      /** Subscribes to state pushes; returns an unsubscribe function. */
      onStatus: (cb: (s: AppUpdateStatus) => void) => () => void
    }
    /** Read-only view of the local pi's custom providers (models.json). */
    providersLocal: () => Promise<ProvidersLocalResult>
    /** Credentials stored in pi's auth.json (ids + kinds only, never values).
     * Written by the daemon on the machine pi runs on. */
    authState: () => Promise<AuthStateResult>
    /** Stores an API key for a provider; returns the fresh state. */
    authSetKey: (provider: string, key: string) => Promise<AuthStateResult>
    /** Removes a stored API-key credential; returns the fresh state. */
    authRemove: (provider: string) => Promise<AuthStateResult>
    /** Runs pi.dev's official installer (first-run setup page). Explicit user
     * action only; returns { started: false, error } when it could not start. */
    installPi: () => Promise<{ started: boolean; error?: string }>
    /** Subscribes to installer progress; returns an unsubscribe function. */
    onInstallProgress: (cb: (e: UpdateProgressEvent) => void) => () => void
    /** Full model catalog from `pi --list-models` (cached in main). */
    modelsList: () => Promise<PiAvailableModel[]>
    /** Persists defaultProvider/defaultModel into pi's settings.json. */
    setDefaultModel: (provider: string, modelId: string) => Promise<void>
  }
  git: {
    /** Branch / worktree overview for a project directory. */
    overview: (projectPath: string) => Promise<GitOverview>
    /** Creates a worktree for an existing or new branch; idempotent when the
     * branch already has one. */
    createWorktree: (projectPath: string, branch: string) => Promise<WorktreeCreated>
  }
  projects: {
    list: () => Promise<ProjectRecord[]>
    add: (path: string) => Promise<ProjectRecord>
    remove: (id: string) => Promise<void>
    /** File names of the project's own extensions (<project>/.pi/extensions). */
    extensions: (projectPath: string) => Promise<string[]>
    /** Candidate project directories on a runtime (its machine's session
     * buckets), for the add-from-remote flow. */
    discover: (runtimeId?: string) => Promise<string[]>
    /** Adds a project onto a specific runtime's daemon (④ remote flow). */
    addOn: (path: string, runtimeId: string) => Promise<ProjectRecord>
  }
  settings: {
    list: () => Promise<SettingsRuntime[]>
    addRemote: (input: { name: string; host: string; port: number; token: string }) => Promise<SettingsResult<SettingsRuntime>>
    removeRemote: (id: string) => Promise<void>
    /** Immediate reconnect of a stored remote runtime (settings button):
     * bypasses the backoff ladder; resolves ok when hello passes. */
    reconnect: (id: string) => Promise<SettingsResult<null>>
    /** One-shot connection probe without storing credentials. */
    test: (input: { host: string; port: number; token: string }) => Promise<SettingsResult<{ daemonVersion: string }>>
    onChanged: (cb: (e: SettingsRuntimeChange) => void) => () => void
    /** ④ R3-2 dial-home pairing: starts (or restarts) a one-time pairing
     * window and returns the dial command to run on the remote machine. */
    pairing: {
      start: (input?: { port?: number }) => Promise<SettingsResult<SettingsPairingInfo>>
      cancel: () => Promise<void>
    }
    /** Enables/disables the dial-home listener (kept independent of an
     * active pairing window; accepted runtimes stay connected on disable). */
    setListener: (input: { enabled: boolean; port?: number }) => Promise<SettingsResult<SettingsStatus>>
    status: () => Promise<SettingsStatus>
    /** iOS connect QR payload for a runtime ('local' or a remote id). */
    qr: (id: string) => Promise<SettingsResult<SettingsQrInfo>>
  }
  sessions: {
    list: (projectPath: string, force?: boolean) => Promise<SessionRecord[]>
    /** Reads the session JSONL transcript. runtimeId routes the read to the
     * daemon that owns the runtime (remote session files live remotely). */
    read: (filePath: string, runtimeId?: string) => Promise<{ messages: unknown[] }>
    onChanged: (cb: (e: SessionChangeEvent) => void) => () => void
    /** Session files created or opened in this app, for the given project. */
    tracked: (projectPath: string) => Promise<string[]>
    /** Renames a session by appending a session_info record to its JSONL.
     * projectPath routes the call to the daemon owning the project. */
    rename: (filePath: string, name: string, projectPath?: string) => Promise<void>
    /** Removes a session from this app's tracked registry; it becomes
     * archived until opened or tracked again. projectPath routes the call
     * to the daemon owning the project. */
    archive: (filePath: string, projectPath?: string) => Promise<void>
    /** Registers a session file as opened by this app without opening it. */
    track: (projectPath: string, filePath: string) => Promise<void>
  }
  agent: {
    start: (options: AgentStartOptions) => Promise<RuntimeInfo>
    command: (runtimeId: string, command: RpcCommand) => Promise<RpcResponse>
    stop: (runtimeId: string) => Promise<boolean>
    list: () => Promise<RuntimeInfo[]>
    onEvent: (cb: (envelope: PiEventEnvelope) => void) => () => void
  }
  kanban: {
    list: (projectPath: string) => Promise<KanbanBoard>
    create: (projectPath: string, input: KanbanCreateInput) => Promise<KanbanCard>
    update: (projectPath: string, cardId: string, patch: KanbanUpdateInput) => Promise<KanbanCard>
    move: (projectPath: string, cardId: string, to: CardStatus) => Promise<KanbanCard>
    note: (projectPath: string, cardId: string, text: string) => Promise<KanbanCard>
    assign: (projectPath: string, cardId: string, input: KanbanAssignInput) => Promise<KanbanCard>
    archive: (projectPath: string, cardId: string) => Promise<void>
    dispatch: (projectPath: string, cardId: string, input: KanbanDispatchInput) => Promise<RuntimeInfo>
    /** Moves an unassigned card into a project store (same id, history kept). */
    moveProject: (projectPath: string, cardId: string, toProjectPath: string) => Promise<KanbanCard>
    onChanged: (cb: (e: KanbanChangeEvent) => void) => () => void
  }
  updates: {
    /** Latest cached result (null until the first check completes). */
    result: () => Promise<UpdateCheckResult | null>
    /** Force a fresh check, ignoring the cache. Resolves the new result. */
    recheck: () => Promise<UpdateCheckResult | null>
    /** Pushed on first result and on every recheck. */
    onChanged: (cb: (result: UpdateCheckResult) => void) => () => void
    /** Runs `pi update --all --no-approve` in the main process. Explicit
     * user action only; resolves whether the process was started. */
    run: () => Promise<{ started: boolean; error?: string }>
    /** Streamed update output; a final event has done: true. */
    onProgress: (cb: (e: UpdateProgressEvent) => void) => () => void
  }
}

declare global {
  interface Window {
    pi: PiGuiApi
  }
}
