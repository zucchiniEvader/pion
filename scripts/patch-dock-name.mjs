// Patches the dev-mode Electron.app bundle name so the macOS Dock hover
// tooltip (and menu bar) show "Pion" instead of "Electron". productName in
// package.json only applies to packaged builds; in dev the name comes from
// node_modules/electron/dist/Electron.app/Contents/Info.plist, which resets
// on every npm install — hence the postinstall hook.
// Non-macOS platforms read the name from the executable/package.json path
// and don't have this problem.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'Pion'
const plist = join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist')

if (process.platform === 'darwin' && existsSync(plist)) {
  const buddy = '/usr/libexec/PlistBuddy'
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try {
      execFileSync(buddy, ['-c', `Set :${key} ${NAME}`, plist], { stdio: 'ignore' })
    } catch {
      // Key missing in this Electron version's plist — add it.
      try {
        execFileSync(buddy, ['-c', `Add :${key} string ${NAME}`, plist], { stdio: 'ignore' })
      } catch {
        /* best-effort: dock may still show "Electron" */
      }
    }
  }
  // Re-register the bundle so LaunchServices/Dock pick up the new name.
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app')], { stdio: 'ignore' })
  } catch {
    /* cosmetic only */
  }
  console.log(`[patch-dock-name] Electron.app 署名为 ${NAME}`)
}
