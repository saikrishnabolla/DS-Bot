import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const fixture = new URL('./fixtures/owned-schedule-kill.mjs', import.meta.url)

const child = (mode, dataDir, sessionId) => fork(fixture, [mode, dataDir, ...(sessionId === undefined ? [] : [sessionId])], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})

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

test('owned schedule delivers once after SIGKILL past due and before delivery commit', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-schedule-kill-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const errors = []

  const first = child('prepare', dataDir)
  first.stderr.on('data', chunk => errors.push(String(chunk)))
  const due = await waitForMessage(first, 'due')
  first.kill('SIGKILL')
  assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })

  const second = child('recover', dataDir, due.sessionId)
  second.stderr.on('data', chunk => errors.push(String(chunk)))
  const recovered = await waitForMessage(second, 'recovered')
  assert.deepEqual(await waitForExit(second), { code: 0, signal: null }, errors.join(''))
  assert.deepEqual(recovered, {
    type: 'recovered',
    messages: 1,
    status: 'ended',
    deliveredSessionId: due.sessionId,
  })
})
