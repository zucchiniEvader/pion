// Electron main: app lifecycle, BrowserWindow, IPC proxy layer to pion-daemon.
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen } from 'electron'

// Dev mode on Windows/Linux derives the app name from the binary ("electron");
// macOS dev uses the patched Info.plist (scripts/patch-dock-name.mjs). Set it
// explicitly so app.getName() and default menus are right everywhere.
app.setName('Pion')
import { join, basename, dirname } from 'node:path'
import { copyFile, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseWindowBounds, rectCenter, resolveWindowBounds, MIN_HEIGHT, MIN_WIDTH, type Rect } from './window-bounds'
import type {
  AppMeta,
  ProjectRecord,
  SessionChangeEvent,
  KanbanChangeEvent,
  AgentStartOptions,
  RuntimeInfo,
  RpcCommand,
  SettingsRuntime,
  SettingsResult,
  SettingsPairingInfo,
  SettingsQrInfo,
  SettingsStatus,
  ThemeSetting,
  GuiUpdateInfo,
  ProvidersLocalResult,
  AuthStateResult,
  PiAvailableModel,
} from '../../src/types'
import { IPC } from '../../src/types'
import { detectPi, safeChildEnvironment } from '../../daemon/pi-rpc'
import { runPiInstall, stopPiInstall } from './pi-install'
import { daemons } from './daemon-client'
import { initUpdater } from './updater'
import type { DaemonConnection } from './daemon-client'

let mainWindow: BrowserWindow | null = null

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// sessions.changed reaches the renderer through the daemon's throttled push
// (daemon/agent.ts); this local throttle only matters if a second source is
// ever added, and keeps the renderer's refresh cadence unchanged regardless.
const SESSION_CHANGE_THROTTLE_MS = 500
let lastChangeSentAt = 0
let pendingChangeTimer: NodeJS.Timeout | null = null

function notifySessionsChanged(projectPath: string): void {
  const send = (): void => {
    lastChangeSentAt = Date.now()
    sendToRenderer(IPC.SESSIONS_CHANGED, { projectPath } satisfies SessionChangeEvent)
  }
  const elapsed = Date.now() - lastChangeSentAt
  if (elapsed >= SESSION_CHANGE_THROTTLE_MS) {
    send()
    return
  }
  if (pendingChangeTimer) return
  pendingChangeTimer = setTimeout(() => {
    pendingChangeTimer = null
    send()
  }, SESSION_CHANGE_THROTTLE_MS - elapsed)
}

/** Routes a project-scoped call to the daemon that owns the project
 * (④ R2-A): local by default; remote projects resolve to their remote
 * connection. An offline remote rejects per-call with a readable
 * "Runtime \"<name>\" is offline" error and never blocks local calls. */
function route(projectPath?: string) {
  return daemons.resolve(projectPath)
}

/** Attaches the frozen event fan-out to one connection (local or remote):
 * every daemon's events reach the renderer through the same IPC channels. */
function wireConnectionEvents(conn: DaemonConnection): void {
  conn.onEvent('sessions.changed', (payload) => {
    if (payload.projectPath) notifySessionsChanged(payload.projectPath)
  })
  conn.onEvent('agent.event', (envelope) => {
    sendToRenderer(IPC.AGENT_EVENT, envelope)
  })
  conn.onEvent('kanban.changed', (payload) => {
    sendToRenderer(IPC.KANBAN_CHANGED, payload)
  })
  // version-check is a LOCAL daemon concern (this machine's pi + extensions);
  // remote daemons do broadcast it, but renderer update state stays local.
  if (conn.id === 'local') {
    conn.onEvent('version-check.result', (payload) => {
      sendToRenderer(IPC.VERSION_CHECK_RESULT, payload)
    })
    conn.onEvent('version-check.progress', (payload) => {
      sendToRenderer(IPC.VERSION_CHECK_PROGRESS, payload)
    })
  }
}

function settingsDescriptor(conn: DaemonConnection, host?: string, port?: number): SettingsRuntime {
  return {
    id: conn.id,
    name: conn.name,
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    kind: conn.kind,
    connected: conn.connected,
  }
}

// M3 reconnect re-hydrate (goal.md §5.3): after a daemon respawn/reconnect
// the event stream may have gaps; the only recovery is a full re-hydrate.
// Push one changed signal per project owned by THAT runtime (bypassing the
// streaming throttle — one-shot post-crash burst, not a per-append push) so
// the renderer re-pulls fresh sessions/kanban snapshots. Version-check needs
// no push here: a respawned local daemon re-runs its boot check itself.
async function rehydrateAfterReconnect(runtimeId: string): Promise<void> {
  const conn = daemons.getConnection(runtimeId)
  if (!conn) return
  const projects = await conn.call('projects.list').catch(() => null)
  if (!projects) return
  for (const p of projects) {
    sendToRenderer(IPC.SESSIONS_CHANGED, { projectPath: p.path } satisfies SessionChangeEvent)
    sendToRenderer(IPC.KANBAN_CHANGED, { projectPath: p.path } satisfies KanbanChangeEvent)
  }
}

async function openInApp(appName: string, bundleName: string, dirPath: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve) => {
    execFile('open', ['-a', appName, dirPath], { timeout: 10_000 }, () => {
      execFile('open', ['-b', bundleName, dirPath], { timeout: 10_000 }, () => resolve())
    })
  })
}

// ──────────────────────────────────────────────────────────────────────────
// IPC handlers (M2: business logic lives in pion-daemon; main is the
// allowlisted proxy — same channels, same DTOs, same error text)
// ──────────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle(IPC.VERSION_CHECK_RESULT, async () => daemons.localConnection.call('version-check.result'))
  ipcMain.handle(IPC.VERSION_CHECK_RECHECK, async () => daemons.localConnection.call('version-check.recheck'))
  ipcMain.handle(IPC.VERSION_CHECK_UPDATE, async () => daemons.localConnection.call('version-check.update'))
  ipcMain.handle(IPC.APP_META, async (): Promise<AppMeta> => {
    const detected = await detectPi()
    return {
      version: app.getVersion(),
      platform: process.platform,
      homeDir: homedir(),
      piPath: detected.path,
      piVersion: detected.version,
      problem: detected.path ? undefined : { reason: detected.problem ?? 'PI executable not found on PATH.' },
    }
  })

  ipcMain.handle(IPC.APP_PICK_PROJECT, async (): Promise<ProjectRecord | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select a project directory',
    })
    if (result.canceled || !result.filePaths.length) return null
    const path = result.filePaths[0]
    return daemons.localConnection.call('projects.add', { path })
  })

  // projects.list merges every runtime's records (④ R2-A): each record's
  // RuntimeAttachment is rewritten to the serving connection's runtimeId
  // (the proxy owns the runtime dimension — a daemon only knows 'local'),
  // and the merge registers project → runtime routing. Same path on two
  // runtimes dedupes first-wins (local first) — one sidebar row per path.
  // Offline remotes are NOT skipped (④ R2-B): their registered projects stay
  // visible as stub records (connected:false) so the sidebar can dim them
  // with an offline badge instead of rows vanishing (goal.md §9 离线语义).
  ipcMain.handle(IPC.PROJECTS_LIST, async () => {
    const merged: Array<ProjectRecord & { runtime: string; connected: boolean }> = []
    const seen = new Set<string>()
    for (const conn of daemons.listConnections()) {
      // Offline OR limbo (close detected / call failed while the reconnect
      // backoff runs) both fall back to stub records — a dead runtime's
      // projects must stay visible (connected:false), never vanish.
      const records = conn.connected ? await conn.call('projects.list').catch(() => null) : null
      if (records) {
        for (const r of records) {
          if (seen.has(r.path)) continue
          seen.add(r.path)
          merged.push({ ...r, runtime: daemons.ownerOf(r.path) ?? conn.id, connected: conn.connected })
        }
        daemons.registerProjects(conn.id, records.map((r) => r.path))
      } else {
        for (const path of daemons.registeredPaths(conn.id)) {
          if (seen.has(path)) continue
          seen.add(path)
          merged.push({ id: path, name: basename(path) || path, path, lastOpenedAt: '', runtime: conn.id, connected: false })
        }
      }
    }
    return merged
  })
  ipcMain.handle(IPC.PROJECTS_ADD, async (_e, path: string) => {
    const record = await daemons.localConnection.call('projects.add', { path })
    daemons.registerProjects('local', [record.path])
    return record
  })
  // ④ remote add flow: forward to the named runtime and register routing
  // immediately (so project-scoped calls route before the next list merge).
  ipcMain.handle(IPC.PROJECTS_ADD_ON, async (_e, path: unknown, runtimeId: unknown) => {
    if (typeof path !== 'string' || !path) throw new Error('path must be a non-empty string')
    if (typeof runtimeId !== 'string' || !runtimeId) throw new Error('runtimeId must be a non-empty string')
    if (runtimeId === 'local') {
      const record = await daemons.localConnection.call('projects.add', { path })
      daemons.registerProjects('local', [record.path])
      return record
    }
    const conn = daemons.getConnection(runtimeId)
    if (!conn) throw new Error(`Unknown runtime: ${runtimeId}`)
    const record = await conn.call('projects.add', { path })
    daemons.registerProjects(runtimeId, [record.path])
    return { ...record, runtime: runtimeId, connected: conn.connected }
  })
  ipcMain.handle(IPC.PROJECTS_EXTENSIONS, async (_e, projectPath: string) => route(projectPath).call('projects.extensions', { projectPath }))
  ipcMain.handle(IPC.PROJECTS_REMOVE, async (_e, id: string) => route(id).call('projects.remove', { id }))
  ipcMain.handle(IPC.PROJECTS_DISCOVER, async (_e, runtimeId?: string) => {
    const conn = runtimeId ? daemons.getConnection(runtimeId) : daemons.localConnection
    if (!conn) throw new Error(`Unknown runtime: ${runtimeId}`)
    return conn.call('projects.discover')
  })

  // Daemon → renderer event fan-out. The payloads are the frozen renderer
  // DTOs, forwarded untouched; sessions.changed keeps the legacy throttled
  // cadence (two daemon sources — bucket watcher and registry mutations —
  // dedupe into at most one renderer refresh per interval).
  // Event fan-out moved to wireConnectionEvents (per-connection; remote
  // connections get wired when they register).

  ipcMain.handle(IPC.SESSIONS_LIST, async (_e, projectPath: string, _force?: boolean) =>
    // The daemon's sessions.list re-applies the old handler side effects
    // (bucket watcher switch + prewarm).
    route(projectPath).call('sessions.list', { projectPath }))
  // sessions.* mutations carry filePath (inside a bucket that reveals no
  // runtime); route by projectPath where present, else local — the local
  // daemon owns all pre-④ session data and errors verbatim for foreign paths.
  ipcMain.handle(IPC.SESSIONS_READ, async (_e, filePath: string, runtimeId?: string) =>
    // Remote session files live on the remote machine: route by the owning
    // pi runtime (known from agent.start / agent.list) instead of always
    // hitting the local daemon.
    ((runtimeId ? daemons.connectionByRuntime(runtimeId) : undefined) ?? route()).call('sessions.read', { filePath }))
  ipcMain.handle(IPC.SESSIONS_TRACKED, async (_e, projectPath: string) => route(projectPath).call('sessions.tracked', { projectPath }))
  ipcMain.handle(IPC.SESSIONS_RENAME, async (_e, filePath: string, name: string, projectPath?: string) => route(projectPath).call('sessions.rename', { filePath, name }))
  ipcMain.handle(IPC.SESSIONS_ARCHIVE, async (_e, filePath: string, projectPath?: string) => route(projectPath).call('sessions.archive', { filePath }))
  ipcMain.handle(IPC.SESSIONS_TRACK, async (_e, projectPath: string, filePath: string) =>
    route(projectPath).call('sessions.track', { projectPath, filePath }))

  ipcMain.handle(IPC.AGENT_START, async (_e, options: AgentStartOptions) => {
    // Trust boundary: rebuild from known fields only. `extensions` is
    // main-internal (kanban dispatch); the renderer can never attach one.
    const v = (options ?? {}) as unknown as Record<string, unknown>
    if (typeof v.projectPath !== 'string' || !v.projectPath) throw new Error('projectPath must be a non-empty string')
    const clean: AgentStartOptions = { projectPath: v.projectPath }
    if (typeof v.sessionPath === 'string' && v.sessionPath) clean.sessionPath = v.sessionPath
    if (typeof v.provider === 'string' && v.provider) clean.provider = v.provider
    if (typeof v.modelId === 'string' && v.modelId) clean.modelId = v.modelId
    if (typeof v.thinking === 'string' && v.thinking) clean.thinking = v.thinking
    const conn = route(clean.projectPath)
    const info = await conn.call('agent.start', clean)
    // Remember the owning daemon so runtime-level calls below route back to
    // it instead of falling into the local daemon (remote runtimes would
    // otherwise be unreachable for every agent.command).
    if (info && typeof (info as { runtimeId?: unknown }).runtimeId === 'string') {
      daemons.rememberRuntimeOwner((info as { runtimeId: string }).runtimeId, conn.id)
    }
    return info
  })
  ipcMain.handle(IPC.AGENT_COMMAND, async (_e, runtimeId: string, command: RpcCommand) =>
    (daemons.connectionByRuntime(runtimeId) ?? route()).call('agent.command', { runtimeId, command }))
  ipcMain.handle(IPC.AGENT_STOP, async (_e, runtimeId: string) =>
    (daemons.connectionByRuntime(runtimeId) ?? route()).call('agent.stop', { runtimeId }))
  // agent.list merges every runtime's pool (renderer pool view aggregates);
  // the sweep also refreshes the runtimeId → connection ownership map.
  ipcMain.handle(IPC.AGENT_LIST, async () => {
    const merged = []
    for (const conn of daemons.listConnections()) {
      if (!conn.connected) continue
      const list = await conn.call('agent.list').catch(() => [] as RuntimeInfo[])
      for (const info of list) daemons.rememberRuntimeOwner(info.runtimeId, conn.id)
      merged.push(...list)
    }
    return merged
  })

  ipcMain.handle(IPC.KANBAN_LIST, async (_e, projectPath: string) => route(projectPath).call('kanban.list', { projectPath }))
  ipcMain.handle(IPC.KANBAN_CREATE, async (_e, projectPath: string, input: unknown) =>
    route(projectPath).call('kanban.create', { projectPath, input: input as never }))
  ipcMain.handle(IPC.KANBAN_UPDATE, async (_e, projectPath: string, cardId: string, patch: unknown) =>
    route(projectPath).call('kanban.update', { projectPath, cardId, patch: patch as never }))
  ipcMain.handle(IPC.KANBAN_MOVE, async (_e, projectPath: string, cardId: string, to: string) =>
    route(projectPath).call('kanban.move', { projectPath, cardId, to }))
  ipcMain.handle(IPC.KANBAN_NOTE, async (_e, projectPath: string, cardId: string, text: string) =>
    route(projectPath).call('kanban.note', { projectPath, cardId, text }))
  ipcMain.handle(IPC.KANBAN_ASSIGN, async (_e, projectPath: string, cardId: string, input: unknown) =>
    route(projectPath).call('kanban.assign', { projectPath, cardId, input: input as never }))
  ipcMain.handle(IPC.KANBAN_ARCHIVE, async (_e, projectPath: string, cardId: string) =>
    route(projectPath).call('kanban.archive', { projectPath, cardId }))
  ipcMain.handle(IPC.KANBAN_MOVE_PROJECT, async (_e, projectPath: string, cardId: string, toProjectPath: string) =>
    route(projectPath).call('kanban.moveProject', { projectPath, cardId, toProjectPath }))
  ipcMain.handle(IPC.KANBAN_DISPATCH, async (_e, projectPath: string, cardId: string, input: unknown) =>
    route(projectPath).call('kanban.dispatch', { projectPath, cardId, input: input as never }))

  ipcMain.handle(IPC.CRON_LIST, async (_e, projectPath: string) =>
    route(projectPath)
      .call('cron.list', { projectPath })
      .catch((e) => {
        // A remote daemon predating cron answers not_found ("unknown
        // method"): that runtime is simply cron-less — return [] instead of
        // an error (v3 additive fallback, handled client-side by design).
        if (/unknown method/.test(e instanceof Error ? e.message : String(e))) return []
        throw e
      }))
  ipcMain.handle(IPC.CRON_CREATE, async (_e, input: unknown) => {
    const { projectPath } = input as { projectPath: string }
    return route(projectPath).call('cron.create', input as never)
  })
  ipcMain.handle(IPC.CRON_REMOVE, async (_e, projectPath: string, id: string) => route(projectPath).call('cron.remove', { id }))
  ipcMain.handle(IPC.CRON_SET_ENABLED, async (_e, projectPath: string, id: string, enabled: boolean) =>
    route(projectPath).call('cron.setEnabled', { id, enabled }))
  ipcMain.handle(IPC.CRON_RUN_NOW, async (_e, projectPath: string, id: string) => route(projectPath).call('cron.runNow', { id }))

  ipcMain.handle(IPC.APP_REVEAL_PATH, async (_e, path: string) => {
    await shell.showItemInFolder(path)
  })
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_e, url: string) => {
    await shell.openExternal(url)
  })
  ipcMain.handle(IPC.APP_OPEN_GHOSTTY, async (_e, path: string) => openInApp('Ghostty', 'Ghostty.app', path))
  ipcMain.handle(IPC.APP_OPEN_VSCODE, async (_e, path: string) => openInApp('Visual Studio Code', 'Visual Studio Code.app', path))

  // Changes-panel companion (client-local): widening the window makes room
  // for the panel instead of squeezing the session area. Grows toward the
  // right edge only; clamped to the display work area (no-op at the edge).
  ipcMain.handle(IPC.APP_GROW_WINDOW, (e, delta: number) => {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return 0
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return 0
    const bounds = win.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    const maxWidth = workArea.x + workArea.width - bounds.x
    const width = Math.max(720, Math.min(bounds.width + Math.trunc(delta), maxWidth))
    const applied = width - bounds.width
    // Return the APPLIED delta (the clamp may have cut it): the panel
    // shrinks by exactly what it grew, never more.
    if (applied !== 0) win.setBounds({ ...bounds, width })
    panelGrowOffset.set(win.id, (panelGrowOffset.get(win.id) ?? 0) + applied)
    return applied
  })

  ipcMain.handle(IPC.GIT_OVERVIEW, async (_e, projectPath: string) =>
    route(projectPath).call('git.overview', { projectPath }))
  ipcMain.handle(IPC.GIT_CHANGED_FILES, async (_e, projectPath: string) =>
    route(projectPath)
      .call('git.changedFiles', { projectPath })
      .catch((e) => {
        // Same v3-additive fallback as cron.list: a remote daemon predating
        // this method makes the project panel-less, not error-bannered.
        if (/unknown method/.test(e instanceof Error ? e.message : String(e))) return { isRepo: false, files: [] }
        throw e
      }))
  ipcMain.handle(IPC.GIT_FILE_DIFF, async (_e, projectPath: string, path: string) =>
    route(projectPath).call('git.fileDiff', { projectPath, path }))
  ipcMain.handle(IPC.GIT_WORKTREE_CREATE, async (_e, projectPath: string, branch: string) =>
    route(projectPath).call('git.createWorktree', { projectPath, branch }))

  // ── Settings: runtime registry (④ R2-A) ──
  ipcMain.handle(IPC.SETTINGS_LIST, async (): Promise<SettingsRuntime[]> => {
    return daemons.listConnections().map((conn) => {
      const meta = daemons.remoteMeta(conn.id)
      return settingsDescriptor(conn, meta?.host, meta?.port)
    })
  })
  ipcMain.handle(IPC.SETTINGS_ADD_REMOTE, async (_e, name: unknown, host: unknown, port: unknown, token: unknown): Promise<SettingsResult<SettingsRuntime>> => {
    try {
      if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name must be a non-empty string' }
      if (typeof host !== 'string' || !host.trim()) return { ok: false, error: 'host must be a non-empty string' }
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port must be an integer in 1..65535' }
      if (typeof token !== 'string' || !token) return { ok: false, error: 'token must be a non-empty string' }
      const added = await daemons.addRemote({ name: name.trim(), host: host.trim(), port, token })
      const conn = daemons.getConnection(added.id)
      return { ok: true, value: settingsDescriptor(conn!, added.host, added.port) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.SETTINGS_REMOVE_REMOTE, async (_e, id: unknown): Promise<void> => {
    if (typeof id !== 'string' || !id) throw new Error('id must be a non-empty string')
    if (id === 'local') throw new Error('The local runtime cannot be removed.')
    await daemons.removeRemote(id)
  })
  ipcMain.handle(IPC.SETTINGS_RECONNECT, async (_e, id: unknown): Promise<SettingsResult<null>> => {
    try {
      if (typeof id !== 'string' || !id) return { ok: false, error: 'id must be a non-empty string' }
      await daemons.reconnectRemote(id)
      return { ok: true, value: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.SETTINGS_TEST, async (_e, host: unknown, port: unknown, token: unknown): Promise<SettingsResult<{ daemonVersion: string }>> => {
    try {
      if (typeof host !== 'string' || !host.trim()) return { ok: false, error: 'host must be a non-empty string' }
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port must be an integer in 1..65535' }
      if (typeof token !== 'string' || !token) return { ok: false, error: 'token must be a non-empty string' }
      const value = await daemons.probe({ host: host.trim(), port, token })
      return { ok: true, value }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Settings: dial-home pairing (④ R3-2) ──
  ipcMain.handle(IPC.SETTINGS_PAIRING_START, async (_e, input?: unknown): Promise<SettingsResult<SettingsPairingInfo>> => {
    try {
      const v = (input ?? {}) as Record<string, unknown>
      let port: number | undefined
      if (v.port !== undefined) {
        if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) {
          return { ok: false, error: 'port must be an integer in 1..65535' }
        }
        port = v.port
      }
      const started = await daemons.startPairing(port)
      const hosts = daemons.lanHosts()
      // Keep a copyable single-file daemon where the user can reach it (the
      // packaged one lives inside asar; dev builds live in out/). Refreshed on
      // every pairing start so it never goes stale — the same file the
      // pairing port serves to the remote one-liner (curl branch).
      const devBundle = join(app.getAppPath(), 'out', 'daemon', 'index.cjs')
      const srcBundle = existsSync(devBundle) ? devBundle : join(process.resourcesPath, 'pion-daemon.cjs')
      const daemonFile = join(app.getPath('userData'), 'pion-daemon.cjs')
      await copyFile(srcBundle, daemonFile)
      daemons.setDaemonBundleFile(daemonFile)
      const command = `curl -fsSL http://${hosts[0]}:${started.port}/pion-daemon.cjs -o pion-daemon.cjs && node pion-daemon.cjs --user-data ~/.pion --connect ${hosts[0]}:${started.port} --token ${started.token}`
      return { ok: true, value: { port: started.port, token: started.token, hosts, command, daemonFile, expiresAt: started.expiresAt } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.SETTINGS_PAIRING_CANCEL, async (): Promise<void> => {
    daemons.cancelPairing()
  })
  ipcMain.handle(IPC.SETTINGS_SET_LISTENER, async (_e, input?: unknown): Promise<SettingsResult<SettingsStatus>> => {
    try {
      if (!input || typeof input !== 'object') return { ok: false, error: 'input must be an object' }
      const v = input as Record<string, unknown>
      if (typeof v.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
      let port: number | undefined
      if (v.port !== undefined) {
        if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) {
          return { ok: false, error: 'port must be an integer in 1..65535' }
        }
        port = v.port
      }
      await daemons.setListener(v.enabled, port)
      return { ok: true, value: daemons.settingsStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.SETTINGS_STATUS, async (): Promise<SettingsStatus> => {
    return daemons.settingsStatus()
  })

  // iOS connect QR: compose the pion:// link main-side (the token crosses
  // the bridge only inside the payload the user explicitly chose to show).
  // The WS port comes from the daemon itself (daemon.info) — a derived or
  // ephemeral port is never guessed when the runtime is reachable.
  ipcMain.handle(IPC.SETTINGS_QR, async (_e, id: unknown): Promise<SettingsResult<SettingsQrInfo>> => {
    try {
      if (typeof id !== 'string' || !id) return { ok: false, error: 'id must be a non-empty string' }
      const conn = daemons.connection(id)
      if (!conn) return { ok: false, error: `Unknown runtime: ${id}` }
      const token = daemons.tokenFor(id)
      if (!token) return { ok: false, error: 'no token stored for this runtime' }
      const meta = daemons.remoteMeta(id)
      const host = meta?.host ?? daemons.lanHosts()[0] ?? '127.0.0.1'
      let wsPort: number | null = null
      let assumed = false
      try {
        const info = await conn.call('daemon.info')
        wsPort = info.listeners.find((l) => l.kind === 'ws')?.port ?? null
      } catch {
        /* offline or pre-daemon.info daemon → fall through */
      }
      if (wsPort === null) {
        // Unreachable: assume the dual-port default (tcp port+1) so a QR can
        // be pre-generated for a machine that is currently down.
        if (!meta) return { ok: false, error: 'local runtime is offline — start Pion\'s daemon first (the QR needs its WS listener)' }
        assumed = true
        wsPort = meta.port + 1
      }
      return { ok: true, value: { url: `pion://${host}:${wsPort}?t=${encodeURIComponent(token)}`, host, wsPort, assumed } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── client-local: settings General/Providers/Updates (settings-design.md)
  ipcMain.handle(IPC.APP_SET_THEME, (_e, theme: ThemeSetting): void => {
    if (theme !== 'system' && theme !== 'light' && theme !== 'dark') throw new TypeError('theme must be system|light|dark')
    nativeTheme.themeSource = theme
  })

  // GUI latest-release probe: reads the app's own package.json `repository`
  // field; no repository configured → null latest (UI degrades). In-memory
  // 24h cache; a restart re-checks, which is fine for a launch-frequency app.
  let guiLatestCache: { at: number; info: GuiUpdateInfo } | null = null
  ipcMain.handle(IPC.APP_GUI_LATEST, async (): Promise<GuiUpdateInfo> => {
    const now = Date.now()
    if (guiLatestCache && now - guiLatestCache.at < 24 * 60 * 60 * 1000) return guiLatestCache.info
    const releaseUrl = await (async (): Promise<string | null> => {
      try {
        const pkg = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8')) as { repository?: { url?: string } | string }
        const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
        // Normalize git URLs (git+https://…, ssh) to a plain https tree URL.
        const m = raw?.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
        return m ? `https://github.com/${m[1]}/${m[2]}/releases/latest` : null
      } catch {
        return null
      }
    })()
    let latest: string | null = null
    if (releaseUrl) {
      // https://github.com/<o>/<r>/releases/latest → the API equivalent
      const api = releaseUrl.replace('https://github.com', 'https://api.github.com/repos')
      try {
        const res = await fetch(api, {
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': 'Pion-app' },
        })
        if (res.ok) {
          const data = (await res.json()) as { tag_name?: unknown }
          if (typeof data.tag_name === 'string') latest = data.tag_name.replace(/^v/, '')
        }
      } catch {
        // offline / no releases: latest stays null
      }
    }
    const info: GuiUpdateInfo = { version: app.getVersion(), latest, releaseUrl, checkedAt: new Date().toISOString() }
    guiLatestCache = { at: now, info }
    return info
  })

  // First-run setup page: install pi by running pi.dev's official installer in
  // the background. Explicit user action only; progress streams to the renderer
  // (state + rationale live in pi-install.ts).
  ipcMain.handle(IPC.APP_PI_INSTALL, async (): Promise<{ started: boolean; error?: string }> =>
    runPiInstall((event) => sendToRenderer(IPC.APP_PI_INSTALL_PROGRESS, event)),
  )

  // Read-only view of the local pi's custom providers (~/.pi/agent/models.json).
  // API keys redact to a boolean; local-only (remote runtimes need daemon
  // methods, protocol v2 — settings-design.md §3.2).
  ipcMain.handle(IPC.APP_PROVIDERS_LOCAL, async (): Promise<ProvidersLocalResult> => {
    const modelsPath = join(homedir(), '.pi', 'agent', 'models.json')
    const result: ProvidersLocalResult = { path: modelsPath, defaultProvider: null, defaultModel: null, providers: [] }
    try {
      const settings = JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8')) as {
        defaultProvider?: unknown
        defaultModel?: unknown
      }
      if (typeof settings.defaultProvider === 'string') result.defaultProvider = settings.defaultProvider
      if (typeof settings.defaultModel === 'string') result.defaultModel = settings.defaultModel
    } catch {
      // no pi settings: defaults stay null
    }
    try {
      const data = JSON.parse(await readFile(modelsPath, 'utf8')) as {
        providers?: Record<string, { baseUrl?: unknown; api?: unknown; apiKey?: unknown; models?: unknown[] }>
      }
      for (const [name, p] of Object.entries(data.providers ?? {})) {
        result.providers.push({
          name,
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
          api: typeof p.api === 'string' ? p.api : '',
          modelCount: Array.isArray(p.models) ? p.models.length : 0,
          hasApiKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
        })
      }
    } catch {
      // no models.json: empty list, path still shown for create-in-editor
    }
    return result
  })

  // Credentials in the local pi's auth.json. Client-local like the rest of the
  // Providers section, but written by the daemon (goal.md §4: pi's config is
  // the daemon's to write, main's only writer role is backwards). Values
  // never reach the renderer — the state result is ids + kinds.
  const localSettingsConnection = (): DaemonConnection => {
    const conn = daemons.localConnection
    if (!conn) throw new Error('The local daemon is not connected.')
    return conn
  }
  ipcMain.handle(IPC.APP_AUTH_STATE, async (): Promise<AuthStateResult> => localSettingsConnection().call('settings.authState'))
  ipcMain.handle(IPC.APP_AUTH_SET_KEY, async (_e, provider: unknown, key: unknown): Promise<AuthStateResult> => {
    if (typeof provider !== 'string' || !provider || provider.length > 100) throw new TypeError('provider must be a non-empty string (<=100 chars)')
    if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new TypeError('key must be a non-empty string (<=4096 chars)')
    const state = await localSettingsConnection().call('settings.authSetKey', { provider, key })
    modelsCatalogCache = null // the model list just changed; re-probe on next use
    return state
  })
  ipcMain.handle(IPC.APP_AUTH_REMOVE, async (_e, provider: unknown): Promise<AuthStateResult> => {
    if (typeof provider !== 'string' || !provider || provider.length > 100) throw new TypeError('provider must be a non-empty string (<=100 chars)')
    const state = await localSettingsConnection().call('settings.authRemove', { provider })
    modelsCatalogCache = null
    return state
  })

  // Model catalog for the settings default-model picker: `pi --list-models`
  // parsed into {provider, id} pairs. Cached for the app run — the catalog
  // only changes via `pi update`, and re-spawning pi (~1s) per settings visit
  // is waste.
  let modelsCatalogCache: PiAvailableModel[] | null = null
  ipcMain.handle(IPC.APP_MODELS_LIST, async (): Promise<PiAvailableModel[]> => {
    if (modelsCatalogCache) return modelsCatalogCache
    const detected = await detectPi()
    if (!detected.path) throw new Error('PI executable was not found. Install pi and try again.')
    const { execFile } = await import('node:child_process')
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        detected.path!,
        ['--offline', '--list-models'],
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: safeChildEnvironment() },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
    // pi answers "No models available. Use /login to log into a provider…" on
    // stdout with exit 0 when nothing is authenticated. That is a
    // user-actionable state, not a parse failure — report it as an err.* code so
    // the renderer shows translated text instead of a raw English string.
    if (/no models available/i.test(stdout)) throw new Error('err.pi.noModels')
    const models: PiAvailableModel[] = []
    for (const line of stdout.split('\n').slice(1)) {
      const m = /^(\S+)\s+(\S+)/.exec(line)
      if (m) models.push({ provider: m[1]!, id: m[2]! })
    }
    if (!models.length) throw new Error('err.pi.modelsUnparsed')
    modelsCatalogCache = models
    return models
  })

  // Persists the default model into pi's settings.json. Read-modify-write
  // preserves unrelated keys; tmp+rename keeps a crash from truncating it.
  ipcMain.handle(IPC.APP_DEFAULT_MODEL_SET, async (_e, provider: unknown, modelId: unknown): Promise<void> => {
    if (typeof provider !== 'string' || !provider || provider.length > 100) throw new TypeError('provider must be a non-empty string (<=100 chars)')
    if (typeof modelId !== 'string' || !modelId || modelId.length > 200) throw new TypeError('modelId must be a non-empty string (<=200 chars)')
    const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      // missing or invalid settings.json: start from a fresh object
    }
    settings.defaultProvider = provider
    settings.defaultModel = modelId
    const tmp = `${settingsPath}.tmp`
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(tmp, settingsPath)
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Window placement state (client-local: main owns window lifecycle)
// ──────────────────────────────────────────────────────────────────────────

const WINDOW_STATE_FILE = 'window-state.json'

/** Last window frame, or null on first launch / unreadable state. */
async function loadWindowBounds(): Promise<Rect | null> {
  try {
    return parseWindowBounds(JSON.parse(await readFile(join(app.getPath('userData'), WINDOW_STATE_FILE), 'utf8')))
  } catch {
    return null // missing, unreadable or invalid JSON: fall back to centering
  }
}

// Sync on purpose: 'close' cannot await, and a dropped write would silently
// forget the position. The file is one short line.
function saveWindowBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds()
    // Never persist a panel-grown width: the changes panel's grow is a
    // session-level accommodation, the user's own window size is what
    // survives a restart (otherwise every launch opens panel-wide).
    const width = bounds.width - (panelGrowOffset.get(win.id) ?? 0)
    writeFileSync(join(app.getPath('userData'), WINDOW_STATE_FILE), `${JSON.stringify({ ...bounds, width })}\n`)
  } catch (err) {
    console.log(`[window-state] save failed: ${(err as Error).message}`)
  }
}

/** Per-window width the changes panel grew (session-only, see above). */
const panelGrowOffset = new Map<number, number>()

// ──────────────────────────────────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  const dark = nativeTheme.shouldUseDarkColors
  const appIconPath = join(app.getAppPath(), 'assets', 'pion-logo.png')
  // Explicit placement is required on macOS: with no x/y the window lands flush
  // under the menu bar (measured: winY === workArea.y, x centered) rather than
  // centered as Electron's docs suggest. Which display to use: the one owning
  // the saved frame, else — first launch — the one the cursor is on, so the
  // window opens where the user is actually looking.
  const saved = await loadWindowBounds()
  const display = screen.getDisplayNearestPoint(saved ? rectCenter(saved) : screen.getCursorScreenPoint())
  const bounds = resolveWindowBounds(saved, display.workArea)
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Pion',
    icon: appIconPath,
    // mac: inset traffic lights over a draggable in-app toolbar for the
    // native title-bar feel; other platforms keep their normal frame.
    // y:16 centers the (Tahoe-size) lights on the 48px strip, matching the
    // nav/collapse buttons whose icon centers sit at y=24.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 16 } }
      : {}),
    backgroundColor: dark ? '#1e1e20' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // Remember the frame for the next launch; getNormalBounds keeps the
  // pre-maximize size when the user quit in a zoomed/fullscreen window.
  const win = mainWindow
  win.on('close', () => saveWindowBounds(win))
  win.on('closed', () => panelGrowOffset.delete(win.id))
  // External links open in the system browser, never in-app navigation.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
  // Forward renderer console messages to stdout so load/runtime errors surface.
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] ?? 'LOG'
    console.log(`[renderer:${tag}] ${message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`)
  })
  mainWindow.webContents.on('preload-error', (_e, p) => {
    console.log(`[preload-error] ${p}`)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// ────────────────────────────────────────────────────────────────────────
// Single instance + die with the launcher process
// ────────────────────────────────────────────────────────────────────────

// Prevent multiple windows: a second launch focuses the existing one and
// the newcomer exits, so repeated `npm run dev` never stacks instances.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })
}

// Die with the process that launched us (a terminal, npm, etc.). When that
// parent exits, we are re-parented to init (pid 1) and would otherwise keep
// running forever; a cheap poll detects that and quits.
const parentPid = process.ppid
let parentWatcher: NodeJS.Timeout | null = null
function startParentWatcher(): void {
  if (parentWatcher || process.platform === 'darwin') return
  parentWatcher = setInterval(() => {
    if (process.ppid !== parentPid || !isAlive(process.ppid)) {
      // Parent gone (re-parented or killed): quit without leaving orphans.
      app.quit()
    }
  }, 2_000)
  parentWatcher.unref()
}
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  return true
}
// SIGHUP covers the common case of closing the terminal that launched us.
process.on('SIGHUP', () => app.quit())

app.whenReady().then(async () => {
  // Warm the pi probe while the daemon starts and the window loads. detectPi
  // caches a positive result, and everything below runs before the renderer asks
  // for its boot check (daemon spawn + hello, window creation, bundle load), so
  // the gate then answers from cache instead of spending ~200ms in `pi --version`
  // with a "checking" screen on the way in. A missing pi is not cached, so the
  // setup page's 重新检测 still probes fresh.
  void detectPi().catch(() => {})
  startParentWatcher()
  if (process.platform === 'darwin') {
    app.dock?.setIcon(join(app.getAppPath(), 'assets', 'pion-logo.png'))
  }
  registerIpc()
  initUpdater()
  // Daemon (goal.md v3 §7): every business handler forwards through it, so
  // boot awaits readiness (node-bundle spawn + hello_ok + ping — fast). On
  // failure boot still continues and every dependent call fails visibly
  // per-call (§9 disconnect semantics). The daemon itself prewarms the most
  // recently opened project at boot (daemon/index.ts prewarmLatestProject)
  // and runs the pi/extension upgrade check at boot (24h cache, same
  // semantics as the old main-side initVersionCheck).
  for (const conn of daemons.listConnections()) wireConnectionEvents(conn)
  daemons.onNewConnection((conn) => wireConnectionEvents(conn))
  daemons.onReady((runtimeId) => void rehydrateAfterReconnect(runtimeId))
  daemons.onStateChange((id, connected) => {
    sendToRenderer(IPC.SETTINGS_CHANGED, { id, connected })
  })
  // Stored credentials (incl. the local daemon's WS token) load BEFORE the
  // local spawn — the spawn args embed that token.
  await daemons.loadAndConnectRemotes()
  await daemons.localConnection.start()
  daemons.localConnection.onReady(() => void rehydrateAfterReconnect('local'))
  await createWindow()
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

// On quit the daemon owns the process-tree cleanup: closing its stdin
// triggers the graceful ladder (stop the pi update child, stop every session
// runtime, drop prewarm scratch files, stop watchers, exit) with the signal
// ladder as backstop. Remote connections just drop (the resident daemon on
// the other machine owns its own processes).
app.on('before-quit', () => {
  stopPiInstall()
  void daemons.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
