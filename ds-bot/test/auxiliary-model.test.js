import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleAuxiliaryModel } from '../src/engine/auxiliary-model.js'

const policy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 }
const stop = { type: 'done', reason: 'stop', message: { stopReason: 'stop' } }

test('auxiliary model calls retry transient failures and discard partial output', async () => {
  let calls = 0
  const ctx = { llm: { async *stream() {
    calls += 1
    if (calls === 1) {
      yield { type: 'text-delta', text: 'discard me' }
      yield { type: 'error', reason: 'error', error: { failure: { code: 'TRANSPORT', message: 'network error' } } }
      return
    }
    yield { type: 'text-delta', text: 'kept' }
    yield stop
  } } }

  const assembler = await assembleAuxiliaryModel(ctx, {}, { policy, waitForRetry: async () => true })

  assert.equal(calls, 2)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'kept' }])
  assert.equal(assembler.finish.kind, 'stop')
})

test('auxiliary model calls do not retry permanent failures', async () => {
  let calls = 0
  const ctx = { llm: { async *stream() {
    calls += 1
    yield { type: 'error', reason: 'error', error: { failure: { code: 'AUTH', message: 'bad key' } } }
  } } }

  const assembler = await assembleAuxiliaryModel(ctx, {}, { policy, waitForRetry: async () => true })

  assert.equal(calls, 1)
  assert.equal(assembler.finish.kind, 'error')
})

test('auxiliary model disposal aborts an active Pi stream', async () => {
  const lifetime = new AbortController()
  let seenSignal
  const ctx = { llm: { async *stream(options) {
    seenSignal = options.signal
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'error', reason: 'aborted', error: { failure: { code: 'ABORTED', message: 'Stopped' } } }
  } } }

  const pending = assembleAuxiliaryModel(ctx, {}, { signal: lifetime.signal, policy })
  await Promise.resolve()
  lifetime.abort()
  const assembler = await pending

  assert.equal(seenSignal.aborted, true)
  assert.equal(assembler.finish.kind, 'aborted')
})
