// fileMentions purity suite (src/lib/fileMentions.ts bundled for node):
// @ token extraction, substring ranking, and the accept-replace edit.
import { findFileMention, rankFileMentions, applyFileMention } from '../node_modules/.tmp/fileMentions.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

// 1. findFileMention: triggers at start / after whitespace, not in a@b.
const atStart = findFileMention('@src', 4)
assert(atStart?.start === 0 && atStart.query === 'src', `start-of-text token (${JSON.stringify(atStart)})`)
const midText = findFileMention('check @app.t', 12)
assert(midText?.start === 6 && midText.query === 'app.t', `mid-text token after space (${JSON.stringify(midText)})`)
assert(findFileMention('a@b', 3) === null, 'email-like a@b does not trigger')
assert(findFileMention('see @x y', 8) === null, 'cursor past the token does not trigger')
assert(findFileMention('@', 1)?.query === '', 'bare @ opens with empty query')
assert(findFileMention('@a@b', 4) === null, 'second @ inside query does not trigger')

// 2. rankFileMentions: basename hit beats directory hit; shorter wins ties.
const files = ['src/app.ts', 'src/components/app.tsx', 'docs/app.md', 'src/lib/utils.ts']
const ranked = rankFileMentions(files, 'app')
assert(ranked[0] === 'src/app.ts', `basename+shortest first (${ranked[0]})`)
assert(ranked.includes('docs/app.md') && ranked.includes('src/components/app.tsx'), 'all basename hits ranked')
assert(!ranked.includes('src/lib/utils.ts'), 'non-matching path excluded')
assert(rankFileMentions(files, 'UTILS')[0] === 'src/lib/utils.ts', 'case-insensitive match')
assert(rankFileMentions(files, '').length === files.length, 'empty query lists everything')
assert(rankFileMentions(files, 'components')[0] === 'src/components/app.tsx', 'directory-part hit still found')

// 3. applyFileMention: drops the @, inserts bare path + trailing space.
const mention = findFileMention('please read @uti', 16)
const applied = applyFileMention('please read @uti', mention, 'src/lib/utils.ts')
assert(applied.text === 'please read src/lib/utils.ts ', `token replaced with bare path (${applied.text})`)
assert(applied.cursor === 29 && applied.text[applied.cursor - 1] === ' ', `cursor after inserted path (${applied.cursor})`)

process.exit(failures ? 1 : 0)
