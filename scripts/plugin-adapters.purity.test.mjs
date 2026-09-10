// Purity suite for the plugin adaptation channel (src/lib/pluginAdapters.ts).
//
// The channel exists because pi's RPC surface cannot carry a plugin's own
// argument completions, so Pion keeps the tables and must not lie about them:
// the two decisions worth pinning down are
//   (a) the install gate — an adapter may only answer for a command the running
//       pi actually reports from that plugin's source, and
//   (b) the draft split — "/mcp token se" must resolve to level "token" with
//       prefix "se", never to a level that does not exist.
// Inputs are deep-frozen and every call is made twice with results compared,
// mirroring React StrictMode's double-invoked render.
import {
  argumentCompletions,
  PLUGIN_ADAPTERS,
} from '../node_modules/.tmp/pluginAdapters.bundle.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ok  ${label}`) } else { failures++; console.error(`FAIL  ${label}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const deepFreeze = (v) => {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(v[k])
    Object.freeze(v)
  }
  return v
}

// pi's real get_commands shapes, trimmed to the fields the channel reads.
const cmd = (name, source, sourceInfo) => ({ name, source, sourceInfo })
const MCP_SOURCE = { source: 'npm:pi-mcp-adapter', origin: 'package', baseDir: '/home/u/.pi/agent/npm/node_modules/pi-mcp-adapter', path: 'node_modules/pi-mcp-adapter/index.ts' }
const PLAN_SOURCE = { source: 'npm:@narumitw/pi-plan-mode', origin: 'package', baseDir: '/home/u/.pi/agent/npm/node_modules/@narumitw/pi-plan-mode', path: 'pi-plan-mode/dist/index.ts' }
const POINYTAIL_SOURCE = { source: 'npm:@dietrichgebert/ponytail', origin: 'package', baseDir: '/home/u/.pi/agent/npm/node_modules/@dietrichgebert/ponytail' }

const installed = deepFreeze([
  cmd('mcp', 'extension', MCP_SOURCE),
  cmd('pi-mcp', 'extension', MCP_SOURCE),
  cmd('plan', 'extension', PLAN_SOURCE),
  cmd('ponytail', 'extension', POINYTAIL_SOURCE),
  cmd('council', 'prompt', PLAN_SOURCE),
  { name: 'session-name', source: 'extension' }, // extension with no sourceInfo
])

const run = (draft, commands = installed) => argumentCompletions({ commands, draft })
const values = (result) => (result ? result.items.map((i) => i.value) : null)

console.log('adapter table')
assert(PLUGIN_ADAPTERS.length === 2, 'two adapters ship today (plan-mode, mcp)')
assert(new Set(PLUGIN_ADAPTERS.map((a) => a.id)).size === PLUGIN_ADAPTERS.length, 'adapter ids are unique')
for (const adapter of PLUGIN_ADAPTERS) {
  for (const [path, items] of Object.entries(adapter.completions)) {
    const seen = new Set()
    for (const item of items) {
      const value = typeof item === 'string' ? item : item.value
      assert(!seen.has(value), `${adapter.id}: "${path}" has no duplicate "${value}"`)
      seen.add(value)
      assert(!/^\s|\s$/.test(value), `${adapter.id}: "${value}" carries no stray whitespace`)
    }
  }
}

console.log('\nlevel 1')
assert(eq(values(run('/plan ')), ['start', 'show', 'finalize', 'implement', 'save', 'export', 'exit', 'off', 'tools']), '/plan lists all nine subcommands')
assert(eq(values(run('/mcp ')), ['reconnect', 'tools', 'prompts', 'setup', 'logout', 'token', 'disable', 'enable', 'status']), '/mcp lists its subcommands')
assert(eq(values(run('/pi-mcp ')), values(run('/mcp '))), 'the second registration of the same handler completes identically')
assert(run('/mcp ').items.every((i) => typeof i.description === 'string' && i.description.length > 0), 'every MCP candidate carries its description')

console.log('\nprefix filtering')
assert(eq(values(run('/plan s')), ['start', 'show', 'save']), 'partial argument filters by prefix')
assert(eq(values(run('/plan STAR')), ['start']), 'filtering is case-insensitive')
assert(eq(values(run('/mcp re')), ['reconnect']), 'partial argument on the MCP tree')
assert(run('/plan zz') === null, 'no candidates → null, so the popup stays shut')

console.log('\nlevel 2 and beyond')
assert(eq(values(run('/mcp token ')), ['set', 'remove', 'status']), '/mcp token opens the second level')
assert(eq(values(run('/mcp token r')), ['remove']), 'second level filters too')
assert(run('/mcp token set ') === null, 'the undeclared server-name level stays quiet instead of guessing')
assert(run('/plan start x') === null, 'plan has no second level')

console.log('\ndraft shapes')
assert(run('/mcp') === null, 'command-name phase belongs to the command popup, not here')
assert(run('hello world') === null, 'ordinary prose is not a draft')
assert(run('/mcp  ') !== null, 'repeated spaces still count as one separator')
assert(run('/MCP token ') === null, 'command names are matched exactly, like pi does — an uppercase spelling never runs the command')
assert(run('/mcp TOKEN ') === null, 'already-typed arguments key the level exactly too: the plugin itself switches on the literal case')
assert(run('/mcp TOKEN ') === null || run('/mcp token ').items.length === 3, 'the declared level is reachable with the canonical spelling')
assert(run('/mcp ').completed.length === 0 && run('/mcp token ').completed.join(' ') === 'token', 'completed arguments are reported back for draft rebuild')

console.log('\ninstall gate')
assert(run('/ponytail ') === null, 'a plugin without an adapter gets no completion')
assert(run('/council ') === null, 'a prompt template from an adapted plugin is not an extension command')
const withoutMcp = deepFreeze(installed.filter((c) => c.name !== 'mcp' && c.name !== 'pi-mcp'))
assert(argumentCompletions({ commands: withoutMcp, draft: '/mcp ' }) === null, 'adapter is inert when the plugin is not installed')
const otherSource = deepFreeze([cmd('mcp', 'extension', { source: 'npm:some-fork-of-mcp' })])
assert(argumentCompletions({ commands: otherSource, draft: '/mcp ' }) === null, 'a different plugin claiming the name does not trigger our table')
assert(argumentCompletions({ commands: deepFreeze([{ name: 'mcp', source: 'extension' }]), draft: '/mcp ' }) === null, 'no sourceInfo → no match')
assert(argumentCompletions({ commands: deepFreeze([cmd('mcp', 'skill', MCP_SOURCE)]), draft: '/mcp ' }) === null, 'only extension commands qualify')

console.log('\nlocal checkout installs')
const localSource = deepFreeze({ source: '/Users/u/code/pi-plan-mode/dist/index.ts', origin: 'top-level', baseDir: '/Users/u/code/pi-plan-mode' })
assert(argumentCompletions({ commands: deepFreeze([cmd('plan', 'extension', localSource)]), draft: '/plan ' }) !== null, 'a plugin loaded from a local checkout matches by directory')

console.log('\npurity')
const frozen = deepFreeze({ commands: installed, draft: '/mcp token ' })
assert(eq(argumentCompletions(frozen), argumentCompletions(frozen)), 'repeated calls agree (StrictMode-safe)')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall plugin-adapter checks passed')
process.exit(failures ? 1 : 0)
