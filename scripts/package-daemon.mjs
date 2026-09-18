// Assembles release/daemon-cli/install.sh — the ONE published daemon asset.
//
// The installer is self-contained: the payload (pion-daemon bundle, the two
// bundled PI extensions, uninstall.sh) is embedded into scripts/install.sh as
// quoted heredocs and the sha256s/version are baked into its variable block.
// Heredocs are what make `curl install.sh | sh` work — stdin has no $0 to
// re-read, so the payload must ride inside the script text itself. All four
// payload files are text, so no base64/tar layer is needed.
//
// Usage: node scripts/package-daemon.mjs [--skip-build]
// Output: release/daemon-cli/install.sh (single file, ~size of the bundle).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const OUT = resolve('release/daemon-cli')

if (!args.includes('--skip-build')) {
  const build = spawnSync(process.execPath, ['scripts/build-daemon.mjs'], { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

// Protocol string straight from contracts (kept in sync without importing TS).
const protocol = readFileSync('contracts/daemon-protocol.ts', 'utf8').match(/export const DAEMON_PROTOCOL = '([^']+)'/)?.[1]
if (!protocol) throw new Error('cannot read DAEMON_PROTOCOL from contracts/daemon-protocol.ts')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const payload = {
  __PION_DAEMON__: readFileSync('out/daemon/pion-daemon', 'utf8'),
  __KANBAN_BRIDGE__: readFileSync('resources/kanban-bridge.ts', 'utf8'),
  __PION_COMMANDS__: readFileSync('resources/pion-commands.ts', 'utf8'),
  __UNINSTALL__: readFileSync('scripts/uninstall.sh', 'utf8'),
}
// A payload line that equals its own marker would terminate the heredoc early
// and corrupt the script — refuse to package instead of shipping broken bytes.
for (const [marker, body] of Object.entries(payload)) {
  if (body.split('\n').includes(marker)) {
    throw new Error(`payload file for ${marker} contains its own heredoc marker — pick another marker`)
  }
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

// Heredoc extraction is exact: the file gets precisely the bytes between
// `<<'MARKER'\n` and the terminating `\nMARKER\n` — i.e. body + one final
// newline. Normalize each payload to that form and hash the SAME string, so
// the installer's checksum always matches what extraction produces.
const normalized = {}
for (const [marker, body] of Object.entries(payload)) normalized[marker] = body.replace(/\n+$/, '') + '\n'

let script = readFileSync('scripts/install.sh', 'utf8')
// Heredoc bodies: insert the payload between the `<<'MARKER'` line and the
// closing `MARKER` line (the template ships with an empty body). Replacer
// FUNCTIONS only — a string replacement would interpret $&/$' sequences,
// and the bundle's JS is full of $.
for (const marker of Object.keys(payload)) {
  const open = new RegExp(`(<<'${marker}'\\n)${marker}\\n`)
  if (!open.test(script)) throw new Error(`install.sh template has no empty ${marker} heredoc`)
  script = script.replace(open, (_m, head) => head + normalized[marker].replace(/\n$/, '') + `\n${marker}\n`)
}
// Baked values: version + sha256 of each payload file (post-normalization —
// what the installer's hash_of will actually see).
const bake = (s, from, to) => s.split(from).join(to)
script = bake(script, '__PION_PKG_VERSION__', version)
script = bake(script, '__SHA_PION_DAEMON__', sha(normalized.__PION_DAEMON__))
script = bake(script, '__SHA_KANBAN_BRIDGE__', sha(normalized.__KANBAN_BRIDGE__))
script = bake(script, '__SHA_PION_COMMANDS__', sha(normalized.__PION_COMMANDS__))

const out = join(OUT, 'install.sh')
writeFileSync(out, script, { mode: 0o755 })
chmodSync(out, 0o755)
console.log(`packaged ${out} (${(statSync(out).size / 1024).toFixed(0)} KB, daemon v${version}, protocol ${protocol})`)
