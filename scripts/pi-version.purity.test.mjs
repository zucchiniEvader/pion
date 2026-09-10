// pi-version gate suite (src/lib/piVersion.ts bundled for node): the comparison
// behind the first-run "upgrade pi" gate.
import { isPiOutdated, parsePiVersion, MIN_PI_VERSION } from '../node_modules/.tmp/piVersion.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

// 1. The real case this gate exists for: a machine on pi 0.74.2 whose
// third-party extension needed >= 0.84.0, so every task died as "exited (1)".
assert(isPiOutdated('0.74.2') === true, 'pi 0.74.2 is outdated (the reported case)')

// 2. Boundaries.
assert(isPiOutdated(MIN_PI_VERSION) === false, `exactly ${MIN_PI_VERSION} is fine`)
assert(isPiOutdated('0.80.99') === true, '0.80.99 is below the floor')
assert(isPiOutdated('0.81.1') === false, '0.81.1 is above the floor')

// 3. The lexicographic trap, both directions. As STRINGS '0.9.0' > '0.81.0' and
// '0.100.0' < '0.81.0'; version components are compared numerically instead, so
// 9 < 81 and 100 > 81.
assert(isPiOutdated('0.9.0') === true, '0.9.0 is OLDER than 0.81.0 (9 < 81; string compare would say newer)')
assert(isPiOutdated('0.100.0') === false, '0.100.0 is newer than 0.81.0 (100 > 81; string compare would say older)')
assert(isPiOutdated('1.0.0') === false, '1.0.0 is newer')

// 4. Parsing tolerance: never treat a weird-but-good version as old.
assert(isPiOutdated('v0.85.1') === false, 'v-prefixed version parses')
assert(isPiOutdated('0.85') === false, 'two-segment version parses')
assert(isPiOutdated('pi 0.85.1') === false, 'version with a leading word parses')
assert(isPiOutdated('  0.85.1  ') === false, 'surrounding whitespace parses')

// 5. Unknown must NOT block: a failed `pi --version` is not evidence of age.
for (const unknown of [null, undefined, '', 'unknown', 'not-a-version', 'v']) {
  assert(isPiOutdated(unknown) === false, `unknown version (${JSON.stringify(unknown) ?? String(unknown)}) does not gate`)
}

// 6. parsePiVersion shape.
assert(JSON.stringify(parsePiVersion('0.85.1')) === '[0,85,1]', 'parsePiVersion 0.85.1')
assert(JSON.stringify(parsePiVersion('0.85')) === '[0,85,0]', 'parsePiVersion pads missing patch')
assert(parsePiVersion('nope') === null, 'parsePiVersion rejects garbage')

console.log(failures ? `\n${failures} FAILURES` : '\nall pi-version checks passed')
process.exit(failures ? 1 : 0)
