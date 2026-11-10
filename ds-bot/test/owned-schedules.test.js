import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRuntime } from '../index.js'
import { OwnedContext } from '../src/engine/owned-context.js'
import { installOwnedSchedules } from '../src/engine/owned-schedules.js'

const waitFor = async (check, timeout = 5_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for an owned schedule')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture(t, options = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'ds-bot-owned-schedules-'))
  if (options.dataDir === undefined) t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = options.models ?? createModels()
  const provider = options.provider ?? fauxProvider()
  if (options.models === undefined) models.setProvider(provider.provider)
  const context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  const schedules = await installOwnedSchedules(context)
  return { context, schedules, dataDir, models, provider }
}

async function target(context) {
  const { sessionId } = await context.sessionController.create()
  await context.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  return sessionId
}

const dueMessages = async (context, sessionId) => {
  const page = await context.sessionController.page({ sessionId, maxMessages: 100 })
  return page.records.filter(record => record.event.type === 'user/message' && record.event.data.source?.kind === 'schedule')
}

test('owned schedules validate timing and expose the host-wide schedule contract', async t => {
  const { context, schedules, dataDir } = await fixture(t)
  t.after(() => context.close())
  const runtime = createRuntime(context, { home: join(dataDir, 'bot'), github: false, diagnosticsFile: false, browser: false, computer: false })
  assert.deepEqual((await runtime.handle('schedules', {})).value, { available: true, tasks: [] })
  const sessionId = await target(context)

  const created = await schedules.create({
    title: 'Standup',
    prompt: 'Share progress',
    timing: { kind: 'weekly', weekly: { time: '09:30:00', time_zone: 'UTC', weekdays: [1, 5] } },
    target: { kind: 'session', sessionId },
  })
  const [record] = await schedules.catalog()
  assert.equal(record.id, created.id)
  assert.equal(record.kind, 'weekly')
  assert.equal(record.title, 'Standup')
  assert.equal(record.prompt, 'Share progress')
  assert.equal(record.status, 'active')
  assert.deepEqual(record.target, { kind: 'session', sessionId })
  assert.deepEqual(record.weekdays, [1, 5])
  assert.equal(record.time, '09:30:00')
  assert.equal(record.timeZone, 'UTC')
  assert.ok(Date.parse(record.scheduledAt) > Date.now())
  const tasks = await context.harness.scanTasks({ kind: 'ds-bot.schedule' }, 10)
  assert.equal(tasks.items.length, 1)
  assert.equal(tasks.items[0].state.status, 'pending')

  await assert.rejects(schedules.create({ title: 'Past', prompt: 'x', timing: { kind: 'at', at: '2000-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId } }), /future/i)
  await assert.rejects(schedules.create({ title: 'Fast', prompt: 'x', timing: { kind: 'every', every_seconds: 0 }, target: { kind: 'session', sessionId } }), /interval/i)
  await assert.rejects(schedules.create({ title: 'Bad time', prompt: 'x', timing: { kind: 'daily', daily: { time: '9am', time_zone: 'UTC' } }, target: { kind: 'session', sessionId } }), /schedule time/i)
  await assert.rejects(schedules.create({ title: 'Bad zone', prompt: 'x', timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Mars/Olympus' } }, target: { kind: 'session', sessionId } }), /time zone/i)
  await assert.rejects(schedules.create({ title: 'No day', prompt: 'x', timing: { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [] } }, target: { kind: 'session', sessionId } }), /weekday/i)

  const movedTo = await target(context)
  await schedules.edit({ id: created.id, action: 'update', patch: { target: { kind: 'session', sessionId: movedTo } } })
  assert.deepEqual((await schedules.catalog())[0].target, { kind: 'session', sessionId: movedTo })
  await schedules.edit({ id: created.id, action: 'delete' })
  assert.deepEqual(await schedules.catalog(), [])
})

test('owned repeating schedules deliver until deleted', async t => {
  const { context, schedules, provider } = await fixture(t)
  t.after(() => context.close())
  const sessionId = await target(context)
  provider.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('Scheduled response.')))
  await schedules.create({
    title: 'Pulse',
    prompt: 'Check now',
    timing: { kind: 'every', every_seconds: 1 },
    target: { kind: 'session', sessionId },
  })
  context.resume()

  await waitFor(async () => (await dueMessages(context, sessionId)).length >= 2, 4_000)
  const [record] = await schedules.catalog()
  await schedules.edit({ id: record.id, action: 'delete' })
  const count = (await dueMessages(context, sessionId)).length
  await new Promise(resolve => setTimeout(resolve, 1_200))
  assert.equal((await dueMessages(context, sessionId)).length, count)
})

test('owned one-shot schedules cross a stopped-host due time and deliver once after restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-schedule-restart-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()
  const provider = fauxProvider()
  provider.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('Scheduled once.')))
  models.setProvider(provider.provider)

  const first = await fixture(t, { dataDir, models, provider })
  const sessionId = await target(first.context)
  await first.schedules.create({
    title: 'Restart reminder',
    prompt: 'Run after restart',
    timing: { kind: 'at', at: new Date(Date.now() + 200).toISOString() },
    target: { kind: 'session', sessionId },
  })
  first.context.resume()
  await new Promise(resolve => setTimeout(resolve, 30))
  await first.context.close()
  await new Promise(resolve => setTimeout(resolve, 220))

  const second = await fixture(t, { dataDir, models, provider })
  second.context.resume()
  const [delivered] = await waitFor(async () => {
    const messages = await dueMessages(second.context, sessionId)
    return messages.length === 1 ? messages : undefined
  })
  assert.match(delivered.event.data.content[0].text, /^\[SCHEDULE REMINDER\]/)
  assert.match(delivered.event.data.content[0].text, /reminder_prompt_json: "Run after restart"/)
  assert.equal((await second.schedules.catalog())[0].status, 'ended')
  await second.context.close()

  const third = await fixture(t, { dataDir, models, provider })
  t.after(() => third.context.close())
  third.context.resume()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal((await dueMessages(third.context, sessionId)).length, 1)
})
