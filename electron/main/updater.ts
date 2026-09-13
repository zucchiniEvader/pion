// In-app auto-update (electron-updater + GitHub Releases, macOS Squirrel /
// Linux AppImage). Feed config comes from electron-builder.yml `publish`
// (baked into Resources/app-update.yml at package time) — nothing to
// configure here. Dev/unpackaged runs report state 'dev' so the UI can
// degrade honestly.
import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC, type AppUpdateStatus } from '../../src/types'

const { autoUpdater } = electronUpdater

// electron-updater self-update support by packaging form: mac (Squirrel zip)
// and Windows (NSIS exe) always; Linux only an AppImage (driven through the
// APPIMAGE env var). deb & co must not pretend: they report 'unsupported'
// and the UI links to the releases page instead.
const selfUpdateSupported =
  process.platform === 'darwin' || process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE)

let status: AppUpdateStatus = !app.isPackaged
  ? { state: 'dev' }
  : selfUpdateSupported ? { state: 'idle' } : { state: 'unsupported' }

function setStatus(next: AppUpdateStatus): void {
  status = next
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(IPC.APP_UPDATE_STATUS, status))
}

export function initUpdater(): void {
  if (!app.isPackaged) return // dev builds can't self-update; UI shows nothing

  ipcMain.handle(IPC.APP_UPDATE_STATUS, (): AppUpdateStatus => status)
  if (!selfUpdateSupported) {
    // Non-AppImage Linux: keep the handlers answering the honest
    // 'unsupported' state — no feed probing, no fake errors.
    ipcMain.handle(IPC.APP_UPDATE_CHECK, (): AppUpdateStatus => status)
    ipcMain.handle(IPC.APP_UPDATE_DOWNLOAD, (): AppUpdateStatus => status)
    ipcMain.handle(IPC.APP_UPDATE_INSTALL, (): void => {})
    return
  }

  autoUpdater.autoDownload = false // explicit user gesture (settings Updates)
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => setStatus({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available' }))
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', percent: Math.round(p.percent), version: autoUpdater.currentVersion?.version ?? undefined }))
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => setStatus({ state: 'error', message: err.message }))

  ipcMain.handle(IPC.APP_UPDATE_CHECK, async (): Promise<AppUpdateStatus> => {
    if (status.state === 'downloaded') return status
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return status
  })
  ipcMain.handle(IPC.APP_UPDATE_DOWNLOAD, async (): Promise<AppUpdateStatus> => {
    if (status.state === 'available' || status.state === 'error') {
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
    return status
  })
  ipcMain.handle(IPC.APP_UPDATE_INSTALL, (): void => {
    if (status.state === 'downloaded') autoUpdater.quitAndInstall()
  })
}
