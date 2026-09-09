// reltime purity suite (src/lib/reltime.ts bundled for node): locale-aware
// Intl formatting for both languages. Fixtures are relative to Date.now().
import { relTime, fmtStamp, fmtDur, fmtElapsed } from '../node_modules/.tmp/reltime.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

// 1. relTime: 3 分钟前 / 3 minutes (en drops "ago" for compact card corners).
const threeMinAgo = new Date(Date.now() - 3 * 60_000).toISOString()
assert(relTime(threeMinAgo, 'zh').includes('分钟前'), `relTime zh contains 分钟前 (${relTime(threeMinAgo, 'zh')})`)
const enRel = relTime(threeMinAgo, 'en')
assert(enRel === '3 minutes', `relTime en drops ago suffix (${enRel})`)

// 2. fmtStamp: zh numeric month (compact) / en month abbreviation.
const recent = new Date(Date.now() - 86_400_000 * 2).toISOString()
assert(/^\d+\/\d+ /.test(fmtStamp(recent, 'zh')), `fmtStamp zh uses numeric month (${fmtStamp(recent, 'zh')})`)
assert(/^[A-Z][a-z]{2} /.test(fmtStamp(recent, 'en')), `fmtStamp en starts with month abbreviation (${fmtStamp(recent, 'en')})`)
// 3. week-old relTime falls back to a bare date — no time (the time is noise
// once it's a calendar date); the explicit fmtStamp keeps the time.
const old = new Date(Date.now() - 86_400_000 * 10).toISOString()
assert(!/\d{1,2}:\d{2}/.test(relTime(old, 'zh')), `relTime old zh is date-only (${relTime(old, 'zh')})`)
assert(!/\d{1,2}:\d{2}/.test(relTime(old, 'en')), `relTime old en is date-only (${relTime(old, 'en')})`)
assert(/\d{2}:\d{2}/.test(fmtStamp(old, 'zh')), `fmtStamp keeps time (${fmtStamp(old, 'zh')})`)

// 3. Durations.
assert(fmtDur(90_000, 'zh').includes('分'), `fmtDur zh contains 分 (${fmtDur(90_000, 'zh')})`)
assert(fmtElapsed(30, 'en').includes('sec'), `fmtElapsed en contains sec (${fmtElapsed(30, 'en')})`)

// 4. Empty/invalid inputs never throw and return empty strings.
assert(relTime(undefined, 'zh') === '' && relTime('not-a-date', 'en') === '', 'relTime invalid input → empty string')
assert(fmtStamp(undefined, 'zh') === '' && fmtStamp('bad', 'en') === '', 'fmtStamp invalid input → empty string')
assert(fmtDur(NaN, 'zh') === '' && fmtDur(-1, 'en') === '' && fmtElapsed(-5, 'zh') === '', 'negative/NaN durations → empty string')

console.log(failures ? `\n${failures} FAILURES` : '\nall reltime checks passed')
process.exit(failures ? 1 : 0)
