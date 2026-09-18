// Offline installer regression: the packaged install.sh is self-contained
// (payload + sha256s embedded), so no download fixtures are needed — only a
// fixture npm for the node-pty scenarios. PTY validation uses the real
// node-pty already installed in this checkout. No services are changed.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Package the real installer first (bundle + embedded payload + baked hashes).
const pkg = spawnSync(process.execPath, ['scripts/package-daemon.mjs'], { stdio: 'inherit' })
if (pkg.status !== 0) process.exit(pkg.status ?? 1)
const INSTALLER = resolve('release/daemon-cli/install.sh')

const root = mkdtempSync(join(tmpdir(), 'pion-terminal-install-'))
const bin = join(root, 'tools')
mkdirSync(bin)
function tool(name, body) { writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + body, { mode: 0o755 }) }
tool('npm', `const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n'); if(process.env.FIXTURE_FAIL==='1')process.exit(1); const prefix=args[args.indexOf('--prefix')+1]; fs.mkdirSync(path.join(prefix,'node_modules'),{recursive:true}); if(process.env.FIXTURE_BROKEN==='1'){fs.mkdirSync(path.join(prefix,'node_modules/node-pty'),{recursive:true});fs.writeFileSync(path.join(prefix,'node_modules/node-pty/index.js'),'throw new Error("incompatible native module")')}else{fs.symlinkSync(process.env.FIXTURE_PTY,path.join(prefix,'node_modules/node-pty'),'dir')}`)
try {
  for (const scenario of ['default', 'skip', 'install-failure', 'incompatible']) {
    const home = join(root, scenario, '.pion')
    const log = join(root, scenario + '.log')
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PION_HOME: home, PION_NO_SERVICE: '1', FIXTURE_LOG: log, FIXTURE_PTY: resolve('node_modules/node-pty'), FIXTURE_FAIL: scenario === 'install-failure' ? '1' : '0', FIXTURE_BROKEN: scenario === 'incompatible' ? '1' : '0' }
    delete env.PION_WITH_TERMINAL
    if (scenario === 'skip') env.PION_WITH_TERMINAL = '0'
    const result = spawnSync('/bin/sh', [INSTALLER], { env, encoding: 'utf8', timeout: 30000 })
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
    // Self-contained payload landed: the daemon runs, resources + uninstall in place.
    const daemon = join(home, 'bin', 'pion-daemon')
    assert.ok(existsSync(daemon), 'pion-daemon installed')
    assert.ok(existsSync(join(home, 'share', 'resources', 'kanban-bridge.ts')), 'kanban-bridge installed')
    assert.ok(existsSync(join(home, 'bin', 'uninstall.sh')), 'uninstall.sh installed')
    const ver = spawnSync(daemon, ['version'], { encoding: 'utf8' })
    assert.equal(ver.status, 0, ver.stdout + ver.stderr)
    console.log(`PASS terminal installer: ${scenario}`)
  }
  // Piped form (the actual curl | sh entry): stdin has no $0 — the heredoc
  // payload must survive being fed through a pipe.
  const home = join(root, 'piped', '.pion')
  const piped = spawnSync('/bin/sh', [], {
    input: readFileSync(INSTALLER, 'utf8'),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PION_HOME: home, PION_NO_SERVICE: '1', PION_WITH_TERMINAL: '0', FIXTURE_LOG: join(root, 'piped.log'), FIXTURE_PTY: resolve('node_modules/node-pty') },
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(piped.status, 0, piped.stdout + piped.stderr)
  assert.ok(existsSync(join(home, 'bin', 'pion-daemon')), 'piped install produced the daemon')
  console.log('PASS terminal installer: piped (curl | sh) form')
} finally { rmSync(root, { recursive: true, force: true }) }
chmodSync(INSTALLER, 0o755)
