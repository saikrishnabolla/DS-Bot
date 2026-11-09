import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
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
