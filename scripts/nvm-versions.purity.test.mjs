// nvm version-order suite (daemon/pi-rpc.ts bundled for node): the PATH prefix
// Pion hands to every pi child, which decides WHICH node runs pi.
import { nvmVersionDirsNewestFirst } from '../node_modules/.tmp/piRpc.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

const names = ['v9.11.0', 'v22.23.1', 'v18.20.4', 'v8.17.0', 'v20.11.1']

// 1. The regression: a lexicographic sort ranks "v9.11.0" above "v22.23.1", so
// the old order put an ancient node first on PATH — and pi's shebang
// (#!/usr/bin/env node) would then run under it, crashing every session.
assert([...names].sort().reverse()[0] === 'v9.11.0', 'lexicographic order would put v9.11.0 first (the bug)')
assert(nvmVersionDirsNewestFirst(names)[0] === 'v22.23.1', 'numeric order puts the newest node first')

// 2. Full ordering, newest → oldest.
const want = ['v22.23.1', 'v20.11.1', 'v18.20.4', 'v9.11.0', 'v8.17.0']
assert(JSON.stringify(nvmVersionDirsNewestFirst(names)) === JSON.stringify(want), `orders newest to oldest (${nvmVersionDirsNewestFirst(names).join(', ')})`)

// 3. Numeric comparison where strings disagree, both directions.
assert(nvmVersionDirsNewestFirst(['v9.11.0', 'v22.23.1'])[0] === 'v22.23.1', 'v22 outranks v9 (string compare would disagree)')
assert(nvmVersionDirsNewestFirst(['v22.9.0', 'v22.10.0'])[0] === 'v22.10.0', 'patch compared numerically (10 > 9)')
assert(nvmVersionDirsNewestFirst(['v20.11.1', 'v20.9.0'])[0] === 'v20.11.1', 'minor compared numerically')

// 4. Degenerate input must not throw or reorder randomly.
assert(JSON.stringify(nvmVersionDirsNewestFirst([])) === '[]', 'empty list')
assert(nvmVersionDirsNewestFirst(['v22.23.1'])[0] === 'v22.23.1', 'single entry')
assert(nvmVersionDirsNewestFirst(['v22.23.1', 'nvm-sh-stray-dir'])[0] === 'v22.23.1', 'a non-version dir sorts last')
assert(nvmVersionDirsNewestFirst(names).length === names.length, 'no entries dropped')

console.log(failures ? `\n${failures} FAILURES` : '\nall nvm-version checks passed')
process.exit(failures ? 1 : 0)
