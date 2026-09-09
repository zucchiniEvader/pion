import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { zh, type MsgKey } from './zh'
import { en } from './en'
import { LANG_STORAGE_KEY, isLang, resolveLang, type Lang } from './resolve'

// Minimal i18n layer: typed zh-source dictionary + React context + t() with
// {name} interpolation. Zero deps; en completeness is a typecheck guarantee
// (en.ts is Record<MsgKey, string>). See docs contract in zh.ts header.

export { LANG_STORAGE_KEY, resolveLang, isLang, type Lang } from './resolve'

type Vars = Record<string, string | number>
export type TFn = (key: MsgKey, vars?: Vars) => string

const DICTS: Record<Lang, Record<MsgKey, string>> = { zh, en }

function translate(lang: Lang, key: MsgKey, vars?: Vars): string {
  let text = DICTS[lang][key] ?? zh[key]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

function readStoredLang(): string | null {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY)
  } catch {
    return null // private mode / storage disabled: follow the system language
  }
}

interface I18n {
  lang: Lang
  /** Raw preference as stored; 'system' means follow the OS. */
  langSetting: 'system' | Lang
  setLang: (setting: 'system' | Lang) => void
  t: TFn
}

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  // Preference: stored override ('system' clears the key) → OS language → en.
  const [langSetting, setLangSetting] = useState<'system' | Lang>(() => {
    const stored = readStoredLang()
    return isLang(stored) ? stored : 'system'
  })
  const [lang, setLangState] = useState<Lang>(() => resolveLang(readStoredLang(), navigator.language))

  const setLang = (setting: 'system' | Lang) => {
    setLangSetting(setting)
    try {
      if (setting === 'system') localStorage.removeItem(LANG_STORAGE_KEY)
      else localStorage.setItem(LANG_STORAGE_KEY, setting)
    } catch {
      // keep the session-only choice when storage is unavailable
    }
    setLangState(setting === 'system' ? resolveLang(null, navigator.language) : setting)
  }

  const value = useMemo<I18n>(() => ({ lang, langSetting, setLang, t: (key, vars) => translate(lang, key, vars) }), [lang, langSetting])

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

// main/git throw err.* codes as Error.message; map a known code to localized
// text, unwrapping `code:payload` payloads — the payload is exposed to the
// message template as both {branch} and {name} (the two current uses).
// Unknown messages pass through untouched (developer-readable).
export function useUserErrorMessage(): (e: unknown) => string {
  const { lang } = useI18n()
  return useMemo(
    () =>
      (e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e)
        const sep = raw.indexOf(':')
        const code = sep === -1 ? raw : raw.slice(0, sep)
        if (!code.startsWith('err.') || !(code in zh)) return raw
        const payload = sep === -1 ? undefined : raw.slice(sep + 1)
        const vars = payload === undefined ? undefined : { branch: payload, name: payload }
        return translate(lang, code as MsgKey, vars)
      },
    [lang],
  )
}
