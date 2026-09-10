// ── Community-plugin adaptation channel ───────────────────────────────────
//
// pi's RPC surface carries no argument completion: `get_commands` returns
// name/description/source only, and an extension's own `getArgumentCompletions`
// function never leaves pi's process (`ui.addAutocompleteProvider` is a no-op
// in RPC mode). So the argument tables for a few plugins live here instead —
// one small adapter per plugin, declarative, no plugin code involved.
//
// Scope: argument completion, nothing else. If pi ever exposes completions over
// RPC, delete this file and its consumers in favour of that.
//
// One adapter = one plugin:
//   id / aliases  matched against pi's `sourceInfo` for the plugin's commands
//   commands      which of the plugin's commands the tree applies to
//   completions   "<preceding args>" → candidates for the NEXT argument
//
// The gate is structural: an adapter is only consulted for a command the
// running pi actually reports from that source, so a plugin that is not
// installed — or is disabled, or was skipped because `--no-extensions` had to
// be used — leaves its adapter inert. Nothing has to track install state.
//
// Adding an adapter: find the plugin's `getArgumentCompletions` (or its docs),
// copy the candidates and descriptions verbatim, and add a test row. Levels
// whose candidates need live state (MCP's server names, for instance) are left
// out on purpose: no popup beats a wrong popup.
import type { PiCommandInfo, PiCommandSourceInfo } from '@/types'

export interface PluginArgumentCompletion {
  /** Written as the next argument; Pion adds the separating space. */
  value: string
  /** Defaults to `value`. */
  label?: string
  description?: string
}

export interface PluginAdapter {
  /** pi's `sourceInfo.source` for this plugin's commands, e.g. "npm:pi-mcp-adapter". */
  id: string
  /** Other ids the same plugin reports: bare package name, or a local checkout's
   * directory (matched against `baseDir`/`path`). */
  aliases?: string[]
  /** Shown in the popup, so it is clear which plugin supplies the candidates. */
  name: string
  /** Command names this tree applies to (a plugin may register several). */
  commands: string[]
  /** Key = the arguments already completed ("" = first argument). */
  completions: Record<string, Array<string | PluginArgumentCompletion>>
}

/** Mirrors pi-mcp-adapter's `getArgumentCompletions`; `pi-mcp` is the same
 * handler registered under a second name. Server names (the level after
 * `token set|remove`) come from the plugin's live config and are omitted. */
const MCP_ARGUMENTS: Array<string | PluginArgumentCompletion> = [
  { value: 'reconnect', description: 'Reconnect servers' },
  { value: 'tools', description: 'List all tools' },
  { value: 'prompts', description: 'List all MCP prompts' },
  { value: 'setup', description: 'Configure MCP servers' },
  { value: 'logout', description: 'Clear server credentials' },
  { value: 'token', description: 'Manage stored bearer tokens' },
  { value: 'disable', description: 'Disable a server' },
  { value: 'enable', description: 'Enable a server' },
  { value: 'status', description: 'Show server status' },
]

/** Mirrors pi-plan-mode's `completePlanArguments`. */
const PLAN_ARGUMENTS: Array<string | PluginArgumentCompletion> = [
  { value: 'start', description: 'Start Plan mode without sending a prompt' },
  { value: 'show', description: 'Show the ready, saved, or active plan' },
  { value: 'finalize', description: 'Request a completed plan' },
  { value: 'implement', description: 'Implement the completed or saved plan' },
  { value: 'save', description: 'Save the completed plan for later' },
  { value: 'export', description: 'Export the stored plan to a Markdown file' },
  { value: 'exit', description: 'Leave Plan mode or clear a saved/active plan' },
  { value: 'off', description: 'Leave Plan mode or clear a saved/active plan' },
  { value: 'tools', description: 'Choose tools before starting this Plan workflow' },
]

export const PLUGIN_ADAPTERS: readonly PluginAdapter[] = [
  {
    id: 'npm:@narumitw/pi-plan-mode',
    aliases: ['pi-plan-mode'],
    name: 'Plan mode',
    commands: ['plan'],
    completions: { '': PLAN_ARGUMENTS },
  },
  {
    id: 'npm:pi-mcp-adapter',
    aliases: ['pi-mcp-adapter'],
    name: 'MCP',
    commands: ['mcp', 'pi-mcp'],
    completions: {
      '': MCP_ARGUMENTS,
      token: ['set', 'remove', 'status'],
    },
  },
]

export interface ArgumentCompletionResult {
  adapter: PluginAdapter
  /** The command name as the runtime spells it (the draft may be "/MCP …"). */
  command: string
  /** Arguments already completed before the one being typed. */
  completed: string[]
  items: PluginArgumentCompletion[]
}

function normalizeItem(item: string | PluginArgumentCompletion): PluginArgumentCompletion {
  return typeof item === 'string' ? { value: item } : item
}

/** Matches a command's pi-reported source against an adapter. `source` is the
 * strong id ("npm:<package>"); the directory fields catch plugins loaded from a
 * local path (`-e ~/code/pi-plan-mode/index.ts`). */
function adapterFor(source: PiCommandSourceInfo | undefined): PluginAdapter | null {
  if (!source) return null
  const keys = [source.source, source.baseDir, source.path]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.toLowerCase().replace(/\\/g, '/'))
  if (keys.length === 0) return null
  for (const adapter of PLUGIN_ADAPTERS) {
    const ids = [adapter.id, ...(adapter.aliases ?? [])].map((id) => id.toLowerCase())
    for (const key of keys) {
      for (const id of ids) {
        if (key === id || key.endsWith(`/${id}`) || key.includes(`/${id}/`)) return adapter
      }
    }
  }
  return null
}

/** Splits "/mcp token se" into the command, the arguments already completed and
 * the argument being typed. Returns null unless the draft has a space, i.e. is
 * past the command-name phase. */
function parseArgumentDraft(
  draft: string,
): { command: string; completed: string[]; prefix: string } | null {
  const match = /^\/(\S+)[ \t]+(.*)$/.exec(draft)
  if (!match) return null
  const command = match[1]!
  const tail = match[2]!
  const words = tail.split(/[ \t]+/).filter((word) => word.length > 0)
  // A trailing space means the next argument has not been started yet.
  const typing = tail.length > 0 && !/[ \t]$/.test(tail)
  return {
    command,
    completed: typing ? words.slice(0, -1) : words,
    prefix: typing ? (words[words.length - 1] ?? '') : '',
  }
}

/** Argument candidates for a draft, or null when no adapter answers for it. */
export function argumentCompletions(input: {
  commands: readonly PiCommandInfo[]
  draft: string
}): ArgumentCompletionResult | null {
  const parsed = parseArgumentDraft(input.draft)
  if (!parsed) return null
  // Exact name on purpose: pi resolves extension commands with
  // `invocationName === name`, so "/MCP token " is not a command pi will run —
  // it goes to the model as prose, and completing its arguments would be a lie.
  // (The command-name phase upstream does complete the uppercase spelling and
  // rewrites the draft to the canonical name on accept.)
  const command = input.commands.find(
    (c) => c.source === 'extension' && c.name === parsed.command,
  )
  if (!command) return null
  const adapter = adapterFor(command.sourceInfo)
  if (!adapter || !adapter.commands.includes(command.name)) return null
  const declared = adapter.completions[parsed.completed.join(' ')]
  if (!declared) return null
  const prefix = parsed.prefix.toLowerCase()
  const items = declared
    .map(normalizeItem)
    .filter((item) => item.value.toLowerCase().startsWith(prefix))
  if (items.length === 0) return null
  return { adapter, command: command.name, completed: parsed.completed, items }}
