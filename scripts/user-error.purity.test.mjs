import assert from 'node:assert/strict'
import { parseUserError } from '../node_modules/.tmp/userError.bundle.mjs'
for (const prefix of ['', 'Error: ', "Error invoking remote method 'terminal:attach': Error: ", "Error occurred in handler for 'terminal:attach': Error: "]) {
  const raw = prefix + 'err.terminal.unavailable'
  assert.deepEqual(parseUserError(new Error(raw)), { raw, code: 'err.terminal.unavailable', payload: undefined })
}
assert.deepEqual(parseUserError("Error invoking remote method 'git:createWorktree': Error: err.git.invalidBranchName:foo:bar"), {
  raw: "Error invoking remote method 'git:createWorktree': Error: err.git.invalidBranchName:foo:bar",
  code: 'err.git.invalidBranchName', payload: 'foo:bar',
})
assert.equal(parseUserError('Something mentioned err.terminal.unavailable').code, 'Something mentioned err.terminal.unavailable')
assert.equal(parseUserError(new Error('Connection lost')).raw, 'Connection lost')
console.log('user error IPC wrappers: all ok')
