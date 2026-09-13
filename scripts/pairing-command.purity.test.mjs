import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildPairingCommand } from '../node_modules/.tmp/pairingCommand.bundle.mjs'
const command = buildPairingCommand('192.168.1.2', 4970, 'pion-test')
assert.match(command, /npm install --prefix "\$HOME\/\.pion" .*node-pty@1\.1\.0/)
assert.match(command, /node "\$HOME\/\.pion\/bin\/pion-daemon.cjs"/)
assert.ok(command.indexOf('npm install') < command.indexOf(' && node '))
assert.match(command, /--connect '192.168.1.2:4970' --token 'pion-test'/)
// Parse the generated shell (including hostile quotes); never execute it.
for (const host of ['localhost', "host'; touch /tmp/pion-injected; '", '$(echo unsafe)']) {
  const result = spawnSync('/bin/sh', ['-n'], { input: buildPairingCommand(host, 4970, "pion-'test"), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
console.log('pairing command: dependency installation and shell quoting passed')
