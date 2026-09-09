// resolveLang purity suite (src/i18n/resolve.ts bundled for node): the
// language-resolution priority contract (override > system > en).
import { resolveLang, isLang, LANG_STORAGE_KEY } from '../node_modules/.tmp/i18nResolve.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

// 1. Explicit override wins over the system language.
assert(resolveLang('zh', 'en-US') === 'zh', 'stored zh overrides en system language')
assert(resolveLang('en', 'zh-CN') === 'en', 'stored en overrides zh system language')

// 2. Invalid stored values fall through to the system language.
assert(resolveLang('fr', 'zh-CN') === 'zh', 'invalid stored value ignored (zh system)')
assert(resolveLang(null, 'en-US') === 'en', 'null stored value ignored (en system)')
assert(resolveLang(undefined, undefined) === 'en', 'no signals → en default')

// 3. System-language variants.
assert(resolveLang(null, 'zh') === 'zh', 'zh system language → zh')
assert(resolveLang(null, 'zh-CN') === 'zh', 'zh-CN system language → zh')
assert(resolveLang(null, 'zh-TW') === 'zh', 'zh-TW system language → zh')
assert(resolveLang(null, 'en-US') === 'en', 'en-US system language → en')
assert(resolveLang(null, 'ja-JP') === 'en', 'unsupported system language → en')

// 4. isLang / LANG_STORAGE_KEY contract.
assert(isLang('zh') && isLang('en') && !isLang('fr') && !isLang(null) && !isLang('ZH'), 'isLang accepts exactly zh/en')
assert(LANG_STORAGE_KEY === 'pion.lang', 'LANG_STORAGE_KEY is pion.lang')

console.log(failures ? `\n${failures} FAILURES` : '\nall resolveLang checks passed')
process.exit(failures ? 1 : 0)
