// Appearance preference (settings General). The renderer applies the class
// immediately (no IPC round-trip flash); main mirrors it onto
// nativeTheme.themeSource so window chrome and future windows match.
// See docs/settings-design.md §4.
import type { ThemeSetting } from '@/types'

export const THEME_STORAGE_KEY = 'pion.theme'

export function readStoredTheme(): ThemeSetting {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage unavailable: follow the system
  }
  return 'system'
}

export function persistTheme(theme: ThemeSetting): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // session-only choice when storage is unavailable
  }
}

export function applyTheme(theme: ThemeSetting): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  try {
    void window.pi.app.setTheme(theme)
  } catch {
    // class alone still styles the window
  }
}
