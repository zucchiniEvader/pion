// Wire test for the dial-home pairing manager (④ R3-2): bundles the TS test
// entry with esbuild, then runs it against the REAL daemon bundle (dial-home
// --connect, R3-1). Run: node scripts/build-daemon.mjs && node scripts/daemon-pairing-test.mjs
import { build } from 'esbuild'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const DAEMON_BUNDLE = join(process.cwd(), 'out/daemon/index.cjs')
if (!existsSync(DAEMON_BUNDLE)) {
  console.error(`daemon bundle missing: ${DAEMON_BUNDLE} (run scripts/build-daemon.mjs first)`)
  process.exit(1)
}

const outDir = mkdtempSync(join(tmpdir(), 'pion-pairing-test-'))
const entry = join(outDir, 'pairing-test.cjs')
await build({
  entryPoints: ['scripts/pairing-test-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: entry,
  logLevel: 'silent',
})

const r = spawnSync(process.execPath, [entry], {
  env: { ...process.env, DAEMON_BUNDLE },
  stdio: 'inherit',
  timeout: 120_000,
})
process.exit(r.status ?? 1)
