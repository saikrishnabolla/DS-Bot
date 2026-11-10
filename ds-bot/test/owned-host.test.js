import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'

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
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

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
  assert.match(await (await fetch(`${first.origin}/`, { headers: { cookie } })).text(), /DS Bot/)

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

test('owned Host redacts saved secrets from durable model requests', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-secrets-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

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

  const secret = 'owned-secret-782341'
  assert.equal((await call('secret-set', { name: 'OWNED_TOKEN', value: secret, scope: 'all' })).ok, true)
  let requestText = ''
  faux.setResponses([async context => {
    requestText = JSON.stringify(context)
    return fauxAssistantMessage('Redacted.')
  }])
  assert.equal((await call('send', { sessionId: bot.id, text: `Do not leak ${secret}` })).ok, true)
  await waitFor(() => requestText !== '')
  assert.doesNotMatch(requestText, new RegExp(secret))
  assert.match(requestText, /\[secret:OWNED_TOKEN\]/)
  assert.match(requestText, /Current time:/)
})

test('owned Host runs Pi coding tools with a Bot-scoped saved secret', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-tools-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

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

  const secret = 'owned-shell-secret-24591'
  assert.equal((await call('secret-set', { name: 'OWNED_TOKEN', value: secret, scope: 'all' })).ok, true)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'printf %s "$DSH_SECRET_OWNED_TOKEN" > secret-output.txt' }, { id: 'call-bash' }), { stopReason: 'toolUse' }),
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
})

test('owned Host relays room work, stops it, and restores the room transcript', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-room-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

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
