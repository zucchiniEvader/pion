// Assembles release/daemon-cli/ — the directory to publish verbatim on the
// static download server (docs/remote-install.md §托管与发布):
//
//   pion-daemon                  shebang bundle (pure JS, node >= 18)
//   resources/*.ts               bundled extensions → ~/.pion/share on install
//   install.sh / uninstall.sh    one-line installers (__DL_BASE__ baked via --dl-base)
//   manifest.json                version + sha256 + size per file (install.sh verifies)
//
// Usage: node scripts/package-daemon.mjs [--dl-base https://dl.example] [--skip-build]
// --dl-base is the URL of the published directory itself (no suffix needed when
// the server root points straight at it).
// Then publish, e.g.:  rsync -av --delete release/daemon-cli/ user@server:/srv/www/pion-daemon/
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const DL_BASE = flag('--dl-base') ?? ''
const OUT = resolve(flag('--out') ?? 'release/daemon-cli')

if (!flag('--skip-build')) {
  const build = spawnSync(process.execPath, ['scripts/build-daemon.mjs'], { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

// Protocol string straight from contracts (kept in sync without importing TS).
const protocol = readFileSync('contracts/daemon-protocol.ts', 'utf8').match(/export const DAEMON_PROTOCOL = '([^']+)'/)?.[1]
if (!protocol) throw new Error('cannot read DAEMON_PROTOCOL from contracts/daemon-protocol.ts')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'resources'), { recursive: true })

copyFileSync('out/daemon/pion-daemon', join(OUT, 'pion-daemon'))
chmodSync(join(OUT, 'pion-daemon'), 0o755)
copyFileSync('resources/kanban-bridge.ts', join(OUT, 'resources', 'kanban-bridge.ts'))
copyFileSync('resources/pion-commands.ts', join(OUT, 'resources', 'pion-commands.ts'))

for (const script of ['install.sh', 'uninstall.sh']) {
  const body = readFileSync(join('scripts', script), 'utf8')
  writeFileSync(join(OUT, script), body.replaceAll('__DL_BASE__', DL_BASE), { mode: 0o755 })
}

const fileEntry = (path) => {
  const buf = readFileSync(join(OUT, path))
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length }
}
const manifest = {
  version,
  protocol,
  builtAt: new Date().toISOString(),
  files: {
    'pion-daemon': fileEntry('pion-daemon'),
    'resources/kanban-bridge.ts': fileEntry('resources/kanban-bridge.ts'),
    'resources/pion-commands.ts': fileEntry('resources/pion-commands.ts'),
  },
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

console.log(`daemon-cli package ready: ${OUT} (v${version}, protocol ${protocol})`)
if (!DL_BASE) console.log('note: install.sh has no baked download base — it will require PION_DL_BASE=<url> (pass --dl-base to bake one)')
console.log(`publish:  rsync -av --delete ${OUT}/ <user>@<server>:<docroot>/daemon/`)
