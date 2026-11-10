import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'

const inventory = tools => JSON.stringify({ capability_version: '1', enforcement_adapters: [], schema_version: '1', tools })

const listWindows = {
  name: 'list_windows',
  description: 'List windows',
  inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { windows: { type: 'array' } }, required: ['windows'], additionalProperties: true },
}

const click = {
  name: 'click',
  description: 'Click a window',
  inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, session: { type: 'string' } }, required: ['pid'], additionalProperties: false },
}

function fakeDriver() {
  const calls = []
  const state = { shutdowns: 0, destroys: 0 }
  return {
    calls,
    state,
    listToolsJson: async () => inventory([listWindows, click]),
    callTool: async (name, raw) => {
      const args = JSON.parse(raw)
      calls.push({ name, args })
      const value = name === 'list_windows'
        ? { windows: [{ pid: 42, window_id: 7, app_name: 'Notes' }] }
        : { clicked: true }
      return {
        text: name === 'list_windows' ? 'Found Notes.' : 'Clicked Notes.',
        structuredJson: JSON.stringify(value),
        isError: false,
        degraded: false,
        rawJson: '{}',
      }
    },
    shutdown: async () => { state.shutdowns += 1 },
    uniffiDestroy: () => { state.destroys += 1 },
  }
}

const waitFor = async (check, timeout = 5_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the owned computer-use flow')
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

test('owned Host runs the public computer-use flow and restores its durable settings', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-computer-host-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses([fauxAssistantMessage('Ready.')])
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })

  let driver = fakeDriver()
  const accessCalls = []
  const access = {
    systemStatus: async () => ({ accessibility: true, screenRecording: false }),
    requestPermission: async permission => { accessCalls.push(['request', permission]); return { accessibility: true, screenRecording: true } },
    openSettings: async permission => { accessCalls.push(['settings', permission]) },
  }
  let host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir, computerUse: { driverFactory: async () => driver, access } })
  t.after(() => host?.close())
  let cookie = await authenticate(host)
  let call = api(host, cookie)
  const bot = (await call('state', { locale: 'en' })).value.bots[0]
  assert.equal((await call('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => faux.state.callCount >= 1)

  const level = await call('computer-set-level', { botId: bot.id, level: 'foreground' })
  assert.equal(level.ok, true, JSON.stringify(level))
  assert.equal((await call('computer-set-enabled', { enabled: true })).ok, true)
  await waitFor(async () => (await call('state', { locale: 'en' })).value.computer.provider.state === 'ready')
  assert.deepEqual((await call('computer-system-status')).value, { accessibility: true, screenRecording: false })
  assert.deepEqual((await call('computer-permission', { permission: 'screenRecording' })).value, { accessibility: true, screenRecording: true })
  assert.equal((await call('computer-open-settings', { permission: 'accessibility' })).value, true)
  assert.deepEqual(accessCalls, [['request', 'screenRecording'], ['settings', 'accessibility']])

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('cua_driver_native__list_windows', {}, { id: 'list-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('cua_driver_native__click', { pid: 42 }, { id: 'click-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Computer task complete.'),
  ])
  assert.equal((await call('send', { sessionId: bot.id, text: 'Use Notes.' })).ok, true)
  const ask = await waitFor(async () => {
    const state = await call('state', { locale: 'en' })
    return Object.values(state.value.computerLive.asks)[0]
  })
  assert.equal(ask.botId, bot.id)
  assert.equal(ask.appName, 'Notes')
  assert.equal((await call('computer-app-answer', { id: ask.id, answer: 'always' })).value, true)
  await waitFor(() => driver.calls.some(entry => entry.name === 'click'))
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'Computer task complete.'))
  const settled = await call('state', { locale: 'en' })
  assert.deepEqual(Object.keys(settled.value.computerLive.asks), [])
  assert.equal(Object.values(settled.value.computer.bots[bot.id].apps)[0].name, 'Notes')

  assert.equal((await call('computer-takeover', { botId: bot.id })).value, true)
  const taken = await call('state', { locale: 'en' })
  assert.equal(taken.value.computerLive.bots[bot.id].state, 'user')
  assert.equal(taken.value.computerLive.holds[bot.id].by, 'user')
  faux.setResponses([fauxAssistantMessage('Control returned.')])
  assert.equal((await call('computer-handback', { botId: bot.id })).value, true)
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'Control returned.'))

  await host.close()
  assert.deepEqual(driver.state, { shutdowns: 1, destroys: 1 })
  driver = fakeDriver()
  host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir, computerUse: { driverFactory: async () => driver, access } })
  t.after(() => host.close())
  cookie = await authenticate(host)
  call = api(host, cookie)
  const restored = await waitFor(async () => {
    const state = await call('state', { locale: 'en' })
    return state.value.computer.provider.state === 'ready' ? state.value : undefined
  })
  assert.equal(restored.computer.enabled, true)
  assert.equal(restored.computer.bots[bot.id].level, 'foreground')
  assert.equal(Object.values(restored.computer.bots[bot.id].apps)[0].name, 'Notes')
  assert.deepEqual(restored.computerLive.asks, {})
  assert.deepEqual(restored.computerLive.holds, {})

  let repeatedStep = 0
  faux.setResponses(Array.from({ length: 12 }, () => async context => {
    if (JSON.stringify(context).includes('You keep the long-term memory of one Bot')) return fauxAssistantMessage('{"changes":[]}')
    repeatedStep += 1
    if (repeatedStep === 1) return fauxAssistantMessage(fauxToolCall('cua_driver_native__list_windows', {}, { id: 'list-2' }), { stopReason: 'toolUse' })
    if (repeatedStep === 2) return fauxAssistantMessage(fauxToolCall('cua_driver_native__click', { pid: 42 }, { id: 'click-2' }), { stopReason: 'toolUse' })
    return fauxAssistantMessage('Computer task repeated.')
  }))
  assert.equal((await call('send', { sessionId: bot.id, text: 'Use Notes again.' })).ok, true)
  await waitFor(() => driver.calls.some(entry => entry.name === 'click'))
  await waitFor(async () => (await call('chat', { botId: bot.id })).value.items.some(item => item.kind === 'bot' && item.text === 'Computer task repeated.'))
  assert.deepEqual((await call('state', { locale: 'en' })).value.computerLive.asks, {})
})
