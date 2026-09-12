// Preload: context-isolated allowlisted bridge. Renderer only sees `window.pi`.
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppMeta,
  ProjectRecord,
  SessionRecord,
  RuntimeInfo,
  RpcCommand,
  RpcResponse,
  PiEventEnvelope,
  SessionChangeEvent,
  AgentStartOptions,
  GitOverview,
  GitFileDiff,
  GitStatusResult,
  WorktreeCreated,
  PiGuiApi,
  CardStatus,
  KanbanAssignInput,
  KanbanBoard,
  KanbanCard,
  KanbanChangeEvent,
  KanbanCreateInput,
  KanbanDispatchInput,
  KanbanUpdateInput,
  CronCreateInput,
  CronJob,
  TerminalAttachResult,
  SettingsResult,
  SettingsRuntime,
  SettingsPairingInfo,
  SettingsQrInfo,
  SettingsStatus,
  SettingsRuntimeChange,
  UpdateCheckResult,
  AppUpdateStatus,
  UpdateProgressEvent,
  CommunityPackage,
  ThemeSetting,
  GuiUpdateInfo,
  ProvidersLocalResult,
  AuthStateResult,
  PiAvailableModel,
} from '../../src/types'
import { IPC } from '../../src/types'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// One ipcRenderer listener per channel with a single replaceable callback.
// This guarantees each event dispatches exactly once, even if a hook's
// effect re-runs (StrictMode) or HMR leaves a stale listener behind: there is
// never more than one active callback per channel.
const channels = new Map<string, { listener: (_e: Electron.IpcRendererEvent, payload: unknown) => void; callback: ((payload: unknown) => void) | null }>()

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  let entry = channels.get(channel)
  if (!entry) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const cb = channels.get(channel)?.callback
      if (cb && isObject(payload)) cb(payload as T)
    }
    entry = { listener, callback: null }
    channels.set(channel, entry)
    ipcRenderer.on(channel, listener)
  }
  // Replace any prior callback so only the latest subscriber receives events.
  entry.callback = callback as (payload: unknown) => void
  return () => {
    const current = channels.get(channel)
    if (current && current.callback === callback) current.callback = null
  }
}

// Validate a command before it crosses the trust boundary into the main process.
function validateCommand(command: RpcCommand): void {
  if (!isObject(command)) throw new TypeError('command must be an object')
  if (typeof command.type !== 'string' || !command.type) throw new TypeError('command.type must be a non-empty string')
  const allowed = new Set([
    'new_session', 'prompt', 'steer', 'follow_up', 'abort', 'get_state',
    'switch_session', 'set_session_name', 'set_model', 'set_thinking_level',
    'get_available_models', 'get_available_thinking_levels', 'get_commands',
    'get_session_stats',
    'extension_ui_response',
  ])
  if (!allowed.has(command.type)) throw new TypeError(`RPC command ${command.type} is not allowed`)
  if (command.type === 'prompt') {
    if (typeof command.message !== 'string' || !command.message) throw new TypeError('message must be a non-empty string')
    // Images ride only on prompt — steer/follow_up have no images field on the
    // PI wire contract. Keep the allowlist strict at the trust boundary.
    if (command.images !== undefined) {
      const images = command.images
      if (!Array.isArray(images) || images.length > 8) throw new TypeError('images must be an array with at most 8 items')
      for (const img of images) {
        if (!isObject(img) || img.type !== 'image') throw new TypeError('each image must be { type: "image", data, mimeType }')
        if (typeof img.mimeType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/i.test(img.mimeType)) {
          throw new TypeError('image mimeType must be png, jpeg, gif or webp')
        }
        if (typeof img.data !== 'string' || !img.data || img.data.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/i.test(img.data)) {
          throw new TypeError('image data must be a canonical base64 string')
        }
      }
    }
  } else if (command.type === 'steer' || command.type === 'follow_up') {
    if (typeof command.message !== 'string' || !command.message) throw new TypeError('message must be a non-empty string')
  }
  if (command.type === 'switch_session' && typeof command.sessionPath !== 'string') {
    throw new TypeError('sessionPath must be a string')
  }
  if (command.type === 'set_session_name' && typeof command.name !== 'string') {
    throw new TypeError('name must be a string')
  }
  if (command.type === 'extension_ui_response' && typeof command.id !== 'string') {
    throw new TypeError('id must be a string')
  }
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

// ── Kanban input validation (mirror of the main-process checks) ─────────────

const KANBAN_STATUS_SET = new Set<string>(['todo', 'in_progress', 'review', 'done'])

function assertString(value: unknown, name: string, maxLength?: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  if (maxLength !== undefined && value.length > maxLength) throw new TypeError(`${name} is too long`)
  return value
}

function assertNonEmptyString(value: unknown, name: string, maxLength?: number): string {
  const str = assertString(value, name, maxLength)
  if (!str.trim()) throw new TypeError(`${name} must not be empty`)
  return str
}

function assertPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError('port must be an integer in 1..65535')
  }
  return value
}

function assertProjectPath(projectPath: unknown): string {
  return assertNonEmptyString(projectPath, 'projectPath')
}

function assertAcceptance(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20 || value.some((a) => typeof a !== 'string' || a.length > 500)) {
    throw new TypeError('acceptance must be an array of at most 20 strings (500 chars each)')
  }
  return value as string[]
}

function asKanbanCreateInput(input: unknown): KanbanCreateInput {
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
  const v = input as Record<string, unknown>
  return {
    title: assertNonEmptyString(v.title, 'title', 200),
    ...(v.body !== undefined ? { body: assertString(v.body, 'body', 32768) } : {}),
    ...(v.acceptance !== undefined ? { acceptance: assertAcceptance(v.acceptance) } : {}),
  }
}

function asKanbanUpdateInput(patch: unknown): KanbanUpdateInput {
  if (!patch || typeof patch !== 'object') throw new TypeError('patch must be an object')
  const v = patch as Record<string, unknown>
  return {
    ...(v.title !== undefined ? { title: assertNonEmptyString(v.title, 'title', 200) } : {}),
    ...(v.body !== undefined ? { body: assertString(v.body, 'body', 32768) } : {}),
    ...(v.acceptance !== undefined ? { acceptance: assertAcceptance(v.acceptance) } : {}),
  }
}

function asCronCreateInput(input: unknown): CronCreateInput {
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
  const v = input as Record<string, unknown>
  return {
    projectPath: assertProjectPath(v.projectPath),
    schedule: assertNonEmptyString(v.schedule, 'schedule', 100),
    prompt: assertNonEmptyString(v.prompt, 'prompt', 8192),
    ...(v.name !== undefined ? { name: assertString(v.name, 'name', 80) } : {}),
  }
}

function asKanbanAssignInput(input: unknown): KanbanAssignInput {
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
  const v = input as Record<string, unknown>
  return {
    sessionFile: assertNonEmptyString(v.sessionFile, 'sessionFile'),
    ...(v.model !== undefined ? { model: assertString(v.model, 'model', 100) } : {}),
    ...(v.label !== undefined ? { label: assertString(v.label, 'label', 100) } : {}),
  }
}

// Strict whitelist rebuild of agent start options. `extensions` is
// main-internal (kanban dispatch) and is deliberately NOT expressible here:
// a compromised renderer must never be able to inject an extension path.
function asAgentStartOptions(options: unknown): AgentStartOptions {
  if (!options || typeof options !== 'object') throw new TypeError('options must be an object')
  const v = options as Record<string, unknown>
  return {
    projectPath: assertNonEmptyString(v.projectPath, 'projectPath'),
    ...(v.sessionPath !== undefined ? { sessionPath: assertString(v.sessionPath, 'sessionPath') } : {}),
    ...(v.provider !== undefined ? { provider: assertString(v.provider, 'provider', 100) } : {}),
    ...(v.modelId !== undefined ? { modelId: assertString(v.modelId, 'modelId', 200) } : {}),
    ...(v.thinking !== undefined ? { thinking: assertString(v.thinking, 'thinking', 50) } : {}),
  }
}

function asKanbanDispatchInput(input: unknown): KanbanDispatchInput {
  if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
  const v = input as Record<string, unknown>
  if (typeof v.fresh !== 'boolean') throw new TypeError('fresh must be a boolean')
  return {
    fresh: v.fresh,
    ...(v.sessionFile !== undefined ? { sessionFile: assertNonEmptyString(v.sessionFile, 'sessionFile') } : {}),
    ...(v.modelId !== undefined ? { modelId: assertString(v.modelId, 'modelId', 200) } : {}),
  }
}

const api: PiGuiApi = {
  app: {
    getMeta: () => invoke<AppMeta>(IPC.APP_META),
    pickProject: () => invoke<ProjectRecord | null>(IPC.APP_PICK_PROJECT),
    revealPath: (path) => invoke<void>(IPC.APP_REVEAL_PATH, path),
    openExternal: (url) => invoke<void>(IPC.APP_OPEN_EXTERNAL, url),
    openGhostty: (path) => invoke<void>(IPC.APP_OPEN_GHOSTTY, path),
    openVSCode: (path) => invoke<void>(IPC.APP_OPEN_VSCODE, path),
    /** Grows (or shrinks, negative delta) the window width to the right,
     * clamped to the display's work area. Used by the changes panel so
     * opening it expands the window instead of squeezing the center. */
    growWindow: (delta) => {
      if (typeof delta !== 'number' || !Number.isFinite(delta)) throw new TypeError('delta must be a number')
      return invoke<number>(IPC.APP_GROW_WINDOW, Math.trunc(delta))
    },
    setTheme: (theme) => {
      if (theme !== 'system' && theme !== 'light' && theme !== 'dark') throw new TypeError('theme must be system|light|dark')
      return invoke<void>(IPC.APP_SET_THEME, theme)
    },
    guiUpdate: () => invoke<GuiUpdateInfo>(IPC.APP_GUI_LATEST),
    appUpdate: {
      status: () => invoke<AppUpdateStatus>(IPC.APP_UPDATE_STATUS),
      check: () => invoke<AppUpdateStatus>(IPC.APP_UPDATE_CHECK),
      download: () => invoke<AppUpdateStatus>(IPC.APP_UPDATE_DOWNLOAD),
      install: () => invoke<void>(IPC.APP_UPDATE_INSTALL),
      onStatus: (cb: (s: AppUpdateStatus) => void) => {
        const listener = (_e: Electron.IpcRendererEvent, s: AppUpdateStatus) => cb(s)
        ipcRenderer.on(IPC.APP_UPDATE_STATUS, listener)
        return () => ipcRenderer.removeListener(IPC.APP_UPDATE_STATUS, listener)
      },
    },
    providersLocal: () => invoke<ProvidersLocalResult>(IPC.APP_PROVIDERS_LOCAL),
    authState: () => invoke<AuthStateResult>(IPC.APP_AUTH_STATE),
    authSetKey: (provider, key) =>
      invoke<AuthStateResult>(IPC.APP_AUTH_SET_KEY, assertNonEmptyString(provider, 'provider', 100), assertNonEmptyString(key, 'key', 4096)),
    authRemove: (provider) => invoke<AuthStateResult>(IPC.APP_AUTH_REMOVE, assertNonEmptyString(provider, 'provider', 100)),
    installPi: () => invoke<{ started: boolean; error?: string }>(IPC.APP_PI_INSTALL),
    onInstallProgress: (cb) => subscribe<UpdateProgressEvent>(IPC.APP_PI_INSTALL_PROGRESS, cb),
    notify: (payload: { title: string; body: string }) => {
      if (!isObject(payload) || typeof payload.title !== 'string' || typeof payload.body !== 'string') {
        throw new TypeError('notify payload must be { title: string, body: string }')
      }
      return invoke<boolean>(IPC.APP_NOTIFY, payload)
    },
    modelsList: () => invoke<PiAvailableModel[]>(IPC.APP_MODELS_LIST),
    setDefaultModel: (provider: string, modelId: string) =>
      invoke<void>(IPC.APP_DEFAULT_MODEL_SET, assertNonEmptyString(provider, 'provider', 100), assertNonEmptyString(modelId, 'modelId', 200)),
  },
  git: {
    overview: (projectPath) => invoke<GitOverview>(IPC.GIT_OVERVIEW, projectPath),
    changedFiles: (projectPath) => invoke<GitStatusResult>(IPC.GIT_CHANGED_FILES, assertProjectPath(projectPath)),
    fileDiff: (projectPath, path) =>
      invoke<GitFileDiff>(IPC.GIT_FILE_DIFF, assertProjectPath(projectPath), assertNonEmptyString(path, 'path', 4096)),
    createWorktree: (projectPath, branch) => invoke<WorktreeCreated>(IPC.GIT_WORKTREE_CREATE, projectPath, branch),
  },
  projects: {
    list: () => invoke<ProjectRecord[]>(IPC.PROJECTS_LIST),
    add: (path) => invoke<ProjectRecord>(IPC.PROJECTS_ADD, path),
    remove: (id) => invoke<void>(IPC.PROJECTS_REMOVE, id),
    extensions: (projectPath) => invoke<string[]>(IPC.PROJECTS_EXTENSIONS, projectPath),
    discover: (runtimeId) => invoke<string[]>(IPC.PROJECTS_DISCOVER, runtimeId === undefined ? undefined : assertNonEmptyString(runtimeId, 'runtimeId')),
    /** Adds a project to a specific runtime's daemon (remote add flow).
     * Without runtimeId the add goes to the local daemon as before. */
    addOn: (path: string, runtimeId: string) =>
      invoke<ProjectRecord>(IPC.PROJECTS_ADD_ON, assertNonEmptyString(path, 'path', 4096), assertNonEmptyString(runtimeId, 'runtimeId')),
  },
  settings: {
    list: () => invoke<SettingsRuntime[]>(IPC.SETTINGS_LIST),
    addRemote: (input) => {
      if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
      const v = input as Record<string, unknown>
      return invoke<SettingsResult<SettingsRuntime>>(
        IPC.SETTINGS_ADD_REMOTE,
        assertNonEmptyString(v.name, 'name', 100),
        assertNonEmptyString(v.host, 'host', 253),
        assertPort(v.port),
        assertNonEmptyString(v.token, 'token', 1024),
      )
    },
    removeRemote: (id) => invoke<void>(IPC.SETTINGS_REMOVE_REMOTE, assertNonEmptyString(id, 'id')),
    reconnect: (id) => invoke<SettingsResult<null>>(IPC.SETTINGS_RECONNECT, assertNonEmptyString(id, 'id')),
    test: (input) => {
      if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
      const v = input as Record<string, unknown>
      return invoke<SettingsResult<{ daemonVersion: string }>>(
        IPC.SETTINGS_TEST,
        assertNonEmptyString(v.host, 'host', 253),
        assertPort(v.port),
        assertNonEmptyString(v.token, 'token', 1024),
      )
    },
    onChanged: (cb) => subscribe<SettingsRuntimeChange>(IPC.SETTINGS_CHANGED, cb),
    pairing: {
      start: (input) => {
        if (input === undefined) return invoke<SettingsResult<SettingsPairingInfo>>(IPC.SETTINGS_PAIRING_START)
        if (typeof input !== 'object' || input === null) throw new TypeError('input must be an object')
        const v = input as Record<string, unknown>
        return invoke<SettingsResult<SettingsPairingInfo>>(IPC.SETTINGS_PAIRING_START, v.port === undefined ? {} : { port: assertPort(v.port) })
      },
      cancel: () => invoke<void>(IPC.SETTINGS_PAIRING_CANCEL),
    },
    setListener: (input) => {
      if (!input || typeof input !== 'object') throw new TypeError('input must be an object')
      const v = input as Record<string, unknown>
      if (typeof v.enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
      return invoke<SettingsResult<SettingsStatus>>(
        IPC.SETTINGS_SET_LISTENER,
        v.port !== undefined ? { enabled: true, port: assertPort(v.port) } : { enabled: v.enabled },
      )
    },
    status: () => invoke<SettingsStatus>(IPC.SETTINGS_STATUS),
    /** iOS connect QR payload ('local' or a remote runtime id); the pion://
     * link embeds the token — renderer only receives it on explicit request. */
    qr: (id) => invoke<SettingsResult<SettingsQrInfo>>(IPC.SETTINGS_QR, assertNonEmptyString(id, 'id')),
  },
  sessions: {
    list: (projectPath, force) => invoke<SessionRecord[]>(IPC.SESSIONS_LIST, projectPath, force),
    read: (filePath, runtimeId) => invoke<{ messages: unknown[] }>(IPC.SESSIONS_READ, filePath, runtimeId),
    onChanged: (cb) => subscribe<SessionChangeEvent>(IPC.SESSIONS_CHANGED, cb),
    tracked: (projectPath) => invoke<string[]>(IPC.SESSIONS_TRACKED, projectPath),
    rename: (filePath, name, projectPath) => invoke<void>(IPC.SESSIONS_RENAME, filePath, name, projectPath),
    archive: (filePath, projectPath) => invoke<void>(IPC.SESSIONS_ARCHIVE, filePath, projectPath),
    track: (projectPath, filePath) => invoke<void>(IPC.SESSIONS_TRACK, projectPath, filePath),
  },
  agent: {
    start: (options) => invoke<RuntimeInfo>(IPC.AGENT_START, asAgentStartOptions(options)),
    command: (runtimeId, command) => {
      validateCommand(command)
      return invoke<RpcResponse>(IPC.AGENT_COMMAND, runtimeId, command)
    },
    stop: (runtimeId) => invoke<boolean>(IPC.AGENT_STOP, runtimeId),
    list: () => invoke<RuntimeInfo[]>(IPC.AGENT_LIST),
    onEvent: (cb) => subscribe<PiEventEnvelope>(IPC.AGENT_EVENT, cb),
  },
  kanban: {
    list: (projectPath) => invoke<KanbanBoard>(IPC.KANBAN_LIST, assertProjectPath(projectPath)),
    create: (projectPath, input) => invoke<KanbanCard>(IPC.KANBAN_CREATE, assertProjectPath(projectPath), asKanbanCreateInput(input)),
    update: (projectPath, cardId, patch) =>
      invoke<KanbanCard>(IPC.KANBAN_UPDATE, assertProjectPath(projectPath), assertNonEmptyString(cardId, 'cardId'), asKanbanUpdateInput(patch)),
    move: (projectPath, cardId, to) => {
      assertProjectPath(projectPath)
      assertNonEmptyString(cardId, 'cardId')
      if (typeof to !== 'string' || !KANBAN_STATUS_SET.has(to)) throw new TypeError('to must be a card status')
      return invoke<KanbanCard>(IPC.KANBAN_MOVE, projectPath, cardId, to as CardStatus)
    },
    note: (projectPath, cardId, text) =>
      invoke<KanbanCard>(IPC.KANBAN_NOTE, assertProjectPath(projectPath), assertNonEmptyString(cardId, 'cardId'), assertNonEmptyString(text, 'text', 8192)),
    assign: (projectPath, cardId, input) =>
      invoke<KanbanCard>(IPC.KANBAN_ASSIGN, assertProjectPath(projectPath), assertNonEmptyString(cardId, 'cardId'), asKanbanAssignInput(input)),
    archive: (projectPath, cardId) => invoke<void>(IPC.KANBAN_ARCHIVE, assertProjectPath(projectPath), assertNonEmptyString(cardId, 'cardId')),
    dispatch: (projectPath, cardId, input) =>
      invoke<RuntimeInfo>(IPC.KANBAN_DISPATCH, assertProjectPath(projectPath), assertNonEmptyString(cardId, 'cardId'), asKanbanDispatchInput(input)),
    moveProject: (projectPath, cardId, toProjectPath) => {
      const to = assertNonEmptyString(toProjectPath, 'toProjectPath')
      if (to === '__unassigned__') throw new TypeError('toProjectPath must be a real project')
      return invoke<KanbanCard>(IPC.KANBAN_MOVE_PROJECT, assertProjectPath(projectPath), assertNonEmptyString(cardId, 'cardId'), to)
    },
    onChanged: (cb) => subscribe<KanbanChangeEvent>(IPC.KANBAN_CHANGED, cb),
  },
  cron: {
    list: (projectPath) => invoke<CronJob[]>(IPC.CRON_LIST, assertProjectPath(projectPath)),
    create: (input) => invoke<CronJob>(IPC.CRON_CREATE, asCronCreateInput(input)),
    remove: (projectPath, id) => invoke<void>(IPC.CRON_REMOVE, assertProjectPath(projectPath), assertNonEmptyString(id, 'id')),
    setEnabled: (projectPath, id, enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
      return invoke<CronJob>(IPC.CRON_SET_ENABLED, assertProjectPath(projectPath), assertNonEmptyString(id, 'id'), enabled)
    },
    runNow: (projectPath, id) => invoke<void>(IPC.CRON_RUN_NOW, assertProjectPath(projectPath), assertNonEmptyString(id, 'id')),
  },
  terminal: {
    attach: (projectPath) => invoke<TerminalAttachResult>(IPC.TERMINAL_ATTACH, assertProjectPath(projectPath)),
    input: (projectPath, data) => invoke<void>(IPC.TERMINAL_INPUT, assertProjectPath(projectPath), assertString(data, 'data', 8192)),
    resize: (projectPath, cols, rows) => {
      for (const [v, name] of [[cols, 'cols'], [rows, 'rows']] as const) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 500) throw new TypeError(`${name} must be an integer in 1..500`)
      }
      return invoke<void>(IPC.TERMINAL_RESIZE, assertProjectPath(projectPath), cols, rows)
    },
    kill: (projectPath) => invoke<void>(IPC.TERMINAL_KILL, assertProjectPath(projectPath)),
    // Filtered per-project subscriptions (dedicated listeners, NOT the
    // single-callback `subscribe` helper — data and exit coexist).
    onData: (projectPath, cb) => {
      const path = assertProjectPath(projectPath)
      if (typeof cb !== 'function') throw new TypeError('callback must be a function')
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => {
        if (isObject(payload) && payload.projectPath === path && typeof payload.data === 'string') cb(payload.data)
      }
      ipcRenderer.on(IPC.TERMINAL_DATA, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, listener)
    },
    onExit: (projectPath, cb) => {
      const path = assertProjectPath(projectPath)
      if (typeof cb !== 'function') throw new TypeError('callback must be a function')
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => {
        if (isObject(payload) && payload.projectPath === path && typeof payload.exitCode === 'number') cb(payload.exitCode)
      }
      ipcRenderer.on(IPC.TERMINAL_EXIT, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, listener)
    },
  },
  updates: {
    result: () => invoke<UpdateCheckResult | null>(IPC.VERSION_CHECK_RESULT),
    recheck: () => invoke<UpdateCheckResult | null>(IPC.VERSION_CHECK_RECHECK),
    onChanged: (cb) => subscribe<UpdateCheckResult>(IPC.VERSION_CHECK_RESULT, cb),
    run: () => invoke<{ started: boolean; error?: string }>(IPC.VERSION_CHECK_UPDATE),
    onProgress: (cb) => subscribe<UpdateProgressEvent>(IPC.VERSION_CHECK_PROGRESS, cb),
  },
  plugins: {
    community: (query?: string) => invoke<CommunityPackage[]>(IPC.PLUGINS_COMMUNITY, query),
    install: (name: string) => invoke<{ started: boolean; error?: string }>(IPC.PLUGINS_INSTALL, name),
    onProgress: (cb) => subscribe<UpdateProgressEvent>(IPC.PLUGINS_PROGRESS, cb),
  },
}

contextBridge.exposeInMainWorld('pi', api)
