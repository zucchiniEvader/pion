// terminalPrefs parser suite (src/lib/terminalPrefs.ts bundled for node):
// anything in → always-valid prefs out.
import { parseTerminalPrefs, DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE } from '../node_modules/.tmp/terminalPrefs.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}

assert(parseTerminalPrefs(null).fontFamily === DEFAULT_TERMINAL_FONT_FAMILY, 'null → defaults')
assert(parseTerminalPrefs(null).fontSize === DEFAULT_TERMINAL_FONT_SIZE, 'null → default size')
assert(parseTerminalPrefs('junk').fontSize === DEFAULT_TERMINAL_FONT_SIZE, 'non-object → defaults')
assert(parseTerminalPrefs({}).fontSize === DEFAULT_TERMINAL_FONT_SIZE, 'empty object → defaults')

const ok = parseTerminalPrefs({ fontFamily: 'JetBrains Mono', fontSize: 14 })
assert(ok.fontFamily === 'JetBrains Mono' && ok.fontSize === 14, 'valid prefs kept')

assert(parseTerminalPrefs({ fontSize: 3 }).fontSize === DEFAULT_TERMINAL_FONT_SIZE, 'size below floor rejected')
assert(parseTerminalPrefs({ fontSize: 99 }).fontSize === DEFAULT_TERMINAL_FONT_SIZE, 'size above cap rejected')
assert(parseTerminalPrefs({ fontSize: 12.5 }).fontSize === DEFAULT_TERMINAL_FONT_SIZE, 'non-integer size rejected')
assert(parseTerminalPrefs({ fontFamily: '  ' }).fontFamily === DEFAULT_TERMINAL_FONT_FAMILY, 'blank family rejected')
assert(parseTerminalPrefs({ fontFamily: 42 }).fontFamily === DEFAULT_TERMINAL_FONT_FAMILY, 'non-string family rejected')
assert(parseTerminalPrefs({ fontFamily: 'x'.repeat(500) }).fontFamily.length === 200, 'family capped at 200 chars')

console.log(failures ? `${failures} FAILURE(S)` : 'terminal prefs parser: all ok')
process.exit(failures ? 1 : 0)
