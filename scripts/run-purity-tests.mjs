// Purity/behavior test runner: bundles each pure module with esbuild and runs
// its suite. Add a suite here and package.json's test:purity picks it up.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.tmp')
mkdirSync(outDir, { recursive: true })
const esbuild = join(root, 'node_modules', '.bin', 'esbuild')

const suites = [
  { entry: 'src/lib/eventReducer.ts', bundle: 'eventReducer.bundle.mjs', test: 'scripts/event-reducer.purity.test.mjs' },
  { entry: 'src/lib/draftDecision.ts', bundle: 'draftDecision.bundle.mjs', test: 'scripts/draft-decision.purity.test.mjs' },
  { entry: 'src/lib/kanbanReducer.ts', bundle: 'kanbanReducer.bundle.mjs', test: 'scripts/kanban-reducer.purity.test.mjs' },
  { entry: 'daemon/kanban-store.ts', bundle: 'kanbanStore.bundle.mjs', test: 'scripts/kanban-store.test.mjs' },
  { entry: 'src/i18n/resolve.ts', bundle: 'i18nResolve.bundle.mjs', test: 'scripts/i18n-resolve.purity.test.mjs' },
  { entry: 'src/lib/reltime.ts', bundle: 'reltime.bundle.mjs', test: 'scripts/reltime.purity.test.mjs' },
  { entry: 'src/lib/piVersion.ts', bundle: 'piVersion.bundle.mjs', test: 'scripts/pi-version.purity.test.mjs' },
  { entry: 'src/lib/pluginAdapters.ts', bundle: 'pluginAdapters.bundle.mjs', test: 'scripts/plugin-adapters.purity.test.mjs' },
  { entry: 'daemon/pi-rpc.ts', bundle: 'piRpc.bundle.mjs', test: 'scripts/nvm-versions.purity.test.mjs' },
  { entry: 'daemon/cron-schedule.ts', bundle: 'cronSchedule.bundle.mjs', test: 'scripts/cron-schedule.purity.test.mjs' },
  { entry: 'electron/main/window-bounds.ts', bundle: 'windowBounds.bundle.mjs', test: 'scripts/window-bounds.purity.test.mjs' },
]

let failed = 0
for (const suite of suites) {
  console.log(`\n── ${suite.entry} ──`)
  execFileSync(
    esbuild,
    ['--bundle', '--format=esm', '--platform=node', `--alias:@=${join(root, 'src')}`, join(root, suite.entry), `--outfile=${join(outDir, suite.bundle)}`, '--log-level=warning'],
    { stdio: 'inherit' },
  )
  try {
    execFileSync(process.execPath, [join(root, suite.test)], { stdio: 'inherit' })
  } catch {
    failed++
  }
}
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nall purity suites passed')
process.exit(failed ? 1 : 0)
