// pion-daemon entry: owns no GUI APIs (goal.md §5.6 — it must always be
// able to run headless).
//
// Two invocation shapes share this entry (the shipped app spawns the same
// bundle the standalone CLI distributes):
//
// 1. Legacy spawn/dial-home (frozen arg surface, NOT subcommand-routed):
//    node pion-daemon.cjs --user-data <dir> [--resources <dir>]
//        [--stay-resident --listen <host:port>] [--listen-ws <host:port>]
//        [--no-listen-ws] [--owner-stdio]
//        [--connect <host:port> --token <secret>]
//    Electron main's LocalConnection uses --user-data --stay-resident
//    --owner-stdio --listen-ws 0.0.0.0:0 --token (stdio owner + WS for the
//    iOS client); the pairing one-liner uses --connect. A bare --listen
//    derives a WS listener on port+1 by default. Boot lives in boot.ts.
//
// 2. Standalone CLI (④ remote install): the first argument after the script
//    is a subcommand:
//    pion-daemon serve [--listen <host:port>] [--listen-ws <host:port>]
//    pion-daemon install [--listen ...] [--dry-run] [--no-start]
//    pion-daemon uninstall [--purge] | status | token [rotate] | version | help
//    Lives in cli.ts.
import { runDaemon, fail } from './boot'
import { runCli } from './cli'

interface DaemonArgs {
  userData: string
  resources: string
  listen?: { host: string; port: number }
  listenWs?: { host: string; port: number }
  connect?: { host: string; port: number }
  token?: string
  stayResident: boolean
  noListenWs?: boolean
  ownerStdio?: boolean
}

function parseArgs(argv: string[]): DaemonArgs {
  let userData: string | undefined
  let resources: string | undefined
  let listen: string | undefined
  let listenWs: string | undefined
  let connect: string | undefined
  let token: string | undefined
  let stayResident = false
  let noListenWs = false
  let ownerStdio = false
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--user-data') userData = argv[++i]
    else if (argv[i] === '--resources') resources = argv[++i]
    else if (argv[i] === '--listen') listen = argv[++i]
    else if (argv[i] === '--listen-ws') listenWs = argv[++i]
    else if (argv[i] === '--connect') connect = argv[++i]
    else if (argv[i] === '--token') token = argv[++i]
    else if (argv[i] === '--stay-resident') stayResident = true
    else if (argv[i] === '--no-listen-ws') noListenWs = true
    else if (argv[i] === '--owner-stdio') ownerStdio = true
  }
  if (!userData) fail('--user-data <dir> is required')
  // Dial-home (④ R3-1): a daemon dials OUT — it cannot also listen for
  // control clients, and --stay-resident is implied (stdin EOF never exits).
  if (connect && (listen || listenWs)) fail('--connect cannot be combined with --listen/--listen-ws')
  if (connect && !token) fail('--connect requires --token <secret>')
  if (connect) stayResident = true
  // Listeners only make sense for a resident daemon: a remote carrier must
  // not die on stdin EOF. token is the remote credential (spawn mode needs
  // neither). --owner-stdio keeps the spawn pipe as the owner channel, so it
  // implies resident + token the same way listeners do.
  if ((listen || listenWs || ownerStdio) && !stayResident) fail('--listen/--listen-ws/--owner-stdio requires --stay-resident')
  if ((listen || listenWs || ownerStdio) && !token) fail('--listen/--listen-ws/--owner-stdio requires --token <secret>')
  const parseAddr = (flag: string, value: string, allowEphemeral = false): { host: string; port: number } => {
    const idx = value.lastIndexOf(':')
    const host = value.slice(0, idx)
    const port = Number(value.slice(idx + 1))
    if (!host || !Number.isInteger(port) || port < (allowEphemeral ? 0 : 1) || port > 65535) {
      fail(`${flag} must be <host:port>${allowEphemeral ? ' (port 0 = ephemeral)' : ''}, got: ${value}`)
    }
    return { host, port }
  }
  if (noListenWs && listenWs) fail('--no-listen-ws cannot be combined with --listen-ws')
  if (ownerStdio && connect) fail('--owner-stdio cannot be combined with --connect')
  return {
    userData,
    resources: resources ?? '',
    listen: listen ? parseAddr('--listen', listen) : undefined,
    listenWs: listenWs ? parseAddr('--listen-ws', listenWs, true) : undefined,
    connect: connect ? parseAddr('--connect', connect) : undefined,
    token,
    stayResident,
    noListenWs,
    ownerStdio,
  }
}

async function main(): Promise<void> {
  const argv = process.argv
  // Subcommand routing: ANY bare word at argv[2] is a CLI invocation — every
  // legacy spawn/dial-home command starts with a --flag, so a bare first
  // argument can never be a legacy value. Known words dispatch; unknown ones
  // get "unknown subcommand" instead of the misleading --user-data error.
  if (argv.length > 2 && !argv[2]!.startsWith('--')) {
    await runCli(argv.slice(2))
    return
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    await runCli(['help'])
    return
  }
  if (argv.includes('--version')) {
    await runCli(['version'])
    return
  }
  // Bare invocation in a terminal (double-clicked binary, curious human):
  // help instead of the --user-data error. Non-TTY keeps the legacy path so
  // any external spawn with a piped stdin behaves exactly as before.
  if (argv.length <= 2 && process.stdin.isTTY) {
    await runCli(['help'])
    return
  }
  await runDaemon(parseArgs(argv))
}

void main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)))
