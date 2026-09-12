// cron schedule suite (daemon/cron.ts bundled for node): the expression
// parser and nextCronRun behind every job's nextRunAt.
import { parseCron, nextCronRun } from '../node_modules/.tmp/cronSchedule.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

// 1. Every minute: next is the next minute boundary.
{
  const from = at(2026, 3, 9, 10, 30)
  assert(nextCronRun(parseCron('* * * * *'), from) === at(2026, 3, 9, 10, 31), '* * * * * → next minute')
}

// 2. Daily at 09:00: same day when before, next day when at/after.
{
  const s = parseCron('0 9 * * *')
  assert(nextCronRun(s, at(2026, 3, 9, 8, 59)) === at(2026, 3, 9, 9, 0), '0 9 * * * before 09:00 → same day 09:00')
  assert(nextCronRun(s, at(2026, 3, 9, 9, 0)) === at(2026, 3, 10, 9, 0), '0 9 * * * AT 09:00 → next day (strictly after)')
}

// 3. Steps and lists.
{
  const s = parseCron('*/15 * * * *')
  assert(nextCronRun(s, at(2026, 3, 9, 10, 30)) === at(2026, 3, 9, 10, 45), '*/15 steps')
  const m = parseCron('0 8,20 * * *')
  assert(nextCronRun(m, at(2026, 3, 9, 10, 0)) === at(2026, 3, 9, 20, 0), 'hour list 8,20')
}

// 4. Weekdays: 2026-03-09 is a Monday. '0 9 * * 1-5' from Saturday lands Monday;
// dow 7 means Sunday (0).
{
  const sat = at(2026, 3, 7, 10, 0) // Saturday
  assert(nextCronRun(parseCron('0 9 * * 1-5'), sat) === at(2026, 3, 9, 9, 0), 'weekday expr skips the weekend')
  assert(nextCronRun(parseCron('0 9 * * 7'), sat) === at(2026, 3, 8, 9, 0), 'dow 7 = Sunday')
}

// 5. Vixie day rule: both dom and dow restricted → either matches.
// '0 0 1 * 6' fires on the 1st AND on every Saturday.
{
  const s = parseCron('0 0 1 * 6')
  // From 2026-03-02 (Mon): next Saturday is 03-07, before the 1st of April.
  assert(nextCronRun(s, at(2026, 3, 2, 0, 0)) === at(2026, 3, 7, 0, 0), 'dom OR dow: Saturday hits before the 1st')
}

// 6. Unmatchable (Feb 30) → null, and invalid expressions throw.
{
  assert(nextCronRun(parseCron('0 0 30 2 *'), at(2026, 1, 1, 0, 0)) === null, 'Feb 30 → null (never fires)')
  for (const bad of ['* * * *', '61 * * * *', 'a * * * *', '*/0 * * * *', '5-2 * * * *']) {
    let threw = false
    try { parseCron(bad) } catch { threw = true }
    assert(threw, `rejects "${bad}"`)
  }
}

console.log(failures ? `${failures} FAILURE(S)` : 'cron schedule: all ok')
process.exit(failures ? 1 : 0)
