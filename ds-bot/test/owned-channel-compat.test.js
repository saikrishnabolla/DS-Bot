import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'

async function openHost(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-channel-'))
  const uiDir = join(dataDir, 'ui')
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')
  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage('Ready.')))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })
  const providerId = faux.provider.id
  const modelRef = `${faux.provider.id}/${faux.models[0].id}`
  const host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(async () => {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const launch = await fetch(host.launchUrl, { redirect: 'manual' })
  const cookie = launch.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const call = async (endpoint, payload = {}) => {
    const response = await fetch(`${host.origin}/api/bot`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const state = await call('state', { locale: 'en' })
  assert.equal(state.ok, true)
  return { host, call, bot: state.value.bots[0], modelRef, providerId }
}

test('owned Host preserves model metadata and retained-content channel operations', async t => {
  const { host, call, modelRef, providerId } = await openHost(t)
  const seen = []
  host.runtime.reasoningOf = async ref => {
    seen.push(['efforts', ref])
    return { efforts: ['low', 'high'], default: 'low' }
  }
  const exchange = { id: 'compat-exchange', from: 'first', to: 'second' }
  host.runtime.state.exchanges = [exchange]
  host.runtime.exchangeText = async entry => {
    seen.push(['exchange-text', entry])
    return 'retained exchange'
  }
  host.runtime.fileText = async file => {
    seen.push(['file-text', file])
    return 'retained file'
  }
  host.runtime.providersView = async () => {
    seen.push(['providers'])
    return [{ id: providerId }]
  }
  host.runtime.addProvider = async body => {
    seen.push(['provider-add', body])
    return { id: body.provider }
  }
  host.runtime.discoverModels = async body => {
    seen.push(['provider-models', body])
    return [{ id: body.provider }]
  }
  host.runtime.removeProvider = async id => {
    seen.push(['provider-remove', id])
    return true
  }

  assert.deepEqual(await call('efforts', { ref: modelRef }), {
    ok: true,
    value: { efforts: ['low', 'high'], default: 'low' },
  })
  assert.deepEqual(await call('exchange-text', { id: exchange.id }), { ok: true, value: 'retained exchange' })
  assert.deepEqual(await call('file-text', { file: { attachmentId: 'compat-file' } }), { ok: true, value: 'retained file' })
  assert.deepEqual(await call('providers'), { ok: true, value: [{ id: providerId }] })
  assert.deepEqual(await call('provider-add', { provider: providerId }), { ok: true, value: { id: providerId } })
  assert.deepEqual(await call('provider-models', { provider: providerId }), { ok: true, value: [{ id: providerId }] })
  assert.deepEqual(await call('provider-remove', { provider: providerId }), { ok: true, value: true })
  assert.deepEqual(seen, [
    ['efforts', modelRef],
    ['exchange-text', exchange],
    ['file-text', { attachmentId: 'compat-file' }],
    ['providers'],
    ['provider-add', { provider: providerId }],
    ['provider-models', { provider: providerId }],
    ['provider-remove', providerId],
  ])
})

test('owned Host preserves updater and diagnostics channel operations at their boundaries', async t => {
  const { host, call } = await openHost(t)
  const seen = []
  host.runtime.updateCheck = async options => {
    seen.push(['update-check', options])
    return { available: false }
  }
  host.runtime.updateStart = () => {
    seen.push(['update-install'])
    return { started: true }
  }
  host.runtime.repoStars = async () => {
    seen.push(['repo-stars'])
    return 41
  }
  host.runtime.diagnostics.clear = async () => {
    seen.push(['diagnostics-clear'])
  }
  host.runtime.diagnostics.report = async body => {
    seen.push(['diagnostics', body])
    return { marker: body.marker }
  }

  assert.deepEqual(await call('update-check', { fresh: true }), { ok: true, value: { available: false } })
  assert.deepEqual(await call('update-install'), { ok: true, value: { started: true } })
  assert.deepEqual(await call('repo-stars'), { ok: true, value: 41 })
  assert.deepEqual(await call('diagnostics', { marker: 'compat' }), { ok: true, value: { marker: 'compat' } })
  assert.deepEqual(await call('diagnostics-clear'), { ok: true, value: true })
  assert.deepEqual(seen, [
    ['update-check', { fresh: true }],
    ['update-install'],
    ['repo-stars'],
    ['diagnostics', { marker: 'compat' }],
    ['diagnostics-clear'],
  ])
})

test('owned Host forwards connector, IM and local-agent compatibility operations', async t => {
  const { host, call } = await openHost(t)
  const seen = []
  host.runtime.connectorEndpoint = async (endpoint, body) => {
    seen.push(['connector', endpoint, body])
    return endpoint
  }
  host.runtime.imEndpoint = async (endpoint, body) => {
    seen.push(['im', endpoint, body])
    return endpoint
  }
  host.runtime.localAgentsEndpoint = async (endpoint, body) => {
    seen.push(['local-agent', endpoint, body])
    return endpoint
  }
  const connectorOperations = ['connector-cancel', 'connector-client', 'connector-remove', 'connector-request-cancel', 'mail-sign-in-code']
  const localAgentOperations = ['local-agents', 'local-agent-refresh', 'local-agent-add', 'local-agent-update', 'local-agent-remove']

  for (const endpoint of connectorOperations) {
    assert.deepEqual(await call(endpoint, { marker: endpoint }), { ok: true, value: endpoint })
  }
  assert.deepEqual(await call('im-unpair', { marker: 'im-unpair' }), { ok: true, value: 'im-unpair' })
  for (const endpoint of localAgentOperations) {
    assert.deepEqual(await call(endpoint, { marker: endpoint }), { ok: true, value: endpoint })
  }
  assert.deepEqual(seen, [
    ...connectorOperations.map(endpoint => ['connector', endpoint, { marker: endpoint }]),
    ['im', 'im-unpair', { marker: 'im-unpair' }],
    ...localAgentOperations.map(endpoint => ['local-agent', endpoint, { marker: endpoint }]),
  ])
})

test('owned Host preserves stop-work and new-part channel operations with runtime-owned IDs', async t => {
  const { host, call, bot } = await openHost(t)
  const seen = []
  host.runtime.resolveAgent = async sessionId => ({
    status: 'running',
    cancel: reason => seen.push(['cancel', sessionId, reason]),
  })
  host.runtime.newPart = async sessionId => {
    seen.push(['new-part', sessionId])
    return { sessionId }
  }
  const sessionId = host.runtime.chatOf(bot.id)

  assert.deepEqual(await call('stop-bot-work', { botId: bot.id }), { ok: true, value: true })
  assert.deepEqual(await call('bot-new-part', { botId: bot.id }), { ok: true, value: { sessionId } })
  assert.deepEqual(seen, [
    ['cancel', sessionId, { kind: 'user', reason: 'ds-bot/stopped' }],
    ['new-part', sessionId],
  ])
})
