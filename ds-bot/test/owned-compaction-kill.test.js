import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const fixture = new URL('./fixtures/owned-compaction-kill.mjs', import.meta.url)

function child(mode, dataDir, taskId) {
  return fork(fixture, [mode, dataDir, ...(taskId === undefined ? [] : [String(taskId)])], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
}

const waitForMessage = (process, type, timeout = 15_000) => new Promise((resolve, reject) => {
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

test('SIGKILL after the compaction memo resumes with one Cue checkpoint', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-compaction-kill-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const first = child('prepare', dataDir)
  const errors = []
  first.stderr.on('data', chunk => errors.push(String(chunk)))
  const taskMessage = waitForMessage(first, 'task')
  const memoMessage = waitForMessage(first, 'memo-stored')
  const task = await taskMessage
  await memoMessage
  first.kill('SIGKILL')
  assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })

  const second = child('recover', dataDir, task.taskId)
  second.stderr.on('data', chunk => errors.push(String(chunk)))
  const result = await waitForMessage(second, 'result')
  assert.deepEqual(await waitForExit(second), { code: 0, signal: null }, errors.join(''))
  assert.deepEqual(result, {
    type: 'result',
    checkpointCalls: 0,
    stewardCalls: 0,
    checkpointEntries: 1,
    checkpointMessages: 1,
  })
})
