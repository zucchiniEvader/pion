// Relative-time and duration formatting for the desktop UI. Locale comes from
// the i18n layer (`useI18n().lang`); all units come from Intl so en plurals
// and zh wording are native.

import type { Lang } from '@/i18n/resolve'

const LOCALE: Record<Lang, string> = { zh: 'zh-CN', en: 'en' }

// "3 分钟前" / "3 minutes"; older than a week falls back to a bare date —
// once a relative label has aged into a calendar date the time is noise.
// en drops the "ago" suffix (product call): compact card corners, no overflow.
export function relTime(iso: string | undefined, lang: Lang): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const rtf = new Intl.RelativeTimeFormat(LOCALE[lang], { numeric: 'auto' })
  const fmt = (n: number, unit: 'minute' | 'hour' | 'day') => {
    const text = rtf.format(-n, unit)
    return lang === 'en' ? text.replace(' ago', '') : text
  }
  if (diff < 3_600_000) return fmt(Math.floor(diff / 60_000), 'minute')
  if (diff < 86_400_000) return fmt(Math.floor(diff / 3_600_000), 'hour')
  if (diff < 7 * 86_400_000) return fmt(Math.floor(diff / 86_400_000), 'day')
  return fmtStamp(iso, lang, false)
}

// Absolute stamp: "8/30 14:23" / "Aug 30, 14:23" (zh uses a numeric month —
// the full 月/日 wording overflows compact card meta rows); the year only
// shows when it isn't the current one. withTime=false gives a bare date for
// list rows (relTime's week-plus fallback).
export function fmtStamp(iso: string | undefined, lang: Lang, withTime = true): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t)
  return new Intl.DateTimeFormat(LOCALE[lang], {
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: lang === 'zh' ? 'numeric' : 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(d)
}

// "30 秒" / "4 分 36 秒" / "30 sec" / "4 min 36 sec" for activity rows and
// elapsed timers.
export function fmtDur(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  return fmtDuration(Math.floor(ms / 1000), lang)
}

export function fmtElapsed(sec: number, lang: Lang): string {
  if (!Number.isFinite(sec) || sec < 0) return ''
  return fmtDuration(Math.floor(sec), lang)
}

function fmtDuration(totalSec: number, lang: Lang): string {
  const fmtUnit = (u: 'second' | 'minute') =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'unit', unit: u, unitDisplay: 'short' })
  if (totalSec < 60) return fmtUnit('second').format(totalSec)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s ? `${fmtUnit('minute').format(m)} ${fmtUnit('second').format(s)}` : fmtUnit('minute').format(m)
}
