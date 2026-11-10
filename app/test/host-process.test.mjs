import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as host from '../src/host-process.mjs'

test('the Host uses the app executable in Node mode on every platform', () => {
  assert.equal(host.hostExecutable(), process.execPath)
})

// The engine's own report of a failed start is on the Host's stderr; the
// error box gets its tail with the message (#516).
test('withLogTail attaches the stderr tail so the real cause reaches the box', () => {
  const stderr = 'host: warning: session database could not open\n'
    + '  Error: database disk image is malformed at /data/runtime.sqlite\n'
  const message = host.withLogTail('The owned Host could not start', stderr)
  assert.match(message, /^The owned Host could not start/)
  assert.match(message, /database disk image is malformed/)
})

test('withLogTail redacts launch tokens and skips an empty tail', () => {
  assert.equal(
    host.withLogTail('The Cue Host stopped (exit 1)', 'launch http://127.0.0.1:43117/?token=abc123 other'),
    'The Cue Host stopped (exit 1):\nlaunch http://127.0.0.1:43117/?token=<hidden> other')
  assert.equal(host.withLogTail('The Cue Host stopped (exit 0)', '   \n'), 'The Cue Host stopped (exit 0)')
})
