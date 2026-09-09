// Hardcoded-string guard: renderer UI text must live in src/i18n/**, so any
// CJK character outside that directory (outside comments) is a regression.
// Usage: node scripts/check-i18n-strings.mjs [rootDir]  (default: cwd)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const SRC = join(root, 'src')
const I18N = join(SRC, 'i18n')
const CJK = /[\u4e00-\u9fff]/

// Strip // line comments and /* */ block comments (naive scanner; the
// ponytail ceiling is JSX comment edge cases, which never contain CJK here).
function stripComments(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += text[i]
    }
  }
  return out
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

const findings = []
for (const file of walk(SRC).sort()) {
  if (file.startsWith(I18N)) continue
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    if (CJK.test(line)) findings.push(`${file.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`)
  })
}

if (findings.length) {
  console.error(`hardcoded CJK found outside src/i18n (${findings.length} line(s)):`)
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}
console.log('no hardcoded CJK outside src/i18n — clean')
