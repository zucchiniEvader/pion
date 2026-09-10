// In-app auto-update (electron-updater + GitHub Releases, macOS Squirrel).
// Feed config comes from electron-builder.yml `publish` (baked into
// Resources/app-update.yml at package time) — nothing to configure here.
// Dev/unpackaged runs report state 'dev' so the UI can degrade honestly.
import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC, type AppUpdateStatus } from '../../src/types'

const { autoUpdater } = electronUpdater

let status: AppUpdateStatus = { state: app.isPackaged ? 'idle' : 'dev' }

function setStatus(next: AppUpdateStatus): void {
  status = next
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(IPC.APP_UPDATE_STATUS, status))
}

export function initUpdater(): void {
  if (!app.isPackaged) return // dev builds can't self-update; UI shows nothing

  autoUpdater.autoDownload = false // explicit user gesture (settings Updates)
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => setStatus({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available' }))
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', percent: Math.round(p.percent), version: autoUpdater.currentVersion?.version ?? undefined }))
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => setStatus({ state: 'error', message: err.message }))

  ipcMain.handle(IPC.APP_UPDATE_STATUS, (): AppUpdateStatus => status)
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
