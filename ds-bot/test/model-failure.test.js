import assert from 'node:assert/strict'
import test from 'node:test'
import { modelFailure } from '../src/engine/model-failure.js'

test('a provider error whose message starts with an HTTP status keeps its auth code and status', () => {
  const failure = modelFailure(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid key"}}'))
  assert.deepEqual(failure, {
    code: 'AUTH',
    status: 401,
    message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid key"}}',
  })
})
