// Dial-home wire test (④ R3-1): verifies the daemon's --connect mode against
// a fake local pairing listener. Exit 0 only if every check passes.
//
//   a. dial-in: daemon connects → hello (correct token/protocol) → hello_ok →
//      listener sends `call ping` → daemon answers with a result frame (pong);
//   b. re-dial on drop: listener destroys the socket → a second hello arrives;
//   c. rejected handshake: hello_error(unauthorized) → daemon closes and
//      re-dials (another hello arrives);
//   d. listener down at boot: daemon keeps re-dialing without exiting; when
//      the listener comes up later the hello arrives;
//   e. arg validation: --connect+--listen fails, --connect without --token fails.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUNDLE = new URL('../out/daemon/index.cjs', import.meta.url).pathname
const TOKEN = 'dial-test-token'
const PROTOCOL = 'pion-daemon/3'
const results = []
const verdict = (id, ok, ev) => {
  results.push([id, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${ev}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const daemons = []
const tmpDirs = []
const listeners = []

function startDaemon(port) {
  const userData = mkdtempSync(join(tmpdir(), 'pion-dial-'))
  tmpDirs.push(userData)
  const d = spawn('node', [BUNDLE, '--user-data', userData, '--connect', `127.0.0.1:${port}`, '--token', TOKEN], { stdio: ['ignore', 'ignore', 'pipe'] })
  d.stderr?.on('data', (c) => console.log(`[daemon:stderr] ${String(c).trim()}`))
  daemons.push(d)
  return d
}

/** Fake pairing listener: records every daemon→listener frame; validates the
 * hello; answers per `helloAction`; answers call frames with ok results. */
async function startFakeListener() {
  const state = {
    server: null,
    port: 0,
    frames: [],
    hellos: [],
    helloAction: 'accept',
    sendCall: (id, method) => state.sock?.write(JSON.stringify({ type: 'call', id, method }) + '\n'),
    killSocket: () => state.sock?.destroy(),
    sock: null,
  }
  const server = createServer((socket) => {
    state.sock = socket
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        state.frames.push(frame)
        if (frame.type === 'hello') {
          state.hellos.push(frame)
          if (state.helloAction === 'reject') {
            socket.write(JSON.stringify({ type: 'hello_error', error: { code: 'unauthorized', message: 'bad token' } }) + '\n')
            socket.end()
          } else {
            socket.write(JSON.stringify({ type: 'hello_ok', protocol: PROTOCOL, daemonVersion: '0.1.0', lastSeq: 0 }) + '\n')
          }
          continue
        }
        if (frame.type === 'call') {
          socket.write(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: { pong: true, pid: 0, uptimeMs: 0 } }) + '\n')
        }
      }
    })
  })
  await new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res())
  })
  listeners.push(server)
  state.server = server
  state.port = server.address().port
  return state
}

async function waitFor(pred, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(150)
  }
  console.log(`  (waitFor timeout: ${label})`)
  return false
}

async function main() {
  // e. arg validation
  const bad1 = spawnSync('node', [BUNDLE, '--user-data', '/tmp/x', '--connect', '127.0.0.1:1', '--listen', '127.0.0.1:1', '--token', 't'], { stdio: 'pipe' })
  verdict('e1. --connect+--listen 互斥', bad1.status === 1 && String(bad1.stderr).includes('cannot be combined'), `exit=${bad1.status}`)
  const bad2 = spawnSync('node', [BUNDLE, '--user-data', '/tmp/x', '--connect', '127.0.0.1:1'], { stdio: 'pipe' })
  verdict('e2. --connect 缺 token 失败', bad2.status === 1 && String(bad2.stderr).includes('requires --token'), `exit=${bad2.status}`)

  // a. dial-in → hello → hello_ok → call ping → result
  const fl = await startFakeListener()
  const d1 = startDaemon(fl.port)
  const gotHello = await waitFor(() => fl.hellos.length >= 1, 8000, 'first hello')
  const hello = fl.hellos[0]
  verdict(
    'a1. daemon 拨入,hello 正确',
    gotHello && hello?.token === TOKEN && hello?.protocol === PROTOCOL && hello?.clientId === 'pion-daemon-dial',
    `hello=${JSON.stringify(hello)}`,
  )
  fl.sendCall('call-1', 'ping')
  const gotResult = await waitFor(() => fl.frames.some((f) => f.type === 'result' && f.id === 'call-1'), 8000, 'ping result')
  const resultFrame = fl.frames.find((f) => f.type === 'result' && f.id === 'call-1')
  verdict('a2. call ping 收到 result(pong)', gotResult && resultFrame?.value?.pong === true, `result=${JSON.stringify(resultFrame)}`)

  // b. drop the socket → daemon re-dials (second hello on the same listener)
  fl.killSocket()
  const redialed = await waitFor(() => fl.hellos.length >= 2, 12000, 'second hello after drop')
  verdict('b. 断线自动重拨', redialed, `hellos=${fl.hellos.length}`)

  // c. reject handshake → daemon closes and re-dials (third hello)
  fl.helloAction = 'reject'
  fl.killSocket()
  const afterReject = await waitFor(() => fl.hellos.length >= 3, 12000, 'hello after hello_error')
  verdict('c. hello_error 后关闭并重拨', afterReject, `hellos=${fl.hellos.length}`)
  d1.kill('SIGTERM')
  await fl.server.close()
  await sleep(400)

  // d. listener down at boot: daemon keeps re-dialing (does not exit); when a
  // listener comes up later the hello arrives.
  const down = startDaemon(1) // port 1: unreachable
  await sleep(2600)
  const aliveWhileDown = down.exitCode === null
  const fl3 = await startFakeListener()
  down.kill('SIGTERM')
  await sleep(300)
  startDaemon(fl3.port)
  const arrives = await waitFor(() => fl3.hellos.length >= 1, 8000, 'hello on fresh listener')
  verdict('d. 不可达时持续重拨不退出,监听器起后到达', aliveWhileDown && arrives, `alive=${aliveWhileDown} hellos=${fl3.hellos.length}`)
}

await main().catch((e) => {
  console.log('FATAL:', e)
  results.push(['fatal', false])
})
for (const d of daemons) d.kill('SIGTERM')
for (const l of listeners) l.close()
for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok)
console.log(failed.length === 0 ? '\nall dial-home checks passed' : `\n${failed.length} check(s) failed`)
process.exit(failed.length === 0 ? 0 : 1)
