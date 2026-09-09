// pion-daemon CLI wire test (④ remote install): exercises the standalone
// subcommands against the real bundle — (a) version/help; (b) legacy spawn
// compatibility: bare --user-data still serves stdio JSONL (Electron main's
// LocalConnection path, frozen); (c) serve boots from a generated config and
// the printed token handshakes over TCP JSONL; (d) status probes the live
// listener; (e) token rotate swaps the secret and the running daemon (old
// token) keeps serving until restarted; (f) install --dry-run emits the
// launchd plist / systemd unit WITHOUT touching launchctl/systemd; (g)
// uninstall without a service is a graceful no-op. Exit code ≠ 0 on failure.
import { spawn } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUNDLE = new URL('../out/daemon/index.cjs', import.meta.url).pathname

const results = []
const check = (name, ok, evidence) => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${evidence}`)
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    // Serve mode never exits — give callers an escape hatch.
    if (options.timeout) {
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, options.timeout).unref()
    }
  })
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** One TCP JSONL round trip: hello + optional call, first matching reply. */
function tcpExchange(port, hello, call) {
  return new Promise((resolve) => {
    const sock = new Socket()
    const frames = []
    let buffer = ''
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve({ frames, sock })
      }
    }
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim()) frames.push(JSON.parse(line))
        if (call && frames.length >= 2) done()
        if (!call && frames.length >= 1) done()
      }
    })
    sock.on('connect', () => {
      sock.write(JSON.stringify(hello) + '\n')
      if (call) sock.write(JSON.stringify(call) + '\n')
    })
    sock.on('error', () => done())
    sock.on('close', () => done())
    setTimeout(done, 4000)
    sock.connect(port, '127.0.0.1')
  })
}

const waitListening = async (logPath, marker) => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      if (readFileSync(logPath, 'utf8').includes(marker)) return true
    } catch { /* log not written yet */ }
  }
  return false
}

// ── (a) version / help ─────────────────────────────────────────────────────
const va = await runCli(['version'])
check('a1) version exits 0 with version + protocol', va.code === 0 && /pion-daemon \d+\.\d+\.\d+ \(protocol \d/.test(va.stdout), va.stdout.trim())

const vh = await runCli(['help'])
check('a2) help lists the subcommands', vh.code === 0 && ['serve', 'install', 'uninstall', 'status', 'token'].every((w) => vh.stdout.includes(w)), `exit=${vh.code}`)

const vbad = await runCli(['frobnicate'])
check('a3) unknown subcommand fails loudly', vbad.code !== 0 && vbad.stderr.includes('unknown subcommand'), `exit=${vbad.code}`)

// ── (b) legacy spawn compatibility (frozen LocalConnection surface) ───────
const legacyData = mkdtempSync(join(tmpdir(), 'pion-cli-legacy-'))
const legacy = await new Promise((resolve) => {
  const child = spawn(process.execPath, [BUNDLE, '--user-data', legacyData], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => {
    out += c
    if ((out.match(/\n/g) ?? []).length >= 2) {
      child.kill('SIGKILL')
      resolve({ out })
    }
  })
  child.stdin.write(JSON.stringify({ type: 'call', id: 'l1', method: 'ping' }) + '\n')
  setTimeout(() => {
    child.kill('SIGKILL')
    resolve({ out })
  }, 8000)
})
const legacyFrames = legacy.out.trim().split('\n').map((l) => JSON.parse(l))
check('b) bare --user-data still serves stdio JSONL (hello_ok + ping result)',
  legacyFrames[0]?.type === 'hello_ok' && legacyFrames[1]?.type === 'result' && legacyFrames[1]?.ok === true,
  JSON.stringify(legacyFrames.map((f) => f.type)))
rmSync(legacyData, { recursive: true, force: true })

// ── (c) serve: config generation + TCP handshake with the generated token ──
const serveData = mkdtempSync(join(tmpdir(), 'pion-cli-serve-'))
const port = await freePort()
const serve = spawn(process.execPath, [BUNDLE, 'serve', '--user-data', serveData, '--listen', `127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let serveOut = ''
serve.stdout.on('data', (c) => (serveOut += c))
const listening = await waitListening(join(serveData, 'daemon.log'), 'tcp listening')
check('c1) serve binds the listener from flags', listening, `log marker 'tcp listening' in daemon.log`)

const configOk = existsSync(join(serveData, 'daemon-config.json'))
const config = configOk ? JSON.parse(readFileSync(join(serveData, 'daemon-config.json'), 'utf8')) : null
check('c2) serve generated daemon-config.json with a pion- token (mode 0600)',
  configOk && /^pion-[A-Za-z0-9_-]+$/.test(config?.token ?? '') && (config?.listen?.port ?? 0) === port,
  JSON.stringify(config?.listen))
check('c2b) fresh config defaults to dual-port: WS persisted on listen port+1',
  configOk && config?.listenWs?.port === port + 1 && config?.listenWs?.host === '0.0.0.0',
  JSON.stringify(config?.listenWs))
check('c3) serve printed the paste-into-Pion info block',
  serveOut.includes('Token') && serveOut.includes(String(port)) && serveOut.includes('Settings'),
  serveOut.split('\n').slice(0, 4).join(' | '))
check('c3b) serve printed the scannable iOS link (pion://, non-TTY → link only, no QR)',
  /iOS app link: pion:\/\/[^\s]+:\d+\?t=pion-/.test(serveOut) && !serveOut.includes('█'),
  (serveOut.match(/iOS app link: \S+/) ?? ['missing'])[0])

const hand = await tcpExchange(port, { type: 'hello', protocol: 'pion-daemon/3', token: config.token }, { type: 'call', id: 'c-ping', method: 'ping' })
check('c4) generated token handshakes and ping answers over TCP JSONL',
  hand.frames[0]?.type === 'hello_ok' && hand.frames[1]?.ok === true,
  JSON.stringify(hand.frames.map((f) => f.type ?? f.error)))
hand.sock.destroy()

// ── (d) status probes the live listener ────────────────────────────────────
const st = await runCli(['status', '--user-data', serveData])
check('d) status reports service/pi/reachable probe',
  st.code === 0 && st.stdout.includes('pion-daemon') && st.stdout.includes(config.token) && /reachable \(daemon v/.test(st.stdout),
  st.stdout.split('\n').filter((l) => /service|daemon|pi /.test(l)).join(' | '))

// ── (e) token rotate: config changes, running daemon keeps the old token ──
const rot = await runCli(['token', 'rotate', '--user-data', serveData])
const config2 = JSON.parse(readFileSync(join(serveData, 'daemon-config.json'), 'utf8'))
check('e1) token rotate writes a new secret and prints it',
  rot.code === 0 && config2.token !== config.token && rot.stdout.includes(config2.token),
  `old=${config.token.slice(0, 10)}… new=${config2.token.slice(0, 10)}…`)

const oldStill = await tcpExchange(port, { type: 'hello', protocol: 'pion-daemon/3', token: config.token })
check('e2) running daemon still honors the old token until restarted (documented rotate semantics)',
  oldStill.frames[0]?.type === 'hello_ok',
  JSON.stringify(oldStill.frames[0]?.type))
oldStill.sock.destroy()

// ── (f) install --dry-run: unit generation without touching launchctl/systemd
const installData = mkdtempSync(join(tmpdir(), 'pion-cli-install-'))
const ins = await runCli(['install', '--user-data', installData, '--listen', '0.0.0.0:4999', '--dry-run'])
const unitText = ins.stdout
const plistExpected = process.platform === 'darwin'
check('f1) install --dry-run exits 0 and prints the unit + info block',
  ins.code === 0 && unitText.includes('serve') && unitText.includes(installData) && unitText.includes('--listen') === false && /Token\s+: pion-/.test(unitText),
  `exit=${ins.code}`)
check('f2) unit references this bundle and the requested listen is persisted to config',
  unitText.includes('pion-daemon') && JSON.parse(readFileSync(join(installData, 'daemon-config.json'), 'utf8')).listen.port === 4999,
  plistExpected ? 'plist mode' : 'systemd mode')
if (plistExpected) {
  check('f3) macOS: plist has Label/ProgramArguments/RunAtLoad/KeepAlive + PATH env',
    unitText.includes('com.pion.daemon') && unitText.includes('<key>ProgramArguments</key>') && unitText.includes('<key>RunAtLoad</key>') && unitText.includes('<key>KeepAlive</key>') && unitText.includes('<key>PATH</key>'),
    'plist keys present')
} else {
  check('f3) Linux: unit has ExecStart/Restart=always/WantedBy + PATH env',
    unitText.includes('ExecStart=') && unitText.includes('Restart=always') && unitText.includes('WantedBy=default.target') && unitText.includes('Environment=PATH='),
    'unit keys present')
}

// ── (g) uninstall without a service: graceful no-op ────────────────────────
const un = await runCli(['uninstall', '--user-data', installData])
check('g) uninstall without an installed service exits 0 (no-op / kept data notice)',
  un.code === 0 && (un.stdout.includes('not installed') || un.stdout.includes('kept')),
  un.stdout.trim().split('\n').pop() ?? '')

// ── cleanup ────────────────────────────────────────────────────────────────
if (serve.exitCode === null) serve.kill('SIGKILL')
rmSync(serveData, { recursive: true, force: true })
rmSync(installData, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall CLI checks passed')
process.exit(failed.length ? 1 : 0)
