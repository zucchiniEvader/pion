// git status parser suite (daemon/git-status.ts bundled for node):
// parsePorcelainZ behind the right-side changes panel.
import { parsePorcelainZ } from '../node_modules/.tmp/gitStatus.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

// 1. Plain entries: XY + space + path, NUL-terminated.
{
  const files = parsePorcelainZ(' M src/App.tsx\0?? notes.md\0A  new-file.ts\0')
  assert(files.length === 3, 'three entries')
  assert(files[0].path === 'src/App.tsx' && files[0].x === ' ' && files[0].y === 'M', 'worktree-modified parsed')
  assert(files[1].x === '?' && files[1].y === '?', 'untracked parsed')
  assert(files[2].x === 'A' && files[2].path === 'new-file.ts', 'staged-add parsed')
}

// 2. Rename: -z puts the NEW path in the entry and the ORIGINAL in an extra
// chunk that must be consumed (not mistaken for another file).
{
  const files = parsePorcelainZ('R  src/new-name.ts\0src/old-name.ts\0 M other.ts\0')
  assert(files.length === 2, 'rename consumes its orig chunk (2 files, not 3)')
  assert(files[0].path === 'src/new-name.ts' && files[0].x === 'R', 'rename keeps the new path')
  assert(files[1].path === 'other.ts', 'entry after a rename still aligns')
}

// 3. Paths with spaces and CJK come through unquoted in -z mode.
{
  const files = parsePorcelainZ(' M my docs/设计 稿.md\0')
  assert(files.length === 1 && files[0].path === 'my docs/设计 稿.md', 'spaces/CJK unquoted')
}

// 4. Ignored entries are dropped; empty input is empty.
{
  assert(parsePorcelainZ('!! node_modules/\0 M a.ts\0').length === 1, 'ignored entries skipped')
  assert(parsePorcelainZ('').length === 0, 'empty input')
}

console.log(failures ? `${failures} FAILURE(S)` : 'git status parser: all ok')
process.exit(failures ? 1 : 0)
