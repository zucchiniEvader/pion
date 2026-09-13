// Offline installer regression: downloads/npm are fixtures; PTY validation uses
// the real node-pty already installed in this checkout. No services are changed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'pion-terminal-install-'))
const bin = join(root, 'tools')
const assets = join(root, 'assets')
mkdirSync(bin)
mkdirSync(join(assets, 'resources'), { recursive: true })
const contents = { 'pion-daemon': '#!/bin/sh\nexit 0\n', 'resources/kanban-bridge.ts': '// fixture\n', 'resources/pion-commands.ts': '// fixture\n' }
const files = {}
for (const [name, body] of Object.entries(contents)) {
  writeFileSync(join(assets, name), body)
  files[name] = { sha256: createHash('sha256').update(body).digest('hex') }
}
writeFileSync(join(assets, 'manifest.json'), JSON.stringify({ version: '0.0.0', files }))
function tool(name, body) { writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + body, { mode: 0o755 }) }
tool('curl', `const fs=require('node:fs'); const args=process.argv.slice(2); fs.copyFileSync(process.env.FIXTURE_ASSETS+'/'+args.at(-1).replace('https://fixture/',''), args[args.indexOf('-o')+1]);`)
tool('npm', `const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n'); if(process.env.FIXTURE_FAIL==='1')process.exit(1); const prefix=args[args.indexOf('--prefix')+1]; fs.mkdirSync(path.join(prefix,'node_modules'),{recursive:true}); if(process.env.FIXTURE_BROKEN==='1'){fs.mkdirSync(path.join(prefix,'node_modules/node-pty'),{recursive:true});fs.writeFileSync(path.join(prefix,'node_modules/node-pty/index.js'),'throw new Error("incompatible native module")')}else{fs.symlinkSync(process.env.FIXTURE_PTY,path.join(prefix,'node_modules/node-pty'),'dir')}`)
try {
  for (const scenario of ['default', 'skip', 'install-failure', 'incompatible']) {
    const home = join(root, scenario, '.pion')
    const log = join(root, scenario + '.log')
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PION_HOME: home, PION_DL_BASE: 'https://fixture', PION_NO_SERVICE: '1', FIXTURE_ASSETS: assets, FIXTURE_LOG: log, FIXTURE_PTY: resolve('node_modules/node-pty'), FIXTURE_FAIL: scenario === 'install-failure' ? '1' : '0', FIXTURE_BROKEN: scenario === 'incompatible' ? '1' : '0' }
    delete env.PION_WITH_TERMINAL
    if (scenario === 'skip') env.PION_WITH_TERMINAL = '0'
    const result = spawnSync('/bin/sh', ['scripts/install.sh'], { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    if (scenario === 'skip') {
      assert.equal(existsSync(log), false)
      assert.match(result.stdout, /skipping integrated terminal/)
    } else {
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0], ['install', '--prefix', home, '--no-save', '--package-lock=false', '--no-fund', '--no-audit', 'node-pty@1.1.0'])
      assert.match(result.stdout, scenario === 'default' ? /node-pty verified/ : scenario === 'incompatible' ? /cannot start a terminal/ : /node-pty install failed/)
    }
    console.log(`PASS terminal installer: ${scenario}`)
  }
} finally { rmSync(root, { recursive: true, force: true }) }
