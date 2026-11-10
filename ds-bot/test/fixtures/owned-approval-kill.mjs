import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../../src/engine/owned-host.js'

const [mode, dataDir, savedBotId, savedApprovalId] = process.argv.slice(2)
const uiDir = join(dataDir, 'ui')
const sideEffectPath = join(dataDir, 'approval-side-effect.txt')
await mkdir(uiDir, { recursive: true })
await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
const faux = fauxProvider()
const shellPath = `'${sideEffectPath.replaceAll("'", "'\\''")}'`
faux.setResponses(mode === 'prepare' || mode === 'execute'
  ? [
      fauxAssistantMessage('Ready.'),
      fauxAssistantMessage(fauxToolCall('bash', { command: `printf x >> ${shellPath}; sleep 60` }, { id: 'call-durable-approval' }), { stopReason: 'toolUse' }),
    ]
  : Array.from({ length: 10 }, () => fauxAssistantMessage('The interrupted command was not repeated.')))
models.registerNativeProvider(faux.provider)
await models.refresh({ allowNetwork: false })

const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })

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

async function waitFor(check, timeout = 15_000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('Timed out in owned approval crash fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const exists = path => access(path).then(() => true, () => false)
const errorCode = result => result.ok === false ? result.error?.code : undefined

if (mode === 'prepare') {
  const cookie = await authenticate()
  const api = (endpoint, payload) => call(cookie, endpoint, payload)
  const bot = (await api('state', { locale: 'en' })).value.bots[0]
  await api('update-bot', { id: bot.id, model: 'faux/faux-1' })
  await waitFor(() => faux.state.callCount >= 1)
  await api('send', { sessionId: bot.id, text: 'Run the crash-window command.' })
  const approval = await waitFor(async () => {
    const state = await api('state', { locale: 'en' })
    return state.value.work.approvals.find(entry => entry.botId === bot.id && entry.tool === 'bash')
  })
  process.send?.({ type: 'pending', botId: bot.id, approvalId: approval.id, sideEffect: await exists(sideEffectPath) })
  await new Promise(() => {})
} else if (mode === 'recover') {
  const cookie = await authenticate()
  const api = (endpoint, payload) => call(cookie, endpoint, payload)
  const approval = await waitFor(async () => {
    const state = await api('state', { locale: 'en' })
    return state.value.work.approvals.find(entry => entry.botId === savedBotId && entry.tool === 'bash' && entry.answerable)
  })
  process.send?.({ type: 'recovered', approvalId: approval.id, answerable: approval.answerable, sideEffectBeforeAnswer: await exists(sideEffectPath) })
  const answered = await api('approval-answer', { id: approval.id, choice: 'allow' })
  if (!answered.ok) throw new Error(`Approval failed: ${JSON.stringify(answered)}`)
  const second = await api('approval-answer', { id: approval.id, choice: 'allow' })
  const state = await api('state', { locale: 'en' })
  process.send?.({ type: 'resolved', sideEffectAfterAnswer: await exists(sideEffectPath), approvals: state.value.work.approvals.length, secondAnswer: errorCode(second) })
  await host.close()
  process.exit(0)
} else if (mode === 'execute') {
  const cookie = await authenticate()
  const api = (endpoint, payload) => call(cookie, endpoint, payload)
  const bot = (await api('state', { locale: 'en' })).value.bots[0]
  await api('update-bot', { id: bot.id, model: 'faux/faux-1' })
  await waitFor(() => faux.state.callCount >= 1)
  await api('send', { sessionId: bot.id, text: 'Run the approved crash-window command.' })
  const approval = await waitFor(async () => {
    const state = await api('state', { locale: 'en' })
    return state.value.work.approvals.find(entry => entry.botId === bot.id && entry.tool === 'bash' && entry.answerable)
  })
  const answered = await api('approval-answer', { id: approval.id, choice: 'allow' })
  if (!answered.ok) throw new Error(`Approval failed: ${JSON.stringify(answered)}`)
  await waitFor(() => exists(sideEffectPath))
  const second = await api('approval-answer', { id: approval.id, choice: 'allow' })
  process.send?.({ type: 'executed', botId: bot.id, approvalId: approval.id, content: await readFile(sideEffectPath, 'utf8'), secondAnswer: errorCode(second) })
  await new Promise(() => {})
} else if (mode === 'verify') {
  const cookie = await authenticate()
  const api = (endpoint, payload) => call(cookie, endpoint, payload)
  await host.runtime.ctx.harness.waitForIdle(savedBotId)
  await new Promise(resolve => setTimeout(resolve, 250))
  const state = await api('state', { locale: 'en' })
  const second = await api('approval-answer', { id: savedApprovalId, choice: 'allow' })
  process.send?.({
    type: 'verified',
    content: await readFile(sideEffectPath, 'utf8'),
    approvals: state.value.work.approvals.length,
    secondAnswer: errorCode(second),
  })
  await host.close()
  process.exit(0)
} else {
  throw new Error(`Unknown fixture mode: ${mode}`)
}
