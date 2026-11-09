import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OwnedModels, checkKey, keyRefFor } from '../src/engine/owned-models.js'

const builtins = [
  { id: 'anthropic', name: 'Anthropic', auth: { apiKey: { name: 'API key' } } },
  { id: 'local', name: 'Local' },
]

const baseModels = [
  { provider: 'anthropic', id: 'claude', name: 'Claude', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], cost: { input: 1, output: 2 }, contextWindow: 200_000, maxTokens: 32_000, type: 'chat' },
  { provider: 'local', id: 'small', name: 'Small', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0 }, contextWindow: 8_000, maxTokens: 2_000, type: 'chat' },
]

function runtime() {
  const providers = new Map(builtins.map(provider => [provider.id, structuredClone(provider)]))
  const models = new Map(baseModels.map(model => [`${model.provider}/${model.id}`, structuredClone(model)]))
  const keys = new Map()
  const registered = new Set()
  return {
    getProviders: () => [...providers.values()],
    getProvider: id => providers.get(id),
    getModels: id => [...models.values()].filter(model => id === undefined || model.provider === id),
    getModel: (provider, id) => models.get(`${provider}/${id}`),
    hasConfiguredAuth: id => keys.has(id) || providers.get(id)?.auth === undefined,
    getProviderAuthStatus: id => ({ configured: keys.has(id) || providers.get(id)?.auth === undefined, ...(keys.has(id) ? { source: 'runtime' } : {}) }),
    setRuntimeApiKey: async (id, key) => { keys.set(id, key) },
    removeRuntimeApiKey: async id => { keys.delete(id) },
    refresh: async () => {},
    registerProvider(id, config) {
      registered.add(id)
      providers.set(id, { id, name: config.name ?? id, auth: { apiKey: { name: 'API key' } } })
      for (const model of config.models) models.set(`${id}/${model.id}`, { ...model, provider: id, type: 'chat' })
    },
    unregisterProvider(id) {
      providers.delete(id)
      for (const key of models.keys()) if (key.startsWith(`${id}/`)) models.delete(key)
      registered.delete(id)
    },
    inspect: () => ({ keys, registered }),
  }
}

test('the owned catalog preserves the UI shape without exposing Pi models', async () => {
  const rt = runtime()
  const owned = await OwnedModels.open(rt)
  const catalog = owned.catalog()
  assert.deepEqual(catalog.map(entry => [entry.ref, entry.needsKey]), [['anthropic/claude', true], ['local/small', undefined]])
  assert.equal(catalog[0].providerName, 'Anthropic')
  assert.deepEqual(catalog[0].input, ['text', 'image'])
  assert.ok(catalog[0].reasoning.efforts.some(entry => entry.id === 'high'))
  assert.equal(owned.defaultModel(), 'local/small')
})

test('provider setup and credentials persist independently of the Pi runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-models-'))
  const configPath = join(dir, 'providers.json')
  const rt = runtime()
  const owned = await OwnedModels.open(rt, { configPath })
  await owned.addProvider({ provider: 'anthropic', key: 'sk-live' })
  assert.equal(rt.inspect().keys.get('anthropic'), 'sk-live')
  assert.ok((await owned.providersView()).providers.some(provider => provider.id === 'anthropic'))

  await owned.addProvider({
    custom: true,
    provider: 'relay',
    name: 'Relay',
    api: 'openai-completions',
    baseURL: 'https://relay.example/v1/',
    key: 'relay-key',
    models: [{ id: 'r1', contextWindow: 32_000, inputModalities: ['text'] }],
  })
  assert.ok(rt.inspect().registered.has('relay'))
  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(saved.custom.relay.baseUrl, 'https://relay.example/v1')
  assert.equal(saved.custom.relay.models[0].compat.maxTokensField, 'max_tokens')

  const restarted = runtime()
  await OwnedModels.open(restarted, { configPath })
  assert.ok(restarted.inspect().registered.has('relay'))
  assert.equal(restarted.getModel('relay', 'r1').contextWindow, 32_000)
})

test('model discovery uses a typed key only for the request', async () => {
  const owned = await OwnedModels.open(runtime())
  const calls = []
  const models = await owned.discoverModels({ baseURL: 'https://relay.example/v1', api: 'openai-completions', key: 'sk-question' }, {
    fetch: async (url, options) => {
      calls.push([url, options])
      return { ok: true, json: async () => ({ data: [{ id: 'r1', context_window: 10 }] }) }
    },
  })
  assert.equal(calls[0][0], 'https://relay.example/v1/models')
  assert.equal(calls[0][1].headers.authorization, 'Bearer sk-question')
  assert.deepEqual(models, [{ id: 'r1' }])
})

test('provider input validation rejects values that cannot be used safely', async () => {
  const owned = await OwnedModels.open(runtime())
  const custom = { custom: true, provider: 'relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', models: ['m'] }
  await assert.rejects(owned.addProvider({ ...custom, provider: 'Bad Route' }), /lowercase letters/)
  await assert.rejects(owned.addProvider({ ...custom, api: 'grpc' }), /protocol must be one of/i)
  await assert.rejects(owned.addProvider({ ...custom, baseURL: 'relay.example' }), /http or https/)
  await assert.rejects(owned.addProvider({ ...custom, models: [] }), /at least one model/)
  await assert.rejects(owned.addProvider({ ...custom, models: ['m', 'm'] }), /same id/)
  assert.equal(checkKey(' sk-abc '), 'sk-abc')
  assert.throws(() => checkKey('KEY=sk-abc'), /NAME=value/)
  assert.throws(() => checkKey('"sk-abc"'), /without quotes/)
  assert.equal(keyRefFor('my-gateway2'), 'MY_GATEWAY2_API_KEY')
})
