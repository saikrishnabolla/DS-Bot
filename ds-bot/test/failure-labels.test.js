import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { failureLabel, knownFailure } from '../src/client/diagnostics.js'

test('credential failures have short words, in both languages', () => {
  const labels = {
    MISSING_CREDENTIAL: 'The model has no API key',
    INVALID_CREDENTIAL: 'The API key is not in the right format',
  }
  for (const [code, label] of Object.entries(labels)) {
    assert.equal(failureLabel(code, 'llm-deepseek: no API key for provider route'), label)
    assert.ok(Object.hasOwn(DICTIONARY.zh, label), label)
  }
})

test('an unknown code has no short words, and its label falls back to the message', () => {
  assert.equal(knownFailure('SOMETHING_NEW'), undefined)
  assert.equal(knownFailure(undefined), undefined)
  assert.equal(knownFailure('toString'), undefined)
  assert.equal(failureLabel('SOMETHING_NEW', 'raw text'), 'raw text')
  assert.equal(failureLabel('SOMETHING_NEW', ''), 'SOMETHING_NEW')
})
