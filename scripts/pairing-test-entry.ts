// Test entry for scripts/daemon-pairing-test.mjs (bundled ad hoc by esbuild).
// Drives PairingManager with a fake registry (electron-free) against the REAL
// daemon bundle dialing in with --connect (R3-1).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { PairingManager } from '../electron/main/pairing'

const DAEMON_BUNDLE = process.env.DAEMON_BUNDLE!
const results: Array<[string, boolean, string]> = []
let failures = 0
const check = (id: string, ok: boolean, ev: string) => {
  results.push([id, ok, ev])
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${id}: ${ev}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeRegistry {
  runtimes = new Map<string, { sock: Socket; remoteAddr: string }>()
  tokenToId = new Map<string, string>()
  idSeq = 0
  states: Array<[string, boolean]> = []
  runtimeIdByToken = (token: string) => this.tokenToId.get(token)
  attachDialIn = (id: string, sock: Socket, remoteAddr: string) => {
    const existing = this.runtimes.get(id)
    existing?.sock.destroy()
    this.runtimes.set(id, { sock, remoteAddr })
    this.states.push([id, true])
  }
  pairInNew = (token: string, sock: Socket, remoteAddr: string) => {
    this.idSeq += 1
    const id = `remote-fake-${this.idSeq}`
    this.runtimes.set(id, { sock, remoteAddr })
    this.tokenToId.set(token, id)
    this.states.push([id, true])
  }
  notifyState = (id: string, connected: boolean) => this.states.push([id, connected])
}

const pickPort = async (): Promise<number> => {
  const { createServer } = await import('node:net')
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  await new Promise((r) => srv.close(() => r(undefined)))
  return port
}

/** Sends a call frame and waits for the result over the accepted socket. */
const pingOver = (sock: Socket): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      sock.off('data', onData)
      try {
        resolve(JSON.parse(buf.slice(0, idx)))
      } catch (e) {
        reject(e)
      }
    }
    sock.on('data', onData)
    sock.write(JSON.stringify({ type: 'call', id: 't-ping', method: 'ping' }) + '\n')
    setTimeout(() => reject(new Error('ping timeout')), 5000).unref()
  })

const dialDaemon = (port: number, token: string): ChildProcess => {
  const ud = mkdtempSync(join(tmpdir(), 'pion-pair-ud-'))
  return spawn(process.execPath, [DAEMON_BUNDLE, '--user-data', ud, '--stay-resident', '--connect', `127.0.0.1:${port}`, '--token', token], {
    stdio: 'ignore',
  })
}

const kill = (child: ChildProcess) => new Promise<void>((r) => { child.once('exit', () => r()); child.kill('SIGKILL'); setTimeout(r, 1500).unref() })

async function main(): Promise<void> {
  const registry = new FakeRegistry()
  const pm = new PairingManager(registry)

  // a) pairing dial-in → pairInNew + accepted channel answers calls
  const portA = await pickPort()
  await pm.startListener(portA)
  const pairA = pm.startPairing()
  const d1 = dialDaemon(portA, pairA.token)
  let sockA: Socket | undefined
  for (let i = 0; i < 40 && !sockA; i++) {
    await sleep(250)
    sockA = registry.runtimes.get('remote-fake-1')?.sock
  }
  check('a1-pair-accept', !!sockA, `pairInNew fired, runtime created=${!!sockA}`)
  check('a2-pair-token-destroyed', !pm.pairingActive, 'pairing token destroyed after pairing')
  const pong = sockA ? await pingOver(sockA).catch((e) => ({ err: String(e) })) : { err: 'no socket' }
  check('a3-accepted-channel-calls', (pong as { type?: string; ok?: boolean })?.type === 'result' && (pong as { ok?: boolean }).ok === true, `ping over accepted socket: ${JSON.stringify(pong).slice(0, 80)}`)

  // b) kill daemon → redial with same token → attachDialIn SAME runtime id
  await kill(d1)
  await sleep(1000)
  const d2 = dialDaemon(portA, pairA.token)
  let reattached = false
  for (let i = 0; i < 40 && !reattached; i++) {
    await sleep(250)
    const rt = registry.runtimes.get('remote-fake-1')
    if (rt && rt.sock !== sockA && !rt.sock.destroyed) {
      reattached = true
      break
    }
  }
  check('b-redial-same-runtime', reattached, `redial re-attached to remote-fake-1 (no new runtime, total=${registry.idSeq})`)

  // c) wrong token dial → closed, nothing paired
  const before = registry.idSeq
  const d3 = dialDaemon(portA, 'PION-PAIR-999999')
  await sleep(3000)
  const d3Alive = d3.exitCode === null && d3.signalCode === null
  check('c-wrong-token-rejected', registry.idSeq === before && registry.runtimes.size === 1, `no pairing on wrong token (runtimes=${registry.runtimes.size}); daemon keeps redialing=${d3Alive}`)
  await kill(d3)

  // d) cancel: fresh pairing then cancel → dial with the canceled token rejected
  const pairD = pm.startPairing()
  pm.cancelPairing()
  const d4 = dialDaemon(portA, pairD.token)
  await sleep(2500)
  check('d-cancel-invalidates', registry.idSeq === before, `canceled pairing token rejected (runtimes=${registry.runtimes.size})`)
  await kill(d4)

  // e) expiry: short-TTL pairing manager
  const registry2 = new FakeRegistry()
  const pm2 = new PairingManager(registry2, { ttlMs: 1200 })
  const portE = await pickPort()
  await pm2.startListener(portE)
  const pairE = pm2.startPairing()
  await sleep(1800)
  const d5 = dialDaemon(portE, pairE.token)
  await sleep(2500)
  check('e-expiry', registry2.idSeq === 0, `expired pairing token rejected (paired=${registry2.idSeq})`)
  await kill(d5)
  await kill(d2)

  pm.close()
  pm2.close()
  console.log(failures === 0 ? 'all pairing checks passed' : `${failures} pairing checks FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
