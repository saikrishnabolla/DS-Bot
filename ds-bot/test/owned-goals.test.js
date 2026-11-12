import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { OwnedContext } from '../src/engine/owned-context.js'

function modelsFixture() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

async function open(dataDir, models) {
  return OwnedContext.open({ dataDir, models, workspacePath: dataDir })
}

test('owned goals persist each session independently through restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-goals-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const { models } = modelsFixture()
  let context = await open(dataDir, models)
  const firstId = (await context.sessionController.create()).sessionId
  const secondId = (await context.sessionController.create()).sessionId
  const firstAgent = (await context.sessionController.resolveAgent(firstId)).agent
  const secondAgent = (await context.sessionController.resolveAgent(secondId)).agent
  const goals = context.get('goals')
  const first = goals.start(firstAgent, { objective: 'first objective', id: 'caller-owned-id', revision: 99, phase: 'complete' })
  const second = goals.start(secondAgent, { objective: 'second objective' })
  const blocked = goals.block(secondAgent, second, { code: 'waiting', message: 'need input' })
  assert.notEqual(first.id, 'caller-owned-id')
  assert.equal(first.revision, 1)
  assert.equal(first.phase, 'active')
  assert.deepEqual(goals.get(firstAgent), first)
  assert.deepEqual(goals.get(secondAgent), blocked)
  const edited = goals.edit(firstAgent, first, { objective: 'edited objective' })
  const paused = goals.pause(firstAgent, edited)
  const resumed = goals.resume(firstAgent, paused)
  assert.equal(edited.id, first.id)
  assert.equal(edited.objective, 'edited objective')
  assert.equal(paused.phase, 'paused')
  assert.equal(resumed.phase, 'active')
  assert.equal(goals.clear(firstAgent, resumed), true)
  assert.equal(goals.get(firstAgent), undefined)
  const recreated = goals.start(firstAgent, { objective: 'recreated objective' })
  await context.close()

  context = await open(dataDir, models)
  const restoredFirst = (await context.sessionController.resolveAgent(firstId)).agent
  const restoredSecond = (await context.sessionController.resolveAgent(secondId)).agent
  assert.deepEqual(context.get('goals').get(restoredFirst), recreated)
  assert.deepEqual(context.get('goals').get(restoredSecond), blocked)
  assert.equal(context.get('goals').block(restoredSecond, second, { code: 'stale', message: 'must not replace the restored goal' }), undefined)
  assert.deepEqual(context.get('goals').get(restoredSecond), blocked)
  const complete = context.get('goals').complete(restoredSecond, blocked)
  await context.close()

  context = await open(dataDir, models)
  t.after(() => context.close())
  assert.deepEqual(context.get('goals').get((await context.sessionController.resolveAgent(firstId)).agent), recreated)
  assert.deepEqual(context.get('goals').get((await context.sessionController.resolveAgent(secondId)).agent), complete)
})

test('owned goals do not leak between data directories with the same key', async t => {
  const firstDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-goals-first-'))
  const secondDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-goals-second-'))
  t.after(() => Promise.all([
    rm(firstDir, { recursive: true, force: true }),
    rm(secondDir, { recursive: true, force: true }),
  ]))
  const firstModels = modelsFixture().models
  const secondModels = modelsFixture().models
  const first = await open(firstDir, firstModels)
  const second = await open(secondDir, secondModels)
  t.after(() => Promise.all([first.close(), second.close()]))
  const key = 'shared-goal-key'
  const stored = first.get('goals').start(key, { objective: 'kept in first data directory' })

  assert.deepEqual(first.get('goals').get(key), stored)
  assert.equal(second.get('goals').get(key), undefined)
})
