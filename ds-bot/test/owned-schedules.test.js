import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRuntime } from '../index.js'
import { OwnedContext } from '../src/engine/owned-context.js'
import { installOwnedSchedules, nextOwnedScheduleAt, resolveOwnedScheduleTiming } from '../src/engine/owned-schedules.js'

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
  assert.ok(record.updatedAt)
  assert.deepEqual(await schedules.view({ id: 'missing' }), { id: 'missing', code: 'schedule_not_found' })
  assert.deepEqual(await schedules.edit({ id: 'missing', action: 'delete' }), { id: 'missing', code: 'schedule_not_found' })
  assert.deepEqual(await schedules.edit({
    id: created.id,
    action: 'update',
    patch: { title: 'Stale change' },
    expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
  }), { id: created.id, code: 'schedule_conflict' })
  assert.equal((await schedules.view({ id: created.id })).title, 'Standup')
  const revision = (await schedules.view({ id: created.id })).updatedAt
  const competing = await Promise.all([
    schedules.edit({ id: created.id, action: 'update', patch: { title: 'First writer' }, expectedUpdatedAt: revision }),
    schedules.edit({ id: created.id, action: 'update', patch: { title: 'Second writer' }, expectedUpdatedAt: revision }),
  ])
  assert.equal(competing.filter(result => result.code === 'schedule_conflict').length, 1)
  assert.ok(['First writer', 'Second writer'].includes((await schedules.view({ id: created.id })).title))
  const beforeActiveUpdate = await schedules.view({ id: created.id })
  const activeUpdate = await schedules.edit({ id: created.id, action: 'update', patch: { title: 'Standup', active: true } })
  assert.equal(activeUpdate.scheduledAt, beforeActiveUpdate.scheduledAt)
  const tasks = await context.harness.scanTasks({ kind: 'ds-bot.schedule' }, 10)
  assert.equal(tasks.items.filter(task => task.state.status !== 'terminal').length, 1)

  const cron = await schedules.create({
    title: 'Canonical cron', prompt: 'Run once a week',
    timing: { kind: 'cron', cron: { expression: '0,1,2 09 * * 0,7', time_zone: 'US/Eastern' } },
    target: { kind: 'session', sessionId },
  })
  assert.equal(cron.expression, '0-2 9 * * 0')
  assert.equal(cron.timeZone, 'America/New_York')
  await schedules.edit({ id: cron.id, action: 'delete' })

  await assert.rejects(schedules.create({ title: 'Past', prompt: 'x', timing: { kind: 'at', at: '2000-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId } }), /future/i)
  await assert.rejects(schedules.create({ title: 'Fast', prompt: 'x', timing: { kind: 'every', every_seconds: 59 }, target: { kind: 'session', sessionId } }), /minute|60/i)
  await assert.rejects(schedules.create({ title: 'Bad time', prompt: 'x', timing: { kind: 'daily', daily: { time: '9am', time_zone: 'UTC' } }, target: { kind: 'session', sessionId } }), /schedule time/i)
  await assert.rejects(schedules.create({ title: 'Bad zone', prompt: 'x', timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Mars/Olympus' } }, target: { kind: 'session', sessionId } }), /time zone/i)
  await assert.rejects(schedules.create({ title: 'No day', prompt: 'x', timing: { kind: 'weekly', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [] } }, target: { kind: 'session', sessionId } }), /weekday/i)

  const movedTo = await target(context)
  await schedules.edit({ id: created.id, action: 'update', patch: { target: { kind: 'session', sessionId: movedTo } } })
  assert.deepEqual((await schedules.catalog())[0].target, { kind: 'session', sessionId: movedTo })
  await schedules.edit({ id: created.id, action: 'delete' })
  assert.deepEqual(await schedules.catalog(), [])
})

test('owned cron and RRULE timing preserves zones and DST rules', () => {
  assert.equal(nextOwnedScheduleAt({
    kind: 'cron',
    cron: { expression: '0 9 * * 1-5', time_zone: 'America/New_York' },
  }, Date.parse('2026-11-09T00:00:00.000Z')), Date.parse('2026-11-09T14:00:00.000Z'))

  assert.equal(nextOwnedScheduleAt({
    kind: 'rrule',
    rrule: 'DTSTART;TZID=America/New_York:20260307T023000\nRRULE:FREQ=DAILY;COUNT=2',
  }, Date.parse('2026-03-07T08:00:00.000Z')), Date.parse('2026-03-09T06:30:00.000Z'))

  assert.equal(nextOwnedScheduleAt({
    kind: 'rrule',
    rrule: 'DTSTART;TZID=America/New_York:20261101T013000\nRRULE:FREQ=DAILY;COUNT=1',
  }, Date.parse('2026-10-31T00:00:00.000Z')), Date.parse('2026-11-01T05:30:00.000Z'))

  assert.deepEqual(resolveOwnedScheduleTiming(
    { kind: 'every', everySeconds: 60, anchor: 0 },
    60_000,
    190_000,
  ), { occurrenceAt: 180_000, nextAt: 240_000 })
})

test('owned RRULE validation matches the supported schedule contract', () => {
  const after = Date.parse('2026-01-01T00:00:00.000Z')
  const invalid = [
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2;UNTIL=20261231T090000Z', /COUNT and UNTIL/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260230T090000Z', /real calendar/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;BYEASTER=1', /supports only/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=0', /INTERVAL/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;BYHOUR=9,9', /unique/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;BYMINUTE=60', /BYMINUTE/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;BYDAY=MO,+0MO', /BYDAY/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYSETPOS=1', /another BY|requires/i],
    ['DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;BYHOUR=9;BYSETPOS=1', /no effect/i],
    [`DTSTART:20260101T090000Z\nRRULE:FREQ=YEARLY;BYMONTH=${Array.from({ length: 12 }, (_, index) => index + 1).join(',')};BYHOUR=${Array.from({ length: 24 }, (_, index) => index).join(',')};BYMINUTE=${Array.from({ length: 60 }, (_, index) => index).join(',')}`, /10080|limit/i],
  ]
  for (const [rrule, expected] of invalid) {
    assert.throws(() => nextOwnedScheduleAt({ kind: 'rrule', rrule }, after), expected)
  }

  assert.equal(nextOwnedScheduleAt({
    kind: 'cron',
    cron: { expression: '0,1,2 09 * * 0,7', time_zone: 'US/Eastern' },
  }, after), Date.parse('2026-01-04T14:00:00.000Z'))
})

test('owned recurrence stays bounded and preserves DTSTART and Vixie defaults', () => {
  const after = Date.parse('2026-11-09T00:00:00.000Z')
  const started = Date.now()
  assert.equal(nextOwnedScheduleAt({
    kind: 'rrule',
    rrule: 'DTSTART:20000101T000000Z\nRRULE:FREQ=MINUTELY',
  }, after), Date.parse('2026-11-09T00:01:00.000Z'))
  assert.ok(Date.now() - started < 500)

  assert.equal(nextOwnedScheduleAt({
    kind: 'rrule',
    rrule: `DTSTART:20260101T000000Z\nRRULE:FREQ=MONTHLY;BYHOUR=${Array.from({ length: 24 }, (_, index) => index).join(',')};BYMINUTE=${Array.from({ length: 60 }, (_, index) => index).join(',')}`,
  }, after), Date.parse('2026-12-01T00:00:00.000Z'))
  assert.throws(() => nextOwnedScheduleAt({
    kind: 'rrule',
    rrule: 'DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYHOUR=9;BYSETPOS=1',
  }, after), /no effect/i)
  assert.throws(() => nextOwnedScheduleAt({
    kind: 'rrule',
    rrule: 'DTSTART:20260101T090000Z\nRRULE:FREQ=WEEKLY;BYHOUR=9;BYSETPOS=7',
  }, after), /BYSETPOS/i)

  assert.equal(nextOwnedScheduleAt({
    kind: 'cron',
    cron: { expression: '0 9 */2 * 1', time_zone: 'UTC' },
  }, Date.parse('2026-11-09T10:00:00.000Z')), Date.parse('2026-11-23T09:00:00.000Z'))
})

test('owned Bot schedule tools run through the model and stay scoped to the Bot', async t => {
  const { context, schedules, dataDir, provider } = await fixture(t)
  t.after(() => context.close())
  const runtime = createRuntime(context, { home: join(dataDir, 'bot'), github: false, diagnosticsFile: false, browser: false, computer: false })
  context.installTools(runtime.teamTools, runtime)
  const initial = await runtime.handle('state', { locale: 'en' })
  const chief = initial.value.bots[0]

  provider.setResponses([transcript => {
    assert.match(JSON.stringify(transcript), /Only create or modify scheduled tasks at the user.s explicit request/)
    return fauxAssistantMessage('Ready.')
  }])
  await runtime.handle('update-bot', { id: chief.id, model: 'faux/faux-1' })
  const chiefAgent = (await context.sessionController.resolveAgent(chief.id)).agent
  await chiefAgent.whenIdle()
  assert.deepEqual(context.tools.schemas(chiefAgent).filter(tool => tool.name.startsWith('schedule_')).map(tool => tool.name).sort(), [
    'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
  ])

  let scheduleId
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('schedule_create', {
      title: 'Weekday brief',
      prompt: 'Summarize today',
      rrule: 'DTSTART;TZID=America/New_York:20990101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      target: 'this_session',
    }, { id: 'schedule-create' }), { stopReason: 'toolUse' }),
    (transcript) => {
      const value = JSON.parse(transcript.messages.findLast(message => message.role === 'toolResult').content[0].text)
      scheduleId = value.id
      assert.equal(value.kind, 'rrule')
      assert.equal(value.target.sessionId, chief.id)
      assert.match(value.scheduledAtLocal, /-05:00$/)
      return fauxAssistantMessage(fauxToolCall('schedule_list', {}, { id: 'schedule-list' }), { stopReason: 'toolUse' })
    },
    (transcript) => {
      const value = JSON.parse(transcript.messages.findLast(message => message.role === 'toolResult').content[0].text)
      assert.deepEqual(value.items.map(item => item.id), [scheduleId])
      return fauxAssistantMessage(fauxToolCall('schedule_view', { id: scheduleId }, { id: 'schedule-view' }), { stopReason: 'toolUse' })
    },
    (transcript) => {
      const value = JSON.parse(transcript.messages.findLast(message => message.role === 'toolResult').content[0].text)
      return fauxAssistantMessage(fauxToolCall('schedule_edit', {
        id: scheduleId,
        action: 'update',
        title: 'Paused brief',
        active: false,
        expectedUpdatedAt: value.updatedAt,
      }, { id: 'schedule-edit' }), { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('Schedule updated.'),
  ])
  await runtime.handle('send', { sessionId: chief.id, text: 'Set up my weekday brief.' })
  await waitFor(() => scheduleId)
  await chiefAgent.whenIdle()
  const [record] = await schedules.catalog()
  assert.equal(record.id, scheduleId)
  assert.equal(record.title, 'Paused brief')
  assert.equal(record.status, 'paused')
  const chiefPage = await context.sessionController.page({ sessionId: chief.id, maxMessages: 100 })
  assert.deepEqual(chiefPage.records.filter(item => item.event.type === 'tool/call').slice(-4).map(item => item.event.data.name), [
    'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  ])

  provider.setResponses([fauxAssistantMessage('Worker ready.')])
  const worker = (await runtime.handle('create-bot', { name: 'Worker', model: 'faux/faux-1' })).value
  const workerAgent = (await context.sessionController.resolveAgent(worker.id)).agent
  await workerAgent.whenIdle()
  const crossCalls = prefix => [
    fauxAssistantMessage(fauxToolCall('schedule_view', { id: scheduleId }, { id: `${prefix}-view` }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('schedule_edit', { id: scheduleId, action: 'update', title: 'Stolen' }, { id: `${prefix}-edit` }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('schedule_edit', { id: scheduleId, action: 'delete' }, { id: `${prefix}-delete` }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('schedule_edit', {
      id: scheduleId, action: 'update', title: 'Stale', expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    }, { id: `${prefix}-stale` }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('That schedule is not available in this chat.'),
  ]
  provider.setResponses([
    ...crossCalls('foreign'),
  ])
  await runtime.handle('send', { sessionId: worker.id, text: 'Read the other schedule.' })
  await workerAgent.whenIdle()
  assert.equal((await schedules.catalog())[0].title, 'Paused brief')
  await schedules.edit({ id: scheduleId, action: 'delete' })

  provider.setResponses([...crossCalls('missing')])
  await runtime.handle('send', { sessionId: worker.id, text: 'Try that schedule again.' })
  await workerAgent.whenIdle()
  const workerPage = await context.sessionController.page({ sessionId: worker.id, maxMessages: 100 })
  const resultText = callId => workerPage.records.find(item => item.event.type === 'tool/result' && item.event.data.message.toolCallId === callId).event.data.message
  for (const operation of ['view', 'edit', 'delete', 'stale']) {
    const foreign = resultText(`foreign-${operation}`)
    const missing = resultText(`missing-${operation}`)
    assert.equal(foreign.isError, false)
    assert.equal(missing.isError, false)
    assert.equal(foreign.content[0].text, missing.content[0].text)
    assert.equal(foreign.content[0].text, JSON.stringify({ id: scheduleId, code: 'schedule_not_found' }))
  }

  const createTool = runtime.teamTools.find(tool => tool.name === 'schedule_create')
  const editTool = runtime.teamTools.find(tool => tool.name === 'schedule_edit')
  assert.deepEqual(createTool.parameters.properties.target.enum, ['this_session'])
  assert.deepEqual(editTool.parameters.properties.target.enum, ['this_session'])
  assert.deepEqual(await createTool.execute({
    title: 'Outside', prompt: 'Run elsewhere',
    rrule: 'DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=1', target: 'new',
  }, { agent: workerAgent }), { code: 'internal_error', message: 'The schedule operation failed.' })
  assert.deepEqual(await editTool.execute({ id: scheduleId, action: 'update', target: 'new' }, { agent: workerAgent }), {
    code: 'invalid_selector', message: 'A Bot’s scheduled tasks run in its own chat. Use target "this_session".',
  })

  const { sessionId: plainId } = await context.sessionController.create()
  const plain = (await context.sessionController.resolveAgent(plainId)).agent
  assert.deepEqual(context.tools.schemas(plain).filter(tool => tool.name.startsWith('schedule_')), [])
  await context.close()
})

test('owned recurring schedules stop after deletion', async t => {
  const { context, schedules, provider } = await fixture(t)
  t.after(() => context.close())
  const sessionId = await target(context)
  provider.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('Scheduled response.')))
  const due = new Date(Date.now() + 1_100)
  await schedules.create({
    title: 'Pulse',
    prompt: 'Check now',
    timing: { kind: 'daily', daily: { time: due.toISOString().slice(11, 19), time_zone: 'UTC' } },
    target: { kind: 'session', sessionId },
  })
  context.resume()

  await waitFor(async () => (await dueMessages(context, sessionId)).length === 1, 4_000)
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

test('owned recurring schedules remain active after a due time crosses restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-recurring-restart-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()
  const provider = fauxProvider()
  provider.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('Scheduled recurring response.')))
  models.setProvider(provider.provider)

  const first = await fixture(t, { dataDir, models, provider })
  const sessionId = await target(first.context)
  const due = new Date(Date.now() + 1_100)
  await first.schedules.create({
    title: 'Daily restart reminder',
    prompt: 'Run daily after restart',
    timing: {
      kind: 'daily',
      daily: { time: due.toISOString().slice(11, 19), time_zone: 'UTC' },
    },
    target: { kind: 'session', sessionId },
  })
  first.context.resume()
  await new Promise(resolve => setTimeout(resolve, 50))
  await first.context.close()
  await new Promise(resolve => setTimeout(resolve, 1_100))

  const second = await fixture(t, { dataDir, models, provider })
  second.context.resume()
  await waitFor(async () => (await dueMessages(second.context, sessionId)).length === 1)
  const [record] = await second.schedules.catalog()
  assert.equal(record.status, 'active')
  assert.ok(Date.parse(record.scheduledAt) > Date.now() + 23 * 60 * 60_000)
  await second.context.close()

  const third = await fixture(t, { dataDir, models, provider })
  t.after(() => third.context.close())
  third.context.resume()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal((await dueMessages(third.context, sessionId)).length, 1)
})

test('stopping a target conversation ends its owned schedules across restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-schedule-stop-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()
  const provider = fauxProvider()
  models.setProvider(provider.provider)

  const first = await fixture(t, { dataDir, models, provider })
  const sessionId = await target(first.context)
  await first.schedules.create({
    title: 'Must stop',
    prompt: 'Do not revive',
    timing: { kind: 'every', every_seconds: 60 },
    target: { kind: 'session', sessionId },
  })
  first.context.resume()
  await first.context.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  await first.context.harness.waitForIdle(sessionId)
  assert.equal((await first.schedules.catalog())[0].status, 'ended')
  await first.context.close()

  const second = await fixture(t, { dataDir, models, provider })
  t.after(() => second.context.close())
  second.context.resume()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await second.schedules.catalog())[0].status, 'ended')
  assert.equal((await second.context.harness.scanTasks({ kind: 'ds-bot.schedule' }, 10)).items.filter(task => task.state.status !== 'terminal').length, 0)
})

test('paused owned schedules stay paused across restart and resume once', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-schedule-pause-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()
  const provider = fauxProvider()
  models.setProvider(provider.provider)

  const first = await fixture(t, { dataDir, models, provider })
  const sessionId = await target(first.context)
  const created = await first.schedules.create({
    title: 'Paused task', prompt: 'Wait',
    timing: { kind: 'every', every_seconds: 60 },
    target: { kind: 'session', sessionId },
  })
  await first.schedules.edit({ id: created.id, action: 'update', patch: { active: false } })
  assert.equal((await first.schedules.catalog())[0].status, 'paused')
  await first.context.close()

  const second = await fixture(t, { dataDir, models, provider })
  t.after(() => second.context.close())
  assert.equal((await second.schedules.catalog())[0].status, 'paused')
  second.context.resume()
  await waitFor(async () => (await second.context.harness.scanTasks({ kind: 'ds-bot.schedule' }, 10)).items.every(task => task.state.status === 'terminal'))
  const resumed = await second.schedules.edit({ id: created.id, action: 'update', patch: { active: true } })
  assert.equal(resumed.status, 'active')
  assert.equal((await second.context.harness.scanTasks({ kind: 'ds-bot.schedule' }, 10)).items.filter(task => task.state.status !== 'terminal').length, 1)
})
