import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiContract } from '../scripts/api-contract.mjs'

test('every client API operation has an owned Host handler', async () => {
  const result = await apiContract()
  assert.deepEqual(result.unresolved, [])
  assert.deepEqual(result.missing, [])
})
