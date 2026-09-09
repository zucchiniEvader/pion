// Bundles pion-daemon to out/daemon/index.cjs: single file, zero runtime deps
// (AGENTS.md 打包原则)。`ws` is bundled from devDependencies; the shipped app
// therefore carries no node_modules. CJS output: the ws bundle's runtime
// require('events') etc. only works in a CJS module scope, and a .cjs file is
// immune to the package's "type": "module".
import { build } from 'esbuild'
import { chmodSync, writeFileSync, readFileSync } from 'node:fs'

await build({
  entryPoints: ['daemon/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // ws's optional native accelerators are absent here — keep their require()
  // external so esbuild can bundle ws; at runtime ws's try/catch falls back
  // to the pure-JS path, which is exactly what we want in a shipped bundle.
  external: ['bufferutil', 'utf-8-validate'],
  outfile: 'out/daemon/index.cjs',
  logLevel: 'info',
})

// Standalone CLI artifact (scripts/package-daemon.mjs distributes it): same
// bundle with a shebang + exec bit, so an installed `pion-daemon` runs
// directly and the service units can exec it via the installing node.
const SHEBANG = '#!/usr/bin/env node\n'
const bundle = readFileSync('out/daemon/index.cjs', 'utf8')
writeFileSync('out/daemon/pion-daemon', SHEBANG + (bundle.startsWith('#!') ? '' : bundle), { mode: 0o755 })
chmodSync('out/daemon/pion-daemon', 0o755)
