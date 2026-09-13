// Isolated daemon bundle: missing dependency, then installed native PTY.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const root = mkdtempSync(join(tmpdir(), 'pion-terminal-wire-'))
const bundle = join(root, 'bin', 'pion-daemon.cjs')
const data = join(root, 'data')
mkdirSync(join(root, 'bin'))
mkdirSync(data)
copyFileSync('out/daemon/index.cjs', bundle)
writeFileSync(join(data, 'projects.json'), JSON.stringify([{ id: 'terminal-test', path: root, name: 'terminal-test' }]))
async function run(available) {
  const child = spawn(process.execPath, [bundle, '--user-data', data], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
  const frames = []
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => frames.push(JSON.parse(line)))
  const wait = async (predicate) => {
    const deadline = Date.now() + 10000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`terminal timeout: ${stderr}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  let id = 0
  async function call(method, params = {}) {
    const requestId = String(++id)
    child.stdin.write(JSON.stringify({ type: 'call', id: requestId, method, params }) + '\n')
    await wait(() => frames.some((f) => f.type === 'result' && f.id === requestId))
    return frames.find((f) => f.type === 'result' && f.id === requestId)
  }
  try {
    await wait(() => frames.some((f) => f.type === 'hello_ok'))
    const attach = await call('terminal.attach', { projectPath: root })
    assert.equal(attach.ok, available, JSON.stringify(attach))
    if (!available) {
      assert.equal(attach.error.message, 'err.terminal.unavailable')
      assert.equal((await call('ping')).ok, true)
      assert.match(readFileSync(join(data, 'daemon.log'), 'utf8'), /Cannot load node-pty/)
      console.log('PASS daemon terminal: missing dependency gives error; daemon stays usable')
    } else {
      assert.equal((await call('terminal.resize', { projectPath: root, cols: 90, rows: 24 })).ok, true)
      assert.equal((await call('terminal.input', { projectPath: root, data: "printf 'pion-%s\\n' terminal-ready\r" })).ok, true)
      await wait(() => JSON.stringify(frames).includes('pion-terminal-ready'))
      const replay = await call('terminal.attach', { projectPath: root })
      assert.match(replay.value.buffer, /pion-terminal-ready/)
      assert.equal((await call('terminal.kill', { projectPath: root })).ok, true)
      console.log('PASS daemon terminal: attach, resize, shell input/output, replay, kill')
    }
  } finally {
    const stopped = new Promise((r) => child.once('exit', r))
    child.kill('SIGTERM')
    await stopped
    lines.close()
  }
}
try {
  await run(false)
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(resolve('node_modules/node-pty'), join(root, 'node_modules/node-pty'), 'dir')
  await run(true)
} finally { rmSync(root, { recursive: true, force: true }) }
