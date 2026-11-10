import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../../src/engine/owned-host.js'

const [mode, dataDir, savedTaskId] = process.argv.slice(2)
const uiDir = join(dataDir, 'ui')
await mkdir(uiDir, { recursive: true })
await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
const faux = fauxProvider()
let stewardCalls = 0
let checkpointCalls = 0
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const respond = async context => {
  const request = JSON.stringify(context)
  if (request.includes('You are now writing a checkpoint of this conversation')) {
    checkpointCalls += 1
    return fauxAssistantMessage('The two crash-safe facts remain.', { usage })
  }
  if (request.includes('You are the context steward of an AI assistant')) {
    stewardCalls += 1
    return fauxAssistantMessage('{"action":"compact","reason":"the crash-safe work is still in progress"}', { usage })
  }
  if (request.includes('You keep the long-term memory of one Bot')) return fauxAssistantMessage('{"changes":[]}', { usage })
  if (request.includes('crash-safe-second')) return fauxAssistantMessage('second saved', { usage })
  if (request.includes('crash-safe-first')) return fauxAssistantMessage('first saved', { usage })
  return fauxAssistantMessage('Ready.', { usage })
}
faux.setResponses(Array.from({ length: 100 }, () => respond))
models.registerNativeProvider(faux.provider)
await models.refresh({ allowNetwork: false })

const host = await OwnedHost.open({
  dataDir,
  uiDir,
  models,
  workspacePath: dataDir,
  settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
})

async function authenticate() {
  const launch = await fetch(host.launchUrl, { redirect: 'manual' })
  return launch.headers.get('set-cookie').split(';')[0]
}

async function call(cookie, endpoint, payload = {}) {
  const response = await fetch(`${host.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  return response.json()
}

async function waitFor(check, timeout = 10_000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('Timed out in owned compaction crash fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

if (mode === 'prepare') {
  const cookie = await authenticate()
  const api = (endpoint, payload) => call(cookie, endpoint, payload)
  const bot = (await api('state', { locale: 'en' })).value.bots[0]
  await api('update-bot', { id: bot.id, model: 'faux/faux-1' })
  await waitFor(() => faux.state.callCount >= 1)
  await api('send', { sessionId: bot.id, text: 'crash-safe-first' })
  await waitFor(async () => (await api('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'first saved'))
  await api('send', { sessionId: bot.id, text: 'crash-safe-second' })
  await waitFor(async () => (await api('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'second saved'))

  host.runtime.ctx.harness.recordCompactionUsage = async () => {
    process.send?.({ type: 'memo-stored' })
    await new Promise(() => {})
  }
  const taskId = await host.runtime.ctx.harness.compact(bot.id)
  process.send?.({ type: 'task', taskId: String(taskId), botId: bot.id })
  await new Promise(() => {})
} else if (mode === 'recover') {
  const taskId = Number(savedTaskId)
  const settled = await host.runtime.ctx.harness.waitForTask(taskId)
  const submissionId = settled.state.outcome.result?.submissionId
  if (submissionId !== undefined) await host.runtime.ctx.harness.waitForSubmission(submissionId)
  const conversations = await host.runtime.ctx.harness.scanConversations({}, 100)
  const botId = String(conversations.items.find(item => item.id !== 1)?.id ?? conversations.items[0].id)
  const entries = await host.runtime.ctx.harness.entries(botId, { limit: 100, order: 'ascending' })
  const active = await host.runtime.ctx.harness.context(botId)
  const checkpointEntries = entries.items.filter(entry => entry.kind === 'pi.compaction')
  const checkpointMessages = active.messages.filter(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('[Checkpoint 1]')))
  process.send?.({ type: 'result', checkpointCalls, stewardCalls, checkpointEntries: checkpointEntries.length, checkpointMessages: checkpointMessages.length })
  await host.close()
  process.exit(0)
} else {
  throw new Error(`Unknown fixture mode: ${mode}`)
}
