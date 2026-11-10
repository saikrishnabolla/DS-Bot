import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { OwnedContext } from '../../src/engine/owned-context.js'
import { installOwnedSchedules } from '../../src/engine/owned-schedules.js'

const [mode, dataDir, savedSessionId] = process.argv.slice(2)
const models = createModels()
const provider = fauxProvider()
provider.setResponses(mode === 'prepare'
  ? [async () => waitForever()]
  : Array.from({ length: 10 }, () => fauxAssistantMessage('Scheduled response.')))
models.setProvider(provider.provider)

const context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
const schedules = await installOwnedSchedules(context)

const waitFor = async (check, timeout = 15_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out in owned schedule crash fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const waitForever = async () => {
  for (;;) await new Promise(resolve => setTimeout(resolve, 60_000))
}

const scheduledMessages = async sessionId => {
  const page = await context.sessionController.page({ sessionId, maxMessages: 100 })
  return page.records.filter(record => record.event.type === 'user/message' && record.event.data.source?.kind === 'schedule')
}

if (mode === 'prepare') {
  const { sessionId } = await context.sessionController.create()
  await context.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await context.sessionController.resolveAgent(sessionId)
  context.resume()
  agent.followup({ content: 'Stay busy across the due time.', source: { kind: 'user' } })
  await waitFor(() => provider.state.callCount === 1)
  const dueAt = new Date(Date.now() + 750)
  const schedule = await schedules.create({
    title: 'Crash window',
    prompt: 'Deliver once',
    timing: { kind: 'at', at: dueAt.toISOString() },
    target: { kind: 'session', sessionId },
  })
  await waitFor(() => Date.now() > dueAt.getTime() + 100)
  if ((await scheduledMessages(sessionId)).length !== 0) throw new Error('Schedule delivered while the conversation was busy')
  process.send?.({ type: 'due', sessionId, scheduleId: schedule.id })
  await waitForever()
} else if (mode === 'recover') {
  context.resume()
  await waitFor(async () => (await scheduledMessages(savedSessionId)).length === 1)
  await context.harness.waitForIdle(savedSessionId)
  const [schedule] = await schedules.catalog()
  await new Promise(resolve => setTimeout(resolve, 250))
  process.send?.({
    type: 'recovered',
    messages: (await scheduledMessages(savedSessionId)).length,
    status: schedule.status,
    deliveredSessionId: schedule.lastDelivery?.targetSessionId,
  })
  await context.close()
  process.exit(0)
} else {
  throw new Error(`Unknown fixture mode: ${mode}`)
}
