import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const fixture = new URL('./fixtures/owned-approval-kill.mjs', import.meta.url)

function child(mode, dataDir, botId, approvalId) {
  return fork(fixture, [mode, dataDir, ...(botId === undefined ? [] : [botId]), ...(approvalId === undefined ? [] : [approvalId])], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

const waitForMessage = (process, type, timeout = 20_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for child message ${type}`)), timeout)
  const onMessage = message => {
    if (message?.type !== type) return
    clearTimeout(timer)
    process.off('message', onMessage)
    resolve(message)
  }
  process.on('message', onMessage)
  process.once('error', reject)
})

const waitForExit = process => new Promise((resolve, reject) => {
  process.once('error', reject)
  process.once('exit', (code, signal) => resolve({ code, signal }))
})

test('owned approval survives SIGKILL and closes interrupted work without executing it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-approval-kill-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const errors = []

  const first = child('prepare', dataDir)
  first.stderr.on('data', chunk => errors.push(String(chunk)))
  const pending = await waitForMessage(first, 'pending')
  assert.equal(pending.sideEffect, false)
  first.kill('SIGKILL')
  assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })

  const second = child('recover', dataDir, pending.botId, pending.approvalId)
  second.stderr.on('data', chunk => errors.push(String(chunk)))
  const recovered = await waitForMessage(second, 'recovered')
  assert.deepEqual(recovered, {
    type: 'recovered',
    approvalId: pending.approvalId,
    answerable: true,
    sideEffectBeforeAnswer: false,
  })
  const resolved = await waitForMessage(second, 'resolved')
  assert.deepEqual(await waitForExit(second), { code: 0, signal: null }, errors.join(''))
  assert.deepEqual(resolved, {
    type: 'resolved',
    sideEffectAfterAnswer: false,
    approvals: 0,
    secondAnswer: 'bot/stale',
  })
})

test('owned Host never replays an approved unsafe tool killed during execution', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-approved-kill-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const errors = []

  const first = child('execute', dataDir)
  first.stderr.on('data', chunk => errors.push(String(chunk)))
  const executed = await waitForMessage(first, 'executed')
  assert.equal(executed.content, 'x')
  assert.equal(executed.secondAnswer, 'bot/stale')
  first.kill('SIGKILL')
  assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })

  const second = child('verify', dataDir, executed.botId, executed.approvalId)
  second.stderr.on('data', chunk => errors.push(String(chunk)))
  const verified = await waitForMessage(second, 'verified')
  assert.deepEqual(await waitForExit(second), { code: 0, signal: null }, errors.join(''))
  assert.deepEqual(verified, {
    type: 'verified',
    content: 'x',
    approvals: 0,
    secondAnswer: 'bot/stale',
  })
})
