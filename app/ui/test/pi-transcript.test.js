import assert from 'node:assert/strict'
import test from 'node:test'
import { transcriptSegments } from '../src/pi-transcript.js'

test('Pi reasoning and tool results keep their place in the transcript', () => {
  assert.deepEqual(transcriptSegments([
    { kind: 'user', text: 'Check it' },
    { kind: 'reasoning', entryId: 'e1', block: 1, text: 'I should inspect the file.' },
    { kind: 'tool-call', entryId: 'e1', block: 2, callId: 'c1', name: 'read_file', arguments: { path: 'a.txt' } },
    { kind: 'tool-result', callId: 'c1', name: 'read_file', text: 'hello', isError: false },
    { kind: 'bot', text: 'Done' },
  ]), [
    { kind: 'chat', items: [{ kind: 'user', text: 'Check it' }] },
    { kind: 'reasoning', entryId: 'e1', block: 1, text: 'I should inspect the file.', redacted: false },
    { kind: 'tool', entryId: 'e1', block: 2, callId: 'c1', name: 'read_file', arguments: { path: 'a.txt' }, error: undefined, result: 'hello', content: [{ type: 'text', text: 'hello' }], isError: false, details: undefined },
    { kind: 'chat', items: [{ kind: 'bot', text: 'Done' }] },
  ])
})

test('orphan results and failures remain visible', () => {
  assert.deepEqual(transcriptSegments([
    { kind: 'tool-result', entryId: 'e2', block: 1, callId: 'c2', name: 'shell', text: 'failed', isError: true },
    { kind: 'failure', entryId: 'e2', block: 2, turn: 7, reason: 'error', code: 'RATE_LIMIT', detail: 'Model request failed' },
    { kind: 'approval', id: 'a1' },
  ]), [
    { kind: 'tool', entryId: 'e2', block: 1, callId: 'c2', name: 'shell', result: 'failed', content: [{ type: 'text', text: 'failed' }], isError: true, details: undefined },
    { kind: 'failure', entryId: 'e2', block: 2, turn: 7, reason: 'error', code: 'RATE_LIMIT', detail: 'Model request failed' },
    { kind: 'chat', items: [{ kind: 'approval', id: 'a1' }] },
  ])
})

test('tool results keep rich content for the original tool cells', () => {
  const attachment = { type: 'image', attachment: { attachmentId: 'sha256:abc' } }
  assert.deepEqual(transcriptSegments([
    { kind: 'tool-call', callId: 'c1', name: 'cua_driver_native__screenshot', arguments: {} },
    { kind: 'tool-result', callId: 'c1', name: 'cua_driver_native__screenshot', text: 'captured', attachments: [attachment], isError: false },
  ]), [{
    kind: 'tool',
    entryId: undefined,
    block: undefined,
    callId: 'c1',
    name: 'cua_driver_native__screenshot',
    arguments: {},
    error: undefined,
    result: 'captured',
    content: [{ type: 'text', text: 'captured' }, attachment],
    isError: false,
    details: undefined,
  }])
})
