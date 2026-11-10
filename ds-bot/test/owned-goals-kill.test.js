import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const fixture = new URL('./fixtures/owned-goals-kill.mjs', import.meta.url)

const child = (mode, dataDir, sessionId) => fork(fixture, [mode, dataDir, ...(sessionId === undefined ? [] : [sessionId])], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})

const waitForMessage = (process, type, timeout = 20_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for owned goal crash fixture ${type}`)), timeout)
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

async function kill(process) {
  process.kill('SIGKILL')
  assert.deepEqual(await waitForExit(process), { code: null, signal: 'SIGKILL' })
}

test('owned goals preserve active, blocked and complete state across SIGKILL', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-goal-kill-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const errors = []

  const first = child('active', dataDir)
  first.stderr.on('data', chunk => errors.push(String(chunk)))
  const active = await waitForMessage(first, 'active')
  assert.equal(active.goal.phase, 'active')
  assert.equal(active.goal.revision, 1)
  await kill(first)

  const second = child('blocked', dataDir, active.sessionId)
  second.stderr.on('data', chunk => errors.push(String(chunk)))
  const blocked = await waitForMessage(second, 'blocked')
  assert.deepEqual(blocked.before, active.goal)
  assert.equal(blocked.after.phase, 'blocked')
  assert.equal(blocked.after.revision, 2)
  assert.equal(blocked.after.error.code, 'waiting')
  await kill(second)

  const third = child('complete', dataDir, active.sessionId)
  third.stderr.on('data', chunk => errors.push(String(chunk)))
  const complete = await waitForMessage(third, 'complete')
  assert.deepEqual(complete.before, blocked.after)
  assert.equal(complete.after.phase, 'complete')
  assert.equal(complete.after.revision, 3)
  await kill(third)

  const fourth = child('verify', dataDir, active.sessionId)
  fourth.stderr.on('data', chunk => errors.push(String(chunk)))
  const verified = await waitForMessage(fourth, 'verified')
  assert.deepEqual(verified.goal, complete.after)
  assert.deepEqual(await waitForExit(fourth), { code: 0, signal: null }, errors.join(''))
})
