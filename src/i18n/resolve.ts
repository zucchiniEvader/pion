// Language resolution for the desktop UI: an explicit user override wins,
// then the OS language, then English. Pure module so the purity suite can
// exercise it without React or localStorage.
export type Lang = 'zh' | 'en'

export const LANG_STORAGE_KEY = 'pion.lang'

export function isLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en'
}

export function resolveLang(stored: string | null | undefined, navLanguage: string | undefined): Lang {
  if (isLang(stored)) return stored
  if (typeof navLanguage === 'string' && navLanguage.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}
