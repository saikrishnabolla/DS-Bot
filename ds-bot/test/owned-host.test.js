import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'
import { sessionMention } from '../src/client/at-menu.js'

const waitFor = async (check, timeout = 5_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the owned Host')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function authenticate(host) {
  const launch = await fetch(host.launchUrl, { redirect: 'manual' })
  assert.equal(launch.status, 303)
  const cookie = launch.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

const api = (host, cookie) => async (endpoint, payload = {}) => {
  const response = await fetch(`${host.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

const upload = async (host, cookie, { name, type, data }) => {
  const response = await fetch(`${host.origin}/api/bot/upload`, {
    method: 'POST',
    headers: { cookie, origin: host.origin, 'content-type': type, 'x-dsbot-file-name': encodeURIComponent(name), 'x-dsbot-upload': '1' },
    body: data,
  })
  assert.equal(response.status, 200)
  return (await response.json()).value
}

async function followFeed(host, cookie, signal, events) {
  const response = await fetch(`${host.origin}/api/bot/feed`, { headers: { cookie }, signal })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = block.split('\n').find(line => line.startsWith('event: '))?.slice(7)
        if (event !== undefined) events.push(event)
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

test('owned Host preserves the desktop API, feed and transcript across restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-host-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({
    authPath: join(dataDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  })
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage('Ready.'),
    fauxAssistantMessage('First answer.'),
    fauxAssistantMessage('One durable answer.'),
  ])
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  let first = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  const cookie = await authenticate(first)
  const call = api(first, cookie)
  assert.match(await (await fetch(`${first.origin}/`, { headers: { cookie } })).text(), /Cue/)

  const feed = []
  const feedAbort = new AbortController()
  const feedDone = followFeed(first, cookie, feedAbort.signal, feed)
  await waitFor(() => feed.includes('hello'))

  const initial = await call('state', { locale: 'en' })
  assert.equal(initial.ok, true)
  const bot = initial.value.bots[0]
  assert.ok(bot)
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  assert.equal((await call('send', { sessionId: bot.id, text: 'hello' })).ok, true)
  await waitFor(async () => {
    const chat = await call('chat', { botId: bot.id })
    return chat.value.items.some(item => item.kind === 'bot' && item.text === 'First answer.')
  })

  const durable = { sessionId: bot.id, content: [{ type: 'text', text: 'idempotent' }], requestId: 'durable-request' }
  await first.runtime.sendUser(durable)
  await first.runtime.sendUser(durable)
  const beforeRestart = await waitFor(async () => {
    const chat = await call('chat', { botId: bot.id })
    return chat.value.items.some(item => item.kind === 'bot' && item.text === 'One durable answer.') ? chat.value : undefined
  })
  assert.equal(beforeRestart.items.filter(item => item.kind === 'user' && item.text === 'idempotent').length, 1)
  await waitFor(() => feed.includes('message') && feed.includes('stream'))

  feedAbort.abort()
  await feedDone
  await first.close()
  first = undefined

  const restarted = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => restarted.close())
  const restartedCookie = await authenticate(restarted)
  const after = api(restarted, restartedCookie)
  const restored = await after('state', { locale: 'en' })
  assert.equal(restored.value.bots[0].id, bot.id)
  await restarted.runtime.sendUser(durable)
  const restoredChat = await after('chat', { botId: bot.id })
  assert.ok(restoredChat.value.items.some(item => item.kind === 'bot' && item.text === 'One durable answer.'))
  assert.equal(restoredChat.value.items.filter(item => item.kind === 'user' && item.text === 'idempotent').length, 1)
})

test('owned Host references private and group chats from bounded durable snapshots', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-references-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  let privateRequest
  let groupRequest
  const response = async context => {
    const text = JSON.stringify(context)
    if (text.includes('private-reference-question')) privateRequest = context
    if (text.includes('group-reference-question')) groupRequest = context
    return fauxAssistantMessage('Ready.')
  }
  faux.setResponses(Array.from({ length: 40 }, () => response))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  let host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  let cookie = await authenticate(host)
  let call = api(host, cookie)
  const chief = (await call('state', { locale: 'en' })).value.bots[0]
  assert.equal((await call('update-bot', { id: chief.id, model: 'faux/faux-1' })).ok, true)
  const researcher = (await call('create-bot', { name: 'Researcher', model: 'faux/faux-1' })).value
  await waitFor(() => faux.state.callCount >= 2)
  assert.equal((await call('send', { sessionId: researcher.id, text: 'durable target fact 4815' })).ok, true)
  await waitFor(async () => (await call('chat', { botId: researcher.id })).value.items.some(item => item.kind === 'user' && item.text === 'durable target fact 4815'))

  const outside = await host.runtime.ctx.sessionController.create()
  await host.runtime.ctx.sessionTitle.rename(outside.sessionId, 'Outside notes')
  await host.runtime.ctx.sessionController.selectModel({ sessionId: outside.sessionId, provider: 'faux', model: 'faux-1' })
  await host.runtime.ctx.sessionController.prompt({ sessionId: outside.sessionId, mode: 'queue', content: [{ type: 'text', text: 'outside owned conversation' }] })
  const outsideAgent = await host.runtime.ctx.sessionController.resolveAgent(outside.sessionId)
  await outsideAgent.agent.whenIdle()
  const candidates = await call('reference-chats', { sessionId: chief.id })
  assert.equal(candidates.ok, true)
  assert.equal(candidates.value.byId[outside.sessionId].title, 'Outside notes')
  assert.equal(candidates.value.byId[outside.sessionId].blank, false)

  const targetSession = host.runtime.chatOf(researcher.id)
  const reference = { sessionId: targetSession, label: 'Chat with Researcher', ref: sessionMention(targetSession, 'Chat with Researcher') }
  assert.equal((await call('send', { sessionId: chief.id, text: 'private-reference-question @Chat with Researcher', references: [reference] })).ok, true)
  await waitFor(() => privateRequest)
  assert.match(JSON.stringify(privateRequest), /durable target fact 4815/)
  const privateChat = await waitFor(async () => {
    const value = await call('chat', { botId: chief.id })
    return value.value.items.some(item => item.kind === 'user' && item.referenceLabels?.includes('Chat with Researcher')) ? value.value : undefined
  })
  assert.ok(privateChat.items.some(item => item.kind === 'user' && item.text.includes('private-reference-question') && item.referenceLabels?.includes('Chat with Researcher')))

  const selfSession = host.runtime.chatOf(chief.id)
  const self = { sessionId: selfSession, label: 'This chat', ref: sessionMention(selfSession, 'This chat') }
  assert.equal((await call('send', { sessionId: chief.id, text: 'self', references: [self] })).error.code, 'bot/invalid')
  const missing = { sessionId: 'missing-session', label: 'Missing', ref: sessionMention('missing-session', 'Missing') }
  assert.equal((await call('send', { sessionId: chief.id, text: 'stale', references: [missing] })).error.code, 'bot/stale')

  const room = (await call('create-room', { name: 'Reference room', members: [chief.id, researcher.id], admin: chief.id })).value
  assert.equal((await call('send', { sessionId: room.id, text: 'group-reference-question @Chat with Researcher', references: [reference] })).ok, true)
  await waitFor(() => groupRequest)
  assert.match(JSON.stringify(groupRequest), /durable target fact 4815/)

  await host.close()
  host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  cookie = await authenticate(host)
  call = api(host, cookie)
  const restored = await call('chat', { botId: chief.id })
  assert.ok(restored.value.items.some(item => item.kind === 'user' && item.referenceLabels?.includes('Chat with Researcher')))
})

test('owned Host lets Pi persist Cue checkpoints without losing earlier chat', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-compaction-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  const respond = async context => {
    const request = JSON.stringify(context)
    if (request.includes('You are now writing a checkpoint of this conversation')) return fauxAssistantMessage('The user asked for both earlier facts.')
    if (request.includes('You are the context steward of an AI assistant')) return fauxAssistantMessage('{"action":"compact","reason":"the requested work is still in progress"}')
    if (request.includes('You keep the long-term memory of one Bot')) return fauxAssistantMessage('{"changes":[]}')
    if (request.includes('Keep the second fact while the work remains in progress')) return fauxAssistantMessage('Second answer.')
    if (request.includes('Establish the first fact')) return fauxAssistantMessage('First answer.')
    return fauxAssistantMessage('Ready.')
  }
  faux.setResponses(Array.from({ length: 20 }, () => respond))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  const host = await OwnedHost.open({
    dataDir,
    uiDir,
    models,
    workspacePath: dataDir,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
  })
  t.after(() => host.close())
  const cookie = await authenticate(host)
  const call = api(host, cookie)
  const bot = (await call('state', { locale: 'en' })).value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)
  assert.equal((await call('send', { sessionId: bot.id, text: 'Establish the first fact.' })).ok, true)
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'First answer.'))
  const prompt = 'Keep the second fact while the work remains in progress.'
  assert.equal((await call('send', { sessionId: bot.id, text: prompt })).ok, true)
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'Second answer.'))

  await host.runtime.resolveAgent(bot.id)
  const taskId = await host.runtime.ctx.harness.compact(bot.id)
  const settled = await host.runtime.ctx.harness.waitForTask(taskId)
  assert.equal(settled.state.outcome.status, 'completed')
  const placed = await host.runtime.ctx.harness.waitForSubmission(settled.state.outcome.result.submissionId)
  assert.equal(placed.status, 'done')
  const active = await host.runtime.ctx.harness.context(bot.id)
  assert.ok(active.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('[Checkpoint 1]'))))
  const activeText = active.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.equal(activeText.split('Establish the first fact.').length - 1, 1)
  assert.equal(activeText.split(prompt).length - 1, 1)
  const chat = await call('chat', { botId: bot.id })
  assert.ok(chat.value.items.some(item => item.kind === 'user' && item.text === 'Establish the first fact.'))
  assert.ok(chat.value.items.some(item => item.kind === 'user' && item.text === prompt))
})

test('owned Host reaches the production Pi threshold through the Cue checkpoint hook', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-threshold-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.models[0].contextWindow = 128_000
  faux.models[0].maxTokens = 500
  let stewardCalls = 0
  let checkpointCalls = 0
  const stewardRequests = []
  const response = async context => {
    const request = JSON.stringify(context)
    const input = request.includes('threshold-turn-') ? Math.ceil(request.length / 4) : 10
    const usage = { input, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: input + 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    if (request.includes('You are now writing a checkpoint of this conversation')) {
      checkpointCalls += 1
      return fauxAssistantMessage('The numbered facts remain available.', { usage })
    }
    if (request.includes('You are the context steward of an AI assistant')) {
      stewardCalls += 1
      stewardRequests.push(request)
      return fauxAssistantMessage('{"action":"compact","reason":"the numbered work is still in progress"}', { usage })
    }
    if (request.includes('You keep the long-term memory of one Bot')) return fauxAssistantMessage('{"changes":[]}', { usage })
    const turn = /threshold-turn-(\d+)/.exec(request)?.[1]
    return fauxAssistantMessage(turn === undefined ? 'Ready.' : `threshold-answer-${turn}`, { usage })
  }
  faux.setResponses(Array.from({ length: 100 }, () => response))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  const cookie = await authenticate(host)
  const call = api(host, cookie)
  const bot = (await call('state', { locale: 'en' })).value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)
  host.runtime.ctx.harness.models.getModel('faux', 'faux-1').contextWindow = 8_000

  const markers = []
  for (let turn = 1; turn <= 12 && checkpointCalls === 0; turn += 1) {
    const marker = `threshold-turn-${turn}`
    markers.push(marker)
    assert.equal((await call('send', { sessionId: bot.id, text: `${marker} ${'detail '.repeat(350)}` })).ok, true)
    await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === `threshold-answer-${turn}`))
  }
  await waitFor(() => checkpointCalls > 0)
  await waitFor(async () => (await host.runtime.ctx.harness.context(bot.id)).messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('[Checkpoint 1]'))))

  assert.equal(stewardCalls, 1)
  assert.equal(checkpointCalls, 1)
  assert.match(stewardRequests[0], /the assistant has just finished its turn/)
  assert.doesNotMatch(stewardRequests[0], /the assistant is in the middle of a turn/)
  const active = await host.runtime.ctx.harness.context(bot.id)
  const text = active.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  for (const marker of markers) assert.equal(text.split(marker).length - 1, 1)
})

test('a production Pi threshold switch waits for the running turn and keeps its request', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-threshold-switch-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')
  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.models[0].contextWindow = 128_000
  faux.models[0].maxTokens = 500
  let stewardCalls = 0
  const response = async context => {
    const request = JSON.stringify(context)
    const input = request.includes('threshold-switch-request') ? Math.ceil(request.length / 4) : 10
    const usage = { input, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: input + 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    if (request.includes('You are the context steward of an AI assistant')) {
      stewardCalls += 1
      return fauxAssistantMessage('{"action":"switch","reason":"the turn can finish before moving on"}', { usage })
    }
    if (request.includes('You are now writing a handoff note to yourself')) {
      return fauxAssistantMessage('## Goals\n- Keep the threshold request.\n\n## Constraints and preferences\n- (none)\n\n## Progress\n- Done: the turn answered.\n- In progress: none.\n- Blocked: none.\n\n## Decisions\n- Move to a fresh part after the answer.\n\n## Facts to keep\n- threshold-switch-request\n\n## Open threads\n- (none)\n\n## Next step\n- (none)\n\n## Where to look\n- threshold-switch-request', { usage })
    }
    if (request.includes('You keep the long-term memory of one Bot')) return fauxAssistantMessage('{"changes":[]}', { usage })
    if (request.includes('threshold-switch-request')) return fauxAssistantMessage('threshold-switch-answer', { usage })
    return fauxAssistantMessage('Ready.', { usage })
  }
  faux.setResponses(Array.from({ length: 100 }, () => response))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  const cookie = await authenticate(host)
  const call = api(host, cookie)
  const bot = (await call('state', { locale: 'en' })).value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)
  host.runtime.ctx.harness.models.getModel('faux', 'faux-1').contextWindow = 8_000
  const oldSession = host.runtime.chatOf(bot.id)

  assert.equal((await call('send', { sessionId: bot.id, text: `threshold-switch-request ${'detail '.repeat(350)}` })).ok, true)
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'threshold-switch-answer'))
  const newSession = await waitFor(() => {
    const current = host.runtime.chatOf(bot.id)
    return current !== oldSession ? current : undefined
  })
  await waitFor(() => [...host.runtime.switchJobs()].length === 0)

  assert.equal(stewardCalls, 1)
  assert.notEqual(newSession, oldSession)
  const handoff = await host.runtime.ctx.harness.context(newSession)
  const handoffText = handoff.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(handoffText, /threshold-switch-request/)
})

test('owned Host uploads image and file attachments, sends their real content to Pi, and restores their receipts', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-attachments-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses([fauxAssistantMessage('Ready.')])
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  let host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  let cookie = await authenticate(host)
  let call = api(host, cookie)
  const initial = await call('state', { locale: 'en' })
  const bot = initial.value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)

  const imageData = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('exact image bytes')])
  const fileData = Buffer.from('%PDF exact file bytes')
  const image = await upload(host, cookie, { name: '../screen.png', type: 'image/png', data: imageData })
  const duplicate = await upload(host, cookie, { name: 'copy.png', type: 'image/png', data: imageData })
  const file = await upload(host, cookie, { name: 'notes.pdf', type: 'application/pdf', data: fileData })
  assert.equal(image.attachmentId, duplicate.attachmentId)
  assert.equal(image.name, 'screen.png')
  const imageDigest = image.attachmentId.slice('sha256:'.length)
  const unauthenticatedImage = await fetch(`${host.origin}/api/bot/attachment/${imageDigest}`)
  assert.equal(unauthenticatedImage.status, 401)
  const servedImage = await fetch(`${host.origin}/api/bot/attachment/${imageDigest}`, { headers: { cookie } })
  assert.equal(servedImage.headers.get('content-type'), 'image/png')
  assert.equal(servedImage.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await servedImage.arrayBuffer()), imageData)
  const servedFile = await fetch(`${host.origin}/api/bot/attachment/${file.attachmentId.slice('sha256:'.length)}`, { headers: { cookie } })
  assert.equal(servedFile.headers.get('content-type'), 'application/octet-stream')
  assert.equal((await call('send', { sessionId: bot.id, content: [{ type: 'image', attachment: file }] })).error.code, 'bot/invalid')
  assert.equal((await call('send', { sessionId: bot.id, content: [{ type: 'file', attachment: { ...file, bytes: file.bytes + 1 } }] })).error.code, 'bot/invalid')
  assert.equal((await call('send', { sessionId: bot.id, content: [{ type: 'unknown', attachment: file }] })).error.code, 'bot/invalid')

  let modelRequest
  faux.setResponses([async context => {
    modelRequest = context
    return fauxAssistantMessage('Attachments received.')
  }])
  const sent = await call('send', {
    sessionId: bot.id,
    content: [
      { type: 'text', text: 'check these' },
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
    ],
  })
  assert.equal(sent.ok, true)
  await waitFor(() => modelRequest)
  const user = modelRequest.messages.find(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === 'check these'))
  assert.ok(user.content.some(block => block.type === 'image' && block.data === imageData.toString('base64') && block.mimeType === 'image/png'))
  const fileNote = user.content.find(block => block.type === 'text' && block.text.includes('notes.pdf'))?.text
  assert.match(fileNote, /Read-only copy saved at/)
  const [, path] = /saved at ("(?:[^"\\]|\\.)+")/.exec(fileNote)
  assert.deepEqual(await readFile(JSON.parse(path)), fileData)
  await assert.rejects(writeFile(JSON.parse(path), 'changed'), /EACCES|EPERM/)

  const before = await waitFor(async () => {
    const chat = await call('chat', { botId: bot.id })
    return chat.value.items.some(item => item.kind === 'bot' && item.text === 'Attachments received.') ? chat.value : undefined
  })
  const receipt = before.items.find(item => item.kind === 'user' && item.text === 'check these')
  assert.deepEqual(receipt.attachments.map(block => [block.type, block.attachment.name]), [['image', 'screen.png'], ['file', 'notes.pdf']])

  await host.close()
  host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  cookie = await authenticate(host)
  call = api(host, cookie)
  const restored = await call('chat', { botId: bot.id })
  const restoredReceipt = restored.value.items.find(item => item.kind === 'user' && item.text === 'check these')
  assert.deepEqual(restoredReceipt.attachments.map(block => [block.type, block.attachment.name, block.attachment.bytes]), [
    ['image', 'screen.png', imageData.length],
    ['file', 'notes.pdf', fileData.length],
  ])
})

test('owned Host redacts saved secrets from durable model requests', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-secrets-'))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses([fauxAssistantMessage('Ready.')])
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(async () => {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const cookie = await authenticate(host)
  const call = api(host, cookie)
  const initial = await call('state', { locale: 'en' })
  const bot = initial.value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)

  const secret = 'test-secret-782341'
  assert.equal((await call('secret-set', { name: 'OWNED_TOKEN', value: secret, scope: 'all' })).ok, true)
  const requests = []
  faux.setResponses(Array.from({ length: 10 }, () => async context => {
    requests.push(JSON.stringify(context))
    return fauxAssistantMessage('Redacted.')
  }))
  const agent = await host.runtime.resolveAgent(bot.id)
  assert.equal((await call('send', { sessionId: bot.id, text: `Do not leak ${secret}` })).ok, true)
  await agent.whenIdle()
  const requestText = requests.find(request => request.includes('Do not leak')) ?? ''
  assert.notEqual(requestText, '')
  assert.doesNotMatch(requestText, new RegExp(secret))
  assert.match(requestText, /\[secret:OWNED_TOKEN\]/)
  assert.match(requestText, /Current time:/)
})

test('owned Host runs Pi coding tools with a Bot-scoped saved secret', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-tools-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses([fauxAssistantMessage('Ready.')])
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  const cookie = await authenticate(host)
  const call = api(host, cookie)
  const initial = await call('state', { locale: 'en' })
  const bot = initial.value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)

  const secret = 'test-shell-secret-24591'
  assert.equal((await call('secret-set', { name: 'OWNED_TOKEN', value: secret, scope: 'all' })).ok, true)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'printf %s "$CUE_SECRET_OWNED_TOKEN" > secret-output.txt' }, { id: 'call-bash' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Saved without exposing it.'),
  ])
  assert.equal((await call('send', { sessionId: bot.id, text: 'Use the saved token.' })).ok, true)
  const approval = await waitFor(async () => {
    const state = await call('state', { locale: 'en' })
    return state.value.work.approvals.find(entry => entry.botId === bot.id && entry.tool === 'bash')
  })
  assert.match(approval.reason, /run this shell command/)
  assert.equal((await call('approval-answer', { id: approval.id, choice: 'allow' })).ok, true)
  const outputPath = join(host.runtime.teamFolder() ?? dataDir, 'secret-output.txt')
  await waitFor(async () => {
    try { return await readFile(outputPath, 'utf8') === secret } catch { return false }
  })
  const chat = await call('chat', { botId: bot.id })
  assert.equal(JSON.stringify(chat.value).includes(secret), false)

  const refusedPath = join(host.runtime.teamFolder() ?? dataDir, 'refused.txt')
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: refusedPath, content: 'must not be written' }, { id: 'call-write' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The write was refused.'),
  ])
  assert.equal((await call('send', { sessionId: bot.id, text: 'Try another change.' })).ok, true)
  const refused = await waitFor(async () => {
    const state = await call('state', { locale: 'en' })
    return state.value.work.approvals.find(entry => entry.botId === bot.id && entry.tool === 'write')
  })
  assert.equal((await call('approval-answer', { id: refused.id, choice: 'reject' })).ok, true)
  await waitFor(async () => {
    const value = await call('chat', { botId: bot.id })
    return value.value.items.some(item => item.kind === 'bot' && item.text === 'The write was refused.')
  })
  await assert.rejects(readFile(refusedPath, 'utf8'))

  const readOnlyPath = join(host.runtime.teamFolder() ?? dataDir, 'read-only.txt')
  assert.equal((await call('update-bot', { id: bot.id, permission: 'read-only' })).ok, true)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: readOnlyPath, content: 'blocked' }, { id: 'call-read-only' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Read-only was enforced.'),
  ])
  assert.equal((await call('send', { sessionId: bot.id, text: 'Try writing under read-only.' })).ok, true)
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'Read-only was enforced.'))
  await assert.rejects(readFile(readOnlyPath, 'utf8'))
  assert.equal((await call('state', { locale: 'en' })).value.work.approvals.length, 0)

  const fullAccessPath = join(host.runtime.teamFolder() ?? dataDir, 'full-access.txt')
  assert.equal((await call('update-bot', { id: bot.id, permission: 'danger-full-access' })).ok, true)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: fullAccessPath, content: 'allowed' }, { id: 'call-full-access' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Full access was enforced.'),
  ])
  assert.equal((await call('send', { sessionId: bot.id, text: 'Write under full access.' })).ok, true)
  await waitFor(async () => {
    try { return await readFile(fullAccessPath, 'utf8') === 'allowed' } catch { return false }
  })
  assert.equal((await call('state', { locale: 'en' })).value.work.approvals.length, 0)
})

test('owned Host relays room work, stops it, and restores the room transcript', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-room-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('Ready.')))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  let host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  let cookie = await authenticate(host)
  let call = api(host, cookie)
  const initial = await call('state', { locale: 'en' })
  const chief = initial.value.bots[0]
  assert.equal((await call('update-bot', { id: chief.id, model: 'faux/faux-1' })).ok, true)
  const worker = (await call('create-bot', { name: 'Worker', model: 'faux/faux-1' })).value
  const room = (await call('create-room', { name: 'Ops', members: [chief.id, worker.id], admin: chief.id })).value
  await waitFor(() => faux.state.callCount >= 2)

  const before = faux.state.callCount
  faux.setResponses([
    async (_context, options) => {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 400)
        options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      return fauxAssistantMessage('Stopped answer.')
    },
  ])
  assert.equal((await call('send', { sessionId: room.id, text: 'start slow work' })).ok, true)
  await waitFor(() => faux.state.callCount > before)
  const stopped = await call('stop-room-work', { roomId: room.id })
  assert.deepEqual(stopped, { ok: true, value: true })
  await new Promise(resolve => setTimeout(resolve, 50))

  faux.setResponses([fauxAssistantMessage('Room answer.')])
  assert.equal((await call('send', { sessionId: room.id, text: 'answer now' })).ok, true)
  const answered = await waitFor(async () => {
    const chat = await call('chat', { roomId: room.id })
    const hasPost = chat.value.items.some(item => item.kind === 'post')
    const hasUser = chat.value.items.some(item => item.kind === 'user' && item.text === 'answer now')
    return hasPost && hasUser ? chat.value : undefined
  })
  assert.ok(answered.items.some(item => item.kind === 'post'))
  await waitFor(async () => (await call('room-progress', { roomId: room.id })).value.length === 0)

  await host.close()
  host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  cookie = await authenticate(host)
  call = api(host, cookie)
  const restored = await call('chat', { roomId: room.id })
  assert.ok(restored.value.items.some(item => item.kind === 'post'))
  assert.ok(restored.value.items.some(item => item.kind === 'user' && item.text === 'answer now'))
  await new Promise(resolve => setTimeout(resolve, 100))
  await waitFor(async () => (await call('room-progress', { roomId: room.id })).value.length === 0)
})

test('a completed group reply appears on the live owned feed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-live-room-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('Ready.')))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  const cookie = await authenticate(host)
  const call = api(host, cookie)
  const chief = (await call('state', { locale: 'en' })).value.bots[0]
  assert.equal((await call('update-bot', { id: chief.id, model: 'faux/faux-1' })).ok, true)
  const worker = (await call('create-bot', { name: 'Worker', model: 'faux/faux-1' })).value
  const room = (await call('create-room', { name: 'Ops', members: [chief.id, worker.id], admin: chief.id })).value
  await waitFor(async () => (await call('room-progress', { roomId: room.id })).value.length === 0)

  let release
  faux.setResponses([async () => await new Promise(resolve => { release = () => resolve(fauxAssistantMessage('Room answer.')) })])
  const live = []
  const unsubscribe = host.runtime.subscribeFeed((event, data) => live.push({ event, data }))
  t.after(unsubscribe)
  assert.equal((await call('send', { sessionId: room.id, text: 'answer now' })).ok, true)
  await waitFor(() => typeof release === 'function')
  await waitFor(() => live.some(({ event, data }) => event === 'message' && data.roomId === room.id && data.item?.kind === 'user'))
  release()

  await waitFor(async () => (await call('chat', { roomId: room.id })).value.items.some(item => item.kind === 'post'))
  await waitFor(() => live.some(({ event, data }) => event === 'message' && data.roomId === room.id && data.item?.kind === 'post'))
})
