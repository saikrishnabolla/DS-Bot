import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { OwnedHost } from '../../src/engine/owned-host.js'

const [mode, dataDir, savedBotId] = process.argv.slice(2)
const uiDir = join(dataDir, 'ui')
const safeAttemptsPath = join(dataDir, 'safe-attempts.txt')
const unsafePath = join(dataDir, 'unsafe-side-effect.txt')
await mkdir(uiDir, { recursive: true })
await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
const faux = fauxProvider()
const prepare = mode.endsWith('-prepare')
let blocked = false
let safeExecuting = false

const SafeToolExtension = defineExtension({
  name: 'ds-bot-safe-replay-fixture',
  tools: [defineTool({
    name: 'safe_probe',
    description: 'Read the crash fixture value.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    replay: 'safe',
    execute: async () => {
      await appendFile(safeAttemptsPath, 'x')
      if (prepare) {
        safeExecuting = true
        await new Promise(() => {})
      }
      return { output: [{ type: 'text', text: 'safe replay content' }] }
    },
  })],
})

function latestUserText(context) {
  const users = (context.messages ?? []).filter(message =>
    message.role === 'user' && message.source?.kind === 'user'
  )
  const content = users.at(-1)?.content ?? []
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

const shellPath = `'${unsafePath.replaceAll("'", "'\\''")}'`
const respond = async context => {
  const request = JSON.stringify(context)
  const latest = latestUserText(context)
  if (request.includes('model-crash-input')) {
    if (prepare && !blocked) {
      blocked = true
      process.send?.({ type: 'model-started-pending' })
      await new Promise(() => {})
    }
    return fauxAssistantMessage('model recovered')
  }
  if (latest === 'safe-tool-input') {
    if (request.includes('safe replay content')) return fauxAssistantMessage('safe tool recovered')
    return fauxAssistantMessage(fauxToolCall('safe_probe', {}, { id: 'call-safe-probe' }), { stopReason: 'toolUse' })
  }
  if (latest === 'unsafe-tool-input') {
    if (request.includes('interrupted') || request.includes('may have partially run')) return fauxAssistantMessage('unsafe interruption handled')
    return fauxAssistantMessage(fauxToolCall('bash', { command: `printf x >> ${shellPath}; sleep 60` }, { id: 'call-unsafe-bash' }), { stopReason: 'toolUse' })
  }
  if (request.includes('queue-first') || request.includes('queue-second')) {
    if (prepare && latest.includes('queue-first') && !blocked) {
      blocked = true
      process.send?.({ type: 'queue-model-pending' })
      await new Promise(() => {})
    }
    return fauxAssistantMessage(request.lastIndexOf('queue-second') > request.lastIndexOf('queue-first') ? 'second recovered' : 'first recovered')
  }
  return fauxAssistantMessage('Ready.')
}
faux.setResponses(Array.from({ length: 100 }, () => respond))
models.registerNativeProvider(faux.provider)
await models.refresh({ allowNetwork: false })

const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir, settings: { extensions: [SafeToolExtension] } })

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

async function waitFor(check, timeout = 20_000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Timed out in owned runtime crash fixture (${mode})`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const exists = path => access(path).then(() => true, () => false)

async function setup(permission) {
  const cookie = await authenticate()
  const api = (endpoint, payload) => call(cookie, endpoint, payload)
  const bot = (await api('state', { locale: 'en' })).value.bots[0]
  const update = await api('update-bot', { id: bot.id, model: 'faux/faux-1' })
  if (!update.ok) throw new Error(`Could not configure Bot: ${JSON.stringify(update)}`)
  await waitFor(() => faux.state.callCount >= 1)
  if (permission !== undefined) {
    const allowed = await api('update-bot', { id: bot.id, permission })
    if (!allowed.ok) throw new Error(`Could not set Bot permission: ${JSON.stringify(allowed)}`)
  }
  return { cookie, api, bot }
}

async function entriesOf(botId) {
  const items = []
  let cursor
  do {
    const page = await host.runtime.ctx.harness.entries(botId, { limit: 100, cursor, order: 'ascending' })
    items.push(...page.items)
    cursor = page.next
  } while (cursor !== undefined)
  return items
}

const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const messagesOf = entries => entries.flatMap(entry => entry.model ?? [])

async function recoveredMessages(botId) {
  await host.runtime.ctx.harness.waitForIdle(botId)
  const entries = await entriesOf(botId)
  return { entries, messages: messagesOf(entries) }
}

if (mode === 'model-prepare') {
  const { api, bot } = await setup()
  await api('send', { sessionId: bot.id, text: 'model-crash-input' })
  await waitFor(() => blocked)
  process.send?.({ type: 'model-started', botId: bot.id })
  await new Promise(() => {})
} else if (mode === 'model-recover') {
  const { messages } = await recoveredMessages(savedBotId)
  process.send?.({
    type: 'model-result',
    userInputs: messages.filter(message => message.role === 'user' && textOf(message) === 'model-crash-input').map(textOf),
    assistantAnswers: messages.filter(message => message.role === 'assistant' && textOf(message) === 'model recovered').map(textOf),
  })
  await host.close()
  process.exit(0)
} else if (mode === 'safe-prepare') {
  const { api, bot } = await setup()
  await api('send', { sessionId: bot.id, text: 'safe-tool-input' })
  await waitFor(() => safeExecuting)
  process.send?.({ type: 'safe-started', botId: bot.id })
  await new Promise(() => {})
} else if (mode === 'safe-recover') {
  const { entries, messages } = await recoveredMessages(savedBotId)
  const results = entries.filter(entry => entry.kind === 'pi.tool-result' && entry.model?.[0]?.toolName === 'safe_probe')
  process.send?.({
    type: 'safe-result',
    attempts: await readFile(safeAttemptsPath, 'utf8'),
    toolResults: results.map(entry => ({
      isError: entry.model[0].isError,
      text: textOf(entry.model[0]).includes('safe replay content') ? 'safe replay content' : textOf(entry.model[0]),
    })),
    assistantAnswers: messages.filter(message => message.role === 'assistant' && textOf(message) === 'safe tool recovered').map(textOf),
  })
  await host.close()
  process.exit(0)
} else if (mode === 'unsafe-prepare') {
  const { api, bot } = await setup('danger-full-access')
  await api('send', { sessionId: bot.id, text: 'unsafe-tool-input' })
  await waitFor(() => exists(unsafePath))
  process.send?.({ type: 'unsafe-started', botId: bot.id })
  await new Promise(() => {})
} else if (mode === 'unsafe-recover') {
  const { entries, messages } = await recoveredMessages(savedBotId)
  const results = entries.filter(entry => entry.kind === 'pi.tool-result' && entry.model?.[0]?.toolName === 'bash')
  process.send?.({
    type: 'unsafe-result',
    sideEffect: await readFile(unsafePath, 'utf8'),
    toolResults: results.map(entry => ({
      isError: entry.model[0].isError,
      code: entry.data?.diagnostics?.find(diagnostic => diagnostic.code)?.code,
    })),
    assistantAnswers: messages.filter(message => message.role === 'assistant' && textOf(message) === 'unsafe interruption handled').map(textOf),
  })
  await host.close()
  process.exit(0)
} else if (mode === 'queue-prepare') {
  const { api, bot } = await setup()
  await api('send', { sessionId: bot.id, text: 'queue-first' })
  await waitFor(() => blocked)
  const queued = await api('send', { sessionId: bot.id, text: 'queue-second' })
  if (!queued.ok) throw new Error(`Could not queue follow-up: ${JSON.stringify(queued)}`)
  process.send?.({ type: 'queue-stored', botId: bot.id })
  await new Promise(() => {})
} else if (mode === 'queue-recover') {
  const { messages } = await recoveredMessages(savedBotId)
  const cookie = await authenticate()
  const chat = await call(cookie, 'chat', { botId: savedBotId })
  const visible = new Set(['queue-first', 'first recovered', 'queue-second', 'second recovered'])
  process.send?.({
    type: 'queue-result',
    userInputs: messages.filter(message => message.role === 'user' && ['queue-first', 'queue-second'].includes(textOf(message))).map(textOf),
    assistantAnswers: messages.filter(message => message.role === 'assistant' && ['first recovered', 'second recovered'].includes(textOf(message))).map(textOf),
    chatOrder: chat.value.items.map(item => item.text).filter(text => visible.has(text)),
  })
  await host.close()
  process.exit(0)
} else {
  throw new Error(`Unknown fixture mode: ${mode}`)
}
