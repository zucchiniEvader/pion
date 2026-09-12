// Cron expressions (pure): 5 fields (minute hour day-of-month month
// day-of-week), local time. Supports `*`, lists (a,b,c), ranges (a-b), and
// steps (*/n, a-b/n). Vixie day rule: with BOTH dom and dow restricted,
// either matches. No imports — bundled standalone for the purity suite.

interface CronField {
  any: boolean
  values: Set<number>
}

export interface CronSchedule {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}

function parseField(spec: string, min: number, max: number): CronField {
  const values = new Set<number>()
  let any = false
  for (const part of spec.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim())
    if (!m) throw new Error('err.cron.invalidSchedule')
    const step = m[3] ? Number(m[3]) : 1
    if (step < 1) throw new Error('err.cron.invalidSchedule')
    let lo: number
    let hi: number
    if (m[1] === '*') {
      if (m[2] !== undefined) throw new Error('err.cron.invalidSchedule')
      lo = min
      hi = max
      if (step === 1) any = true
    } else {
      lo = Number(m[1])
      hi = m[2] !== undefined ? Number(m[2]) : m[3] ? max : lo
    }
    if (lo < min || hi > max || lo > hi) throw new Error('err.cron.invalidSchedule')
    // dow convention: 7 = Sunday (= 0); "5-7" expands to 5,6,0 naturally.
    for (let v = lo; v <= hi; v += step) values.add(v === 7 ? 0 : v)
  }
  if (values.size === 0) throw new Error('err.cron.invalidSchedule')
  return { any, values }
}

export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('err.cron.invalidSchedule')
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dom: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dow: parseField(fields[4]!, 0, 7),
  }
}

function matches(s: CronSchedule, d: Date): boolean {
  if (!s.month.values.has(d.getMonth() + 1)) return false
  if (!s.hour.values.has(d.getHours())) return false
  if (!s.minute.values.has(d.getMinutes())) return false
  const domHit = s.dom.values.has(d.getDate())
  const dowHit = s.dow.values.has(d.getDay())
  if (s.dom.any && s.dow.any) return true
  if (s.dom.any) return dowHit
  if (s.dow.any) return domHit
  return domHit || dowHit
}

/** First run strictly after `fromMs`, minute precision; null when the
 * expression yields nothing within a year (e.g. Feb 30 — unmatchable). */
export function nextCronRun(s: CronSchedule, fromMs: number): number | null {
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const end = start + 366 * 24 * 60 * 60_000
  for (let t = start; t < end; t += 60_000) {
    if (matches(s, new Date(t))) return t
  }
  return null
}
