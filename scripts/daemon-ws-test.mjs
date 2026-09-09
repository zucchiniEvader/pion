// WS + TCP JSONL carrier wire test (protocol v3, goal.md §9): spawns
// resident daemons with --listen-ws + --listen and verifies the full
// handshake gate on both carriers:
// (a) wrong token → hello_error(unauthorized); (b) wrong protocol →
// hello_error(version_mismatch); (c) correct hello → hello_ok; (d) ping →
// result; (e) second..fourth clients attach (v3 multi-client, cap 4) and the
// fifth → hello_error(conflict); (f) daemon.shutdown from a listen carrier →
// hello ok:false unauthorized and the process STAYS alive (owner carriers
// only). TCP JSONL exists because Electron main cannot be a WS client
// (event-loop stall, goal.md v3 §5.2). Exit code ≠ 0 on failure.
import { spawn } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const BUNDLE = new URL('../out/daemon/index.cjs', import.meta.url).pathname
const TOKEN = 's3cret'

const results = []
const check = (name, ok, evidence) => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${evidence}`)
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

/** One WS connection: send `firstFrame` (or nothing), collect frames until
 * `until(frame)` returns true or the socket closes. */
function session(port, firstFrame, until) {
  return new Promise((resolve, reject) => {
    const frames = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => { if (firstFrame) ws.send(JSON.stringify(firstFrame)) })
    ws.on('message', (data) => {
      const f = JSON.parse(data.toString())
      frames.push(f)
      if (until(f)) resolve({ frames, ws })
    })
    ws.on('close', () => resolve({ frames, ws }))
    ws.on('error', reject)
  })
}

const port = await freePort()
const userData = mkdtempSync(join(tmpdir(), 'pion-ws-test-'))
const child = spawn(process.execPath, [
  BUNDLE, '--user-data', userData,
  '--stay-resident', '--listen-ws', `127.0.0.1:${port}`, '--token', TOKEN,
], { stdio: ['ignore', 'ignore', 'ignore'] })

// Wait for the listener to bind (daemon.log line) — no stdout is exposed in
// resident mode, so poll the log file.
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    if (readFileSync(join(userData, 'daemon.log'), 'utf8').includes('ws listening')) break
  } catch { /* log not written yet */ }
}

try {
  // (a) wrong token → unauthorized + close 1003
  const a = await session(port, { type: 'hello', protocol: 'pion-daemon/3', token: 'wrong' }, () => false)
  const aErr = a.frames.find((f) => f.type === 'hello_error')
  check('a) wrong token → hello_error(unauthorized)', aErr?.error?.code === 'unauthorized', JSON.stringify(aErr?.error))

  // (b) wrong protocol → version_mismatch
  const b = await session(port, { type: 'hello', protocol: 'pion-daemon/1', token: TOKEN }, () => false)
  const bErr = b.frames.find((f) => f.type === 'hello_error')
  check('b) wrong protocol → hello_error(version_mismatch)', bErr?.error?.code === 'version_mismatch', JSON.stringify(bErr?.error))

  // (c) correct hello → hello_ok
  const c = await session(port, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN, clientId: 'ws-test' }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  const cOk = c.frames.find((f) => f.type === 'hello_ok')
  check('c) correct hello → hello_ok', cOk?.protocol === 'pion-daemon/3', JSON.stringify(cOk))

  // (d) ping → result ok (reusing the handshaken socket from c)
  const dRes = await new Promise((resolve) => {
    const id = 'ping-1'
    const ws = c.ws
    ws.on('message', (data) => { const f = JSON.parse(data.toString()); if (f.type === 'result' && f.id === id) resolve(f) })
    ws.send(JSON.stringify({ type: 'call', id, method: 'ping' }))
  })
  check('d) ping → result ok', dRes.ok === true && dRes.value?.pong === true, JSON.stringify(dRes).slice(0, 90))

  // (e) v3 multi-client: clients 2–4 attach, the 5th hits the cap
  const e = await session(port, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  check('e) second client attaches (v3 multi-client)', e.frames.some((f) => f.type === 'hello_ok'), JSON.stringify(e.frames[0]))
  const e3 = await session(port, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  const e4 = await session(port, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  const e5 = await session(port, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  const e5Err = e5.frames.find((f) => f.type === 'hello_error')
  check('e2) fifth client → hello_error(conflict) at cap 4',
    e3.frames.some((f) => f.type === 'hello_ok') && e4.frames.some((f) => f.type === 'hello_ok') && e5Err?.error?.code === 'conflict',
    JSON.stringify(e5Err?.error))

  // (f) daemon.shutdown from a listen carrier → unauthorized, process stays
  const fRes = await new Promise((resolve) => {
    const id = 'shutdown-1'
    c.ws.on('message', (data) => { const f = JSON.parse(data.toString()); if (f.type === 'result' && f.id === id) resolve(f) })
    c.ws.send(JSON.stringify({ type: 'call', id, method: 'daemon.shutdown' }))
  })
  const stillAlive = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(child.exitCode === null), 1500)
    child.on('exit', () => { clearTimeout(t); resolve(false) })
  })
  check('f) daemon.shutdown on listen carrier → unauthorized, process stays', fRes.ok === false && fRes.error?.code === 'unauthorized' && stillAlive, `result=${JSON.stringify(fRes.error)} alive=${stillAlive}`)
} finally {
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(userData, { recursive: true, force: true })
}

// ── TCP JSONL carrier(--listen):同一握手门,LF 分隔帧 ──
function tcpSession(port, hello) {
  return new Promise((resolve) => {
    const sock = new Socket()
    const frames = []
    let buffer = ''
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve({ frames, sock }) } }
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim()) frames.push(JSON.parse(line))
      }
    })
    sock.on('connect', () => sock.write(JSON.stringify(hello) + '\n'))
    sock.on('error', () => done())
    sock.on('close', () => done())
    setTimeout(done, 4000)
    sock.connect(port, '127.0.0.1')
  })
}

const tcpPort = await freePort()
const tcpUserData = mkdtempSync(join(tmpdir(), 'pion-tcp-test-'))
const tcpChild = spawn(process.execPath, [
  BUNDLE, '--user-data', tcpUserData,
  '--stay-resident', '--listen', `127.0.0.1:${tcpPort}`, '--token', TOKEN,
], { stdio: ['ignore', 'ignore', 'ignore'] })

try {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try { if (readFileSync(join(tcpUserData, 'daemon.log'), 'utf8').includes('tcp listening')) break } catch {}
  }

  // (a) wrong token
  const ta = await tcpSession(tcpPort, { type: 'hello', protocol: 'pion-daemon/3', token: 'wrong' })
  ta.sock.destroy()
  check('tcp a) wrong token → hello_error(unauthorized)', ta.frames[0]?.type === 'hello_error' && ta.frames[0]?.error?.code === 'unauthorized', JSON.stringify(ta.frames[0]).slice(0, 100))

  // (b) wrong protocol
  const tb = await tcpSession(tcpPort, { type: 'hello', protocol: 'pion-daemon/999', token: TOKEN })
  tb.sock.destroy()
  check('tcp b) wrong protocol → hello_error(version_mismatch)', tb.frames[0]?.error?.code === 'version_mismatch', JSON.stringify(tb.frames[0]).slice(0, 100))

  // (c) correct hello → hello_ok(单一行缓冲 data 处理器,后面所有检查复用)
  const tcSock = new Socket()
  const tcFrames = []
  let tcBuf = ''
  tcSock.on('data', (chunk) => {
    tcBuf += chunk.toString('utf8')
    let idx
    while ((idx = tcBuf.indexOf('\n')) >= 0) {
      const line = tcBuf.slice(0, idx)
      tcBuf = tcBuf.slice(idx + 1)
      if (line.trim()) tcFrames.push(JSON.parse(line))
    }
  })
  const waitFrame = async (pred, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const hit = tcFrames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tcp hello timeout')), 5000)
    tcSock.on('error', reject)
    tcSock.on('connect', () => tcSock.write(JSON.stringify({ type: 'hello', protocol: 'pion-daemon/3', token: TOKEN, clientId: 'ws-test' }) + '\n'))
    void waitFrame((f) => f.type === 'hello_ok').then((f) => { clearTimeout(t); f ? resolve(undefined) : reject(new Error('no hello_ok')) })
    tcSock.connect(tcpPort, '127.0.0.1')
  })
  check('tcp c) correct hello → hello_ok', tcFrames[0]?.type === 'hello_ok' && tcFrames[0]?.protocol === 'pion-daemon/3', JSON.stringify(tcFrames[0]).slice(0, 100))

  const tdRes = await (async () => {
    tcSock.write(JSON.stringify({ type: 'call', id: 'tcp-ping-1', method: 'ping' }) + '\n')
    return waitFrame((f) => f.type === 'result' && f.id === 'tcp-ping-1')
  })()
  check('tcp d) ping → result ok', tdRes?.ok === true && tdRes.value?.pong === true, JSON.stringify(tdRes).slice(0, 90))

  // (e) v3 multi-client: a second TCP client attaches
  const te = await tcpSession(tcpPort, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN })
  te.sock.destroy()
  check('tcp e) second client attaches (v3 multi-client)', te.frames[0]?.type === 'hello_ok', JSON.stringify(te.frames[0]).slice(0, 100))

  // (f) daemon.shutdown from a listen carrier → unauthorized, process stays
  const tfRes = await (async () => {
    tcSock.write(JSON.stringify({ type: 'call', id: 'tcp-shutdown-1', method: 'daemon.shutdown' }) + '\n')
    return waitFrame((f) => f.type === 'result' && f.id === 'tcp-shutdown-1')
  })()
  const tcpStillAlive = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(tcpChild.exitCode === null), 1500)
    tcpChild.on('exit', () => { clearTimeout(t); resolve(false) })
  })
  check('tcp f) daemon.shutdown on listen carrier → unauthorized, process stays',
    tfRes?.ok === false && tfRes?.error?.code === 'unauthorized' && tcpStillAlive,
    `result=${JSON.stringify(tfRes?.error)} alive=${tcpStillAlive}`)
} finally {
  if (tcpChild.exitCode === null) tcpChild.kill('SIGKILL')
  rmSync(tcpUserData, { recursive: true, force: true })
}

// ── dual-port default + daemon.info + owner-stdio (iOS connect path) ───────
// (g) a bare --listen derives a WS listener on port+1 (the case that bit real
// users: the desktop GUI connected over TCP while iOS had nothing to dial)
// (h) daemon.info reports the actual listeners (incl. derived/ephemeral ports)
// (i) --owner-stdio: spawn-pipe owner channel AND ws listener simultaneously
// (j) --no-listen-ws opts out; --listen-ws host:0 binds an ephemeral port
const dualPort = await freePort()
const dualUserData = mkdtempSync(join(tmpdir(), 'pion-dual-'))
const dualChild = spawn(process.execPath, [
  BUNDLE, '--user-data', dualUserData,
  '--stay-resident', '--listen', `127.0.0.1:${dualPort}`, '--token', TOKEN,
], { stdio: ['ignore', 'ignore', 'ignore'] })

try {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try { if (readFileSync(join(dualUserData, 'daemon.log'), 'utf8').includes('tcp listening')) break } catch {}
  }

  // g1 is a TCP JSONL probe (the bare --listen carrier) — a WebSocket client
  // dialing the JSONL port would stall forever by design, so raw socket here.
  const gTcp = await tcpSession(dualPort, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN })
  check('g1) bare --listen still serves TCP JSONL', gTcp.frames[0]?.type === 'hello_ok', JSON.stringify(gTcp.frames[0]))

  const gWs = await session(dualPort + 1, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  check('g2) derived WS listener on port+1 accepts the handshake (dual-port default)',
    gWs.frames.some((f) => f.type === 'hello_ok'), JSON.stringify(gWs.frames[0]))

  // (h) daemon.info over the handshaken WS: the derived port must be
  // observable — the desktop QR reads exactly this value
  const hRes = await new Promise((resolve) => {
    const id = 'info-1'
    gWs.ws.on('message', (data) => { const f = JSON.parse(data.toString()); if (f.type === 'result' && f.id === id) resolve(f) })
    gWs.ws.send(JSON.stringify({ type: 'call', id, method: 'daemon.info' }))
  })
  const wsListener = hRes.value?.listeners?.find((l) => l.kind === 'ws')
  check('h) daemon.info lists the derived ws listener with the actual port',
    hRes.ok === true && wsListener?.port === dualPort + 1 && typeof hRes.value?.protocolVersion === 'number',
    JSON.stringify(hRes.value?.listeners))

  // (i) owner-stdio: stdin stays the owner control channel alongside listeners
  const ownerPort = await freePort()
  const ownerUserData = mkdtempSync(join(tmpdir(), 'pion-owner-'))
  const ownerChild = spawn(process.execPath, [
    BUNDLE, '--user-data', ownerUserData,
    '--stay-resident', '--owner-stdio', '--listen-ws', `127.0.0.1:${ownerPort}`, '--token', TOKEN,
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  const iStdio = await new Promise((resolve) => {
    let out = ''
    const frames = []
    ownerChild.stdout.on('data', (c) => {
      out += c
      let idx
      while ((idx = out.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(out.slice(0, idx)))
        out = out.slice(idx + 1)
      }
      if (frames.length >= 2) resolve({ frames })
    })
    ownerChild.stdin.write(JSON.stringify({ type: 'call', id: 'o-ping', method: 'ping' }) + '\n')
    setTimeout(() => resolve({ frames }), 5000)
  })
  check('i1) --owner-stdio keeps the stdio owner channel (hello_ok + ping result)',
    iStdio.frames[0]?.type === 'hello_ok' && iStdio.frames[1]?.ok === true,
    JSON.stringify(iStdio.frames.map((f) => f.type)))
  const iWs = await session(ownerPort, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error')
  check('i2) ws peer attaches alongside the stdio owner (v3 multi-client)',
    iWs.frames.some((f) => f.type === 'hello_ok'), JSON.stringify(iWs.frames[0]))

  // (j1) --no-listen-ws opts out of the derivation entirely
  const noWsPort = await freePort()
  const noWsUserData = mkdtempSync(join(tmpdir(), 'pion-nows-'))
  const noWsChild = spawn(process.execPath, [
    BUNDLE, '--user-data', noWsUserData,
    '--stay-resident', '--listen', `127.0.0.1:${noWsPort}`, '--no-listen-ws', '--token', TOKEN,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try { if (readFileSync(join(noWsUserData, 'daemon.log'), 'utf8').includes('tcp listening')) break } catch {}
  }
  let noWsRefused = false
  try {
    const r = await session(noWsPort + 1, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, () => false)
    noWsRefused = r.frames.length === 0
  } catch {
    noWsRefused = true // connect error = nothing listening
  }
  check('j1) --no-listen-ws: no WS listener on port+1', noWsRefused, noWsRefused ? 'connect refused / no frames' : 'unexpected frames')

  // (j2) --listen-ws host:0 binds an ephemeral port; the log + daemon.info
  // carry the actual one
  const ephUserData = mkdtempSync(join(tmpdir(), 'pion-eph-'))
  const ephChild = spawn(process.execPath, [
    BUNDLE, '--user-data', ephUserData,
    '--stay-resident', '--listen-ws', '127.0.0.1:0', '--token', TOKEN,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  let ephPort = null
  for (let i = 0; i < 40 && !ephPort; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const m = readFileSync(join(ephUserData, 'daemon.log'), 'utf8').match(/ws listening on 127\.0\.0\.1:(\d+)/)
      if (m) ephPort = Number(m[1])
    } catch { /* log not written yet */ }
  }
  const ephWs = ephPort ? await session(ephPort, { type: 'hello', protocol: 'pion-daemon/3', token: TOKEN }, (f) => f.type === 'hello_ok' || f.type === 'hello_error') : { frames: [] }
  check('j2) --listen-ws port 0 binds an ephemeral port that handshakes',
    ephPort !== null && ephPort !== 0 && ephWs.frames.some((f) => f.type === 'hello_ok'),
    `ephemeral port=${ephPort}`)

  for (const c of [dualChild, ownerChild, noWsChild, ephChild]) {
    if (c.exitCode === null) c.kill('SIGKILL')
  }
  rmSync(dualUserData, { recursive: true, force: true })
  rmSync(ownerUserData, { recursive: true, force: true })
  rmSync(noWsUserData, { recursive: true, force: true })
  rmSync(ephUserData, { recursive: true, force: true })
} catch (err) {
  console.log(`FAIL dual-port section threw: ${err?.message ?? err}`)
  results.push(['dual-port section', false])
}

const failed = results.filter(([, ok]) => !ok)
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall ws+tcp carrier checks passed')
process.exit(failed.length ? 1 : 0)
