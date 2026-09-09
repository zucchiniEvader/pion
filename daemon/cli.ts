// pion-daemon standalone CLI (④ remote runtime install): subcommands on top
// of the same boot (boot.ts runDaemon) the desktop app spawns. The bundled
// daemon is pure JS — one artifact serves every OS/arch with node >= 18 — so
// the CLI's job is ops, not packaging:
//
//   serve      resident listener mode driven by a persisted config
//              (<userData>/daemon-config.json: token + ports, mode 0600)
//   install    persist config, write a launchd/systemd user unit, start it,
//              print the Host/Port/Token block to paste into Pion
//   uninstall  stop + remove the unit (--purge also deletes the data dir)
//   status     config, service state, pi detection, live TCP hello probe
//   token      show | rotate (rotate restarts the service when installed)
//
// install --dry-run prints the generated unit — that is the testable seam
// (scripts/daemon-cli-test.mjs) so wire tests never touch launchctl/systemd.
// All CLI output goes to stdout/stderr directly; nothing here writes protocol
// frames (serve is a resident listener — stdout carries no frames).
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { accessSync, constants as fsConstants } from 'node:fs'
import { Socket } from 'node:net'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DAEMON_PROTOCOL, DAEMON_PROTOCOL_VERSION } from '../contracts/daemon-protocol'
import { runDaemon, fail, DAEMON_VERSION } from './boot'
import { detectPi } from './pi-rpc'
import { lanHosts, pionLink, renderConnectQr } from './connect-info'

export const CLI_SUBCOMMANDS: ReadonlySet<string> = new Set(['serve', 'install', 'uninstall', 'status', 'token', 'version', 'help'])

interface Addr {
  host: string
  port: number
}

interface DaemonConfig {
  version: 1
  token: string
  listen: Addr
  listenWs: Addr | null
  createdAt: string
  updatedAt: string
}

const CONFIG_FILE = 'daemon-config.json'
const SERVICE_LABEL = 'com.pion.daemon' // launchd
const SERVICE_ID = 'pion-daemon' // systemd

// ── small output/parse helpers ─────────────────────────────────────────────

function say(line: string): void {
  process.stdout.write(line + '\n')
}

function warn(line: string): void {
  process.stderr.write(line + '\n')
}

interface CliFlags {
  positional: string[]
  get(name: string): string | undefined
  has(name: string): boolean
}

/** `--flag value`, `--flag=value`, repeatable-less booleans, positionals. */
function parseCliArgs(argv: string[]): CliFlags {
  const map = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        map.set(a.slice(2, eq), a.slice(eq + 1))
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        map.set(a.slice(2), argv[++i]!)
      } else {
        map.set(a.slice(2), true)
      }
    } else {
      positional.push(a)
    }
  }
  return {
    positional,
    get: (name) => {
      const v = map.get(name)
      return typeof v === 'string' ? v : undefined
    },
    has: (name) => map.has(name),
  }
}

function parseAddr(flag: string, value: string, allowEphemeral = false): Addr {
  const idx = value.lastIndexOf(':')
  const host = value.slice(0, idx)
  const port = Number(value.slice(idx + 1))
  if (!host || !Number.isInteger(port) || port < (allowEphemeral ? 0 : 1) || port > 65535) {
    fail(`${flag} must be <host:port>${allowEphemeral ? ' (port 0 = ephemeral)' : ''}, got: ${value}`)
  }
  return { host, port }
}

function generateToken(): string {
  return `pion-${randomBytes(18).toString('base64url')}`
}

// ── config store (<userData>/daemon-config.json, 0600) ─────────────────────

function defaultUserData(): string {
  return join(homedir(), '.pion')
}

/** The kanban bridge shipped next to the binary (install.sh layout). */
function defaultResources(userData: string): string | null {
  const dir = join(userData, 'share', 'resources')
  return existsSync(join(dir, 'kanban-bridge.ts')) ? dir : null
}

async function loadConfig(userData: string): Promise<DaemonConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(userData, CONFIG_FILE), 'utf8')) as DaemonConfig
    if (raw.version !== 1 || typeof raw.token !== 'string' || !raw.listen) return null
    return raw
  } catch {
    return null
  }
}

async function saveConfig(userData: string, config: DaemonConfig): Promise<void> {
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/** Reads the config, creating a minimal one (fresh token) when absent. Flag
 * overrides are persisted — install bakes --listen/--token into the config
 * the service later reads. A fresh config defaults to dual-port listening
 * (TCP for the desktop, WS on port+1 for phone clients) since the iOS app;
 * an explicit --no-listen-ws persists listenWs: null. */
async function loadOrCreateConfig(userData: string, overrides: { listen?: Addr; listenWs?: Addr | null; token?: string }): Promise<DaemonConfig> {
  const existing = await loadConfig(userData)
  let config: DaemonConfig
  if (existing) {
    config = existing
  } else {
    const listen = overrides.listen ?? { host: '0.0.0.0', port: 4970 }
    config = {
      version: 1,
      token: generateToken(),
      listen,
      listenWs: { host: '0.0.0.0', port: listen.port + 1 },
      createdAt: new Date().toISOString(),
      updatedAt: '',
    }
  }
  if (overrides.listen) config.listen = overrides.listen
  if (overrides.listenWs !== undefined) config.listenWs = overrides.listenWs
  if (overrides.token) config.token = overrides.token
  config.updatedAt = new Date().toISOString()
  await saveConfig(userData, config)
  return config
}

// ── host/PI discovery ──────────────────────────────────────────────────────

function looksExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** PATH scan + the fixed candidates pi-rpc also probes (minimal-PATH safety
 * for service managers), independent of detectPi's spawn probe. */
function findPiPath(): string | null {
  const candidates: string[] = []
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (dir) candidates.push(join(dir, 'pi'))
  }
  const home = homedir()
  for (const dir of [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']) {
    candidates.push(join(dir, 'pi'))
  }
  return candidates.find(looksExecutable) ?? null
}

function servicePathPrefix(piPath: string | null): string {
  const parts = [
    piPath ? dirname(piPath) : null,
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    process.platform === 'darwin' ? '/opt/homebrew/bin' : null,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter((p): p is string => typeof p === 'string')
  return [...new Set(parts)].join(':')
}

// ── service unit generation (launchd plist / systemd user unit) ────────────

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

function unitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_ID}.service`)
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

interface ServiceSpec {
  nodePath: string
  bundlePath: string
  userData: string
  resources: string | null
  pathPrefix: string
}

function serviceProgramArgs(spec: ServiceSpec): string[] {
  const args = [spec.nodePath, spec.bundlePath, 'serve', '--user-data', spec.userData]
  if (spec.resources) args.push('--resources', spec.resources)
  return args
}

function generatePlist(spec: ServiceSpec): string {
  const args = serviceProgramArgs(spec).map((a) => `    <string>${xmlEscape(a)}</string>`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(spec.pathPrefix)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(spec.userData, 'service.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(spec.userData, 'service.log'))}</string>
</dict>
</plist>
`
}

function generateSystemdUnit(spec: ServiceSpec): string {
  const exec = serviceProgramArgs(spec).map((a) => (a.includes(' ') ? `"${a.replaceAll('"', '\\"')}"` : a)).join(' ')
  return `[Unit]
Description=Pion daemon (remote runtime for the Pion desktop app)
After=network.target

[Service]
ExecStart=${exec}
Environment=PATH=${spec.pathPrefix}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

// ── service control (spawnSync; dry-run tests never reach these) ───────────

function runTool(cmd: string, args: string[], options: { check?: boolean } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (options.check && (r.error || r.status !== 0)) {
    fail(`${cmd} ${args.join(' ')} failed: ${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}`)
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function serviceStartOrRestart(spec: ServiceSpec): void {
  if (process.platform === 'darwin') {
    const plist = plistPath()
    runTool('launchctl', ['unload', plist])
    runTool('launchctl', ['load', '-w', plist], { check: true })
    return
  }
  if (process.platform === 'linux') {
    const reload = runTool('systemctl', ['--user', 'daemon-reload'])
    if (reload.status !== 0) failServiceUnavailable(reload.stderr)
    // enable --now does NOT restart an already-running unit — an install over
    // a live service must swap the process onto the new bundle (the same trap
    // serviceRestart's comment documents; a reload-only install would leave
    // yesterday's daemon serving today's files).
    const active = runTool('systemctl', ['--user', 'is-active', SERVICE_ID])
    if (active.status === 0) {
      const restart = runTool('systemctl', ['--user', 'restart', SERVICE_ID])
      if (restart.status !== 0) failServiceUnavailable(restart.stderr)
    } else {
      const enable = runTool('systemctl', ['--user', 'enable', '--now', SERVICE_ID])
      if (enable.status !== 0) failServiceUnavailable(enable.stderr)
    }
    return
  }
  fail(`unsupported platform "${process.platform}" for install; run manually: ${serviceProgramArgs(spec).join(' ')}`)
}

function failServiceUnavailable(stderr: string): never {
  fail(`systemctl --user failed (${stderr.trim() || 'no error output'}). Over SSH the user bus may be absent — try 'sudo loginctl enable-linger $USER' first, or run the daemon under your own supervisor.`)
}

/** Restart an already-installed service (token rotate must reload the new
 * secret; enable --now alone would leave a running service on the old one). */
function serviceRestart(): void {
  if (process.platform === 'darwin') {
    const plist = plistPath()
    runTool('launchctl', ['unload', plist])
    runTool('launchctl', ['load', '-w', plist], { check: true })
    return
  }
  if (process.platform === 'linux') {
    const r = runTool('systemctl', ['--user', 'restart', SERVICE_ID])
    if (r.status !== 0) failServiceUnavailable(r.stderr)
    return
  }
  fail(`unsupported platform "${process.platform}"; restart the daemon yourself`)
}

function serviceStopAndRemove(purgeData: boolean, userData: string): void {
  if (process.platform === 'darwin') {
    const plist = plistPath()
    if (!existsSync(plist)) {
      say(`not installed (no ${plist})`)
    } else {
      runTool('launchctl', ['unload', plist])
      void rm(plist).catch(() => undefined)
      say(`removed ${plist}`)
    }
  } else if (process.platform === 'linux') {
    const unit = unitPath()
    if (!existsSync(unit)) {
      say(`not installed (no ${unit})`)
    } else {
      runTool('systemctl', ['--user', 'disable', '--now', SERVICE_ID])
      void rm(unit).catch(() => undefined)
      runTool('systemctl', ['--user', 'daemon-reload'])
      say(`removed ${unit}`)
    }
  } else {
    warn(`unsupported platform "${process.platform}"; nothing to uninstall`)
  }
  if (purgeData) {
    void rm(userData, { recursive: true, force: true }).catch(() => undefined)
    say(`purged ${userData}`)
  } else {
    say(`config and logs kept in ${userData} (pass --purge to delete)`)
  }
}

interface ServiceState {
  installed: boolean
  detail: string
}

function serviceState(): ServiceState {
  if (process.platform === 'darwin') {
    const r = runTool('launchctl', ['list', SERVICE_LABEL])
    if (r.status !== 0) return { installed: false, detail: 'not loaded' }
    const pid = r.stdout.split('\t')[0]?.trim() ?? '-'
    return { installed: true, detail: pid !== '-' ? `running (pid ${pid})` : 'loaded, not running' }
  }
  if (process.platform === 'linux') {
    const active = runTool('systemctl', ['--user', 'is-active', SERVICE_ID])
    if (active.status !== 0) {
      const enabled = runTool('systemctl', ['--user', 'is-enabled', SERVICE_ID])
      return enabled.status === 0 ? { installed: true, detail: 'enabled, inactive' } : { installed: false, detail: 'not installed' }
    }
    return { installed: true, detail: `active (${active.stdout.trim()})` }
  }
  return { installed: false, detail: 'unknown platform' }
}

// ── live probe + connection info block ─────────────────────────────────────

async function tcpProbe(addr: Addr, token: string, timeoutMs = 1_500): Promise<string> {
  return new Promise((resolveProbe) => {
    const sock = new Socket()
    let buffer = ''
    const done = (detail: string): void => {
      sock.destroy()
      resolveProbe(detail)
    }
    const timer = setTimeout(() => done('offline (timeout)'), timeoutMs)
    sock.setTimeout(timeoutMs)
    sock.on('timeout', () => {
      clearTimeout(timer)
      done('offline (timeout)')
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      done(`offline (${err.message})`)
    })
    sock.on('connect', () => {
      sock.write(JSON.stringify({ type: 'hello', protocol: DAEMON_PROTOCOL, token }) + '\n')
    })
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx < 0) return
      clearTimeout(timer)
      try {
        const frame = JSON.parse(buffer.slice(0, idx)) as { type?: string; daemonVersion?: string; error?: { code: string; message: string } }
        if (frame.type === 'hello_ok') done(`reachable (daemon v${frame.daemonVersion ?? '?'}, protocol ok)`)
        else if (frame.type === 'hello_error') done(`reachable but handshake rejected (${frame.error?.code})`)
        else done(`reachable but unexpected frame (${frame.type ?? '?'})`)
      } catch {
        done('reachable but not a pion-daemon')
      }
    })
    sock.connect(addr.port, addr.host)
  })
}

function printConnectionInfo(config: DaemonConfig, title: string, options: { wsDisabled?: boolean } = {}): void {
  const hosts = lanHosts()
  // Effective WS endpoint: the configured one, the dual-port default the
  // daemon derives (listen port+1), or none under --no-listen-ws.
  const ws = options.wsDisabled ? null : config.listenWs ?? { host: '0.0.0.0', port: config.listen.port + 1 }
  const wsDerived = !options.wsDisabled && !config.listenWs
  const lines = [
    `── ${title} ──────────────────────────`,
    `  TCP JSONL : ${config.listen.host}:${config.listen.port}`,
    ...(ws ? [`  WS        : ${ws.host}:${ws.port}${wsDerived ? ' (derived default)' : ''}`] : []),
    `  Token     : ${config.token}`,
    '',
    'Paste into Pion → Settings → Runtimes → Manual:',
    `  Host : ${hosts.join('  or  ')}`,
    `  Port : ${config.listen.port}`,
    `  Token: ${config.token}`,
    '',
  ]
  if (ws) {
    const linkHost = hosts.find((h) => h !== hostname()) ?? '127.0.0.1'
    lines.push(`iOS app link: ${pionLink(linkHost, ws.port, config.token)}`)
    if (process.stdout.isTTY) {
      lines.push('', `Scan with the Pion iOS app (${linkHost}:${ws.port}):`, '', renderConnectQr(linkHost, ws.port, config.token))
    }
  }
  lines.push('──────────────────────────────────────────', '')
  say(lines.join('\n'))
}

// ── subcommands ────────────────────────────────────────────────────────────

async function cmdServe(flags: CliFlags): Promise<void> {
  if (flags.has('connect')) fail('serve is listener mode; dial-home is the legacy --connect invocation without subcommands')
  const userData = flags.get('user-data') ?? defaultUserData()
  const wsDisabled = flags.has('no-listen-ws')
  const config = await loadOrCreateConfig(userData, {
    listen: flags.has('listen') ? parseAddr('--listen', flags.get('listen')!) : undefined,
    listenWs: flags.has('listen-ws')
      ? parseAddr('--listen-ws', flags.get('listen-ws')!, true)
      : wsDisabled
        ? null
        : undefined,
    token: flags.get('token'),
  })
  const resources = flags.get('resources') ?? defaultResources(userData) ?? undefined
  printConnectionInfo(config, `pion-daemon serving on ${userData}`, { wsDisabled })
  await runDaemon({
    userData,
    resources,
    listen: config.listen,
    listenWs: config.listenWs ?? undefined,
    token: config.token,
    stayResident: true,
    noListenWs: wsDisabled,
  })
}

async function cmdInstall(flags: CliFlags): Promise<void> {
  const userData = flags.get('user-data') ?? defaultUserData()
  const wsDisabled = flags.has('no-listen-ws')
  const config = await loadOrCreateConfig(userData, {
    listen: flags.has('listen') ? parseAddr('--listen', flags.get('listen')!) : undefined,
    listenWs: flags.has('listen-ws')
      ? parseAddr('--listen-ws', flags.get('listen-ws')!, true)
      : wsDisabled
        ? null
        : undefined,
    token: flags.get('token'),
  })
  const resources = flags.get('resources') ?? defaultResources(userData)
  const rawBundle = process.argv[1] ?? ''
  let bundlePath: string
  try {
    bundlePath = realpathSync(rawBundle)
  } catch {
    bundlePath = rawBundle ? resolve(rawBundle) : fail('cannot determine the running bundle path (process.argv[1])')
  }
  const piPath = findPiPath()
  if (!piPath) warn("warn: 'pi' CLI not found — the daemon will serve but agent runtimes need pi on this machine")
  const spec: ServiceSpec = {
    nodePath: process.execPath,
    bundlePath,
    userData,
    resources,
    pathPrefix: servicePathPrefix(piPath),
  }

  if (process.platform === 'darwin') {
    const unit = generatePlist(spec)
    if (flags.has('dry-run')) {
      say(unit)
      printConnectionInfo(config, 'pion-daemon (dry run)', { wsDisabled })
      return
    }
    await mkdir(dirname(plistPath()), { recursive: true })
    await writeFile(plistPath(), unit, { mode: 0o644 })
    say(`wrote ${plistPath()}`)
  } else if (process.platform === 'linux') {
    const unit = generateSystemdUnit(spec)
    if (flags.has('dry-run')) {
      say(unit)
      printConnectionInfo(config, 'pion-daemon (dry run)', { wsDisabled })
      return
    }
    await mkdir(dirname(unitPath()), { recursive: true })
    await writeFile(unitPath(), unit, { mode: 0o644 })
    say(`wrote ${unitPath()}`)
  } else if (!flags.has('dry-run')) {
    fail(`unsupported platform "${process.platform}" for install; run manually:\n  ${serviceProgramArgs(spec).join(' ')}`)
  }

  if (!flags.has('no-start') && !flags.has('dry-run')) {
    serviceStartOrRestart(spec)
    say(`service ${SERVICE_LABEL} started (KeepAlive/Restart=always)`)
  }
  if (!resources) warn('warn: kanban bridge not found (expected <userData>/share/resources/kanban-bridge.ts) — kanban will report err.kanban.bridgeMissing until it is installed')
  printConnectionInfo(config, 'pion-daemon installed', { wsDisabled })
}

async function cmdUninstall(flags: CliFlags): Promise<void> {
  const userData = flags.get('user-data') ?? defaultUserData()
  serviceStopAndRemove(flags.has('purge'), userData)
}

async function cmdStatus(flags: CliFlags): Promise<void> {
  const userData = flags.get('user-data') ?? defaultUserData()
  const config = await loadConfig(userData)
  say(`pion-daemon ${DAEMON_VERSION} (protocol ${DAEMON_PROTOCOL_VERSION})`)
  say(`config   : ${config ? join(userData, CONFIG_FILE) : 'not configured (no daemon-config.json)'}`)
  if (config) {
    const ws = config.listenWs
      ? `ws ${config.listenWs.host}:${config.listenWs.port}`
      : `ws (derived on boot) ${config.listen.host}:${config.listen.port + 1}`
    say(`listen   : tcp ${config.listen.host}:${config.listen.port}, ${ws}`)
    say(`token    : ${config.token}`)
  }
  const service = serviceState()
  say(`service  : ${service.installed ? service.detail : `${service.detail} (not installed)`}`)
  const pi = await detectPi()
  say(`pi       : ${pi.path ? `${pi.version ?? 'unknown version'} (${pi.path})` : 'not found'}`)
  if (config) {
    say(`daemon   : ${await tcpProbe(config.listen, config.token)}`)
  }
}

async function cmdToken(flags: CliFlags): Promise<void> {
  const sub = flags.positional[0] ?? 'show'
  if (sub !== 'show' && sub !== 'rotate') fail(`usage: pion-daemon token [show|rotate]`)
  const userData = flags.get('user-data') ?? defaultUserData()
  const config = await loadOrCreateConfig(userData, {})
  if (sub === 'rotate') {
    config.token = generateToken()
    await saveConfig(userData, config)
    say('token rotated — update the token in every Pion client that connects to this runtime')
    if (serviceState().installed) {
      serviceRestart()
      say('service restarted with the new token')
    } else {
      warn('note: no installed service detected — restart the daemon yourself to apply the new token')
    }
  }
  printConnectionInfo(config, sub === 'rotate' ? 'new token' : 'pion-daemon token')
}

function cmdVersion(): void {
  say(`pion-daemon ${DAEMON_VERSION} (protocol ${DAEMON_PROTOCOL_VERSION}, node ${process.version})`)
}

function cmdHelp(): void {
  say(`pion-daemon — Pion's remote runtime daemon (PI agent host)

usage:
  pion-daemon serve [--listen <host:port>] [--listen-ws <host:port>]
                    [--no-listen-ws] [--token <secret>] [--user-data <dir>]
                    [--resources <dir>]
      Resident listener mode (default ports from daemon-config.json,
      first run generates the token + a WS endpoint on port+1 for the iOS
      app, printing a scannable pion:// QR). This is what the installed
      service runs.

  pion-daemon install [--listen <host:port>] [--listen-ws <host:port>]
                      [--no-listen-ws] [--token <secret>] [--user-data <dir>]
                      [--resources <dir>] [--dry-run] [--no-start]
      Persist the config, write the launchd (macOS) / systemd user (Linux)
      unit, start it, print the Host/Port/Token block for Pion's settings.

  pion-daemon status    [--user-data <dir>]   config + service + pi + probe
  pion-daemon token [show|rotate] [--user-data <dir>]
  pion-daemon uninstall [--purge] [--user-data <dir>]
  pion-daemon version
  pion-daemon help

Dual-port default: --listen-ws may be omitted — a bare --listen (or the
config default) also opens a WebSocket listener on port+1 (walking up while
the port is busy), which is what the Pion iOS app scans/connects to.
--no-listen-ws disables it. --listen-ws <host>:0 binds an ephemeral port.

spawn/dial-home invocations (used by the Pion app and its pairing flow) do
not use subcommands; the app also spawns its LOCAL daemon with
--stay-resident --owner-stdio --listen-ws 0.0.0.0:0 (stdio owner channel +
WS for the phone):
  pion-daemon --user-data <dir> [--resources <dir>]
  pion-daemon --user-data <dir> --connect <host:port> --token <secret>
  pion-daemon --user-data <dir> --stay-resident --listen <host:port> --token <secret>`)
}

export async function runCli(argv: string[]): Promise<void> {
  const sub = argv[0]!
  const flags = parseCliArgs(argv.slice(1))
  switch (sub) {
    case 'serve':
      return cmdServe(flags)
    case 'install':
      return cmdInstall(flags)
    case 'uninstall':
      return cmdUninstall(flags)
    case 'status':
      return cmdStatus(flags)
    case 'token':
      return cmdToken(flags)
    case 'version':
      return cmdVersion()
    case 'help':
      return cmdHelp()
    default:
      fail(`unknown subcommand: ${sub} (try 'pion-daemon help')`)
  }
}
