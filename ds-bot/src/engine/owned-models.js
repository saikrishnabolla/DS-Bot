import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_MODELS = 500
const THINKING_NAMES = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
}

export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

const CUSTOM_COMPAT = {
  'openai-completions': {
    supportsDeveloperRole: false,
    supportsStore: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  },
  'openai-responses': { supportsDeveloperRole: false },
}

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export const keyRefFor = provider => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

export function checkKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key === '') throw invalid('Enter the API key')
  if (/^[A-Za-z_][A-Za-z0-9_]*=[^=]/.test(key)) throw invalid('Paste only the key, not a NAME=value line')
  if (/^(["']).*\1$/.test(key)) throw invalid('Paste the key without quotes')
  if (!/^[\x21-\x7E]+$/.test(key)) throw invalid('An API key has no spaces or special characters')
  return key
}

function checkEndpoint(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(text) } catch { throw invalid('Enter the endpoint as an http or https address') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Enter the endpoint as an http or https address')
  return text.replace(/\/+$/, '')
}

function positive(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function modelEntry(model, api, baseUrl) {
  const id = typeof model === 'string' ? model.trim() : typeof model?.id === 'string' ? model.id.trim() : ''
  if (id === '') throw invalid('Every model needs an id')
  const rawInput = Array.isArray(model?.inputModalities) ? model.inputModalities : Array.isArray(model?.input) ? model.input : ['text']
  const input = [...new Set(rawInput.filter(kind => kind === 'text' || kind === 'image'))]
  return {
    id,
    name: typeof model?.name === 'string' && model.name.trim() !== '' ? model.name.trim() : id,
    api,
    baseUrl,
    reasoning: model?.reasoning === true,
    input: input.length > 0 ? input : ['text'],
    cost: typeof model?.cost === 'object' && model.cost !== null ? model.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positive(model?.contextWindow, 128_000),
    maxTokens: positive(model?.maxTokens, 16_384),
    ...(CUSTOM_COMPAT[api] ? { compat: { ...CUSTOM_COMPAT[api], ...(model?.compat ?? {}) } } : {}),
  }
}

export function customProviderConfig(body) {
  if (!PROTOCOLS.includes(body.api)) throw invalid(`The protocol must be one of ${PROTOCOLS.join(', ')}`)
  const provider = String(body.provider ?? '').trim()
  if (!ROUTE_ID.test(provider)) throw invalid('A provider id is lowercase letters, digits and dashes, starting with a letter')
  const baseUrl = checkEndpoint(body.baseURL ?? body.baseUrl)
  const source = Array.isArray(body.models) ? body.models.slice(0, MAX_MODELS) : []
  if (source.length === 0) throw invalid('Add at least one model')
  const models = source.map(model => modelEntry(model, body.api, baseUrl))
  if (new Set(models.map(model => model.id)).size !== models.length) throw invalid('Two models have the same id')
  return {
    provider,
    name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 80) : provider,
    api: body.api,
    baseUrl,
    models,
  }
}

async function readConfig(path) {
  if (path === undefined) return { enabled: [], custom: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return {
      enabled: Array.isArray(parsed?.enabled) ? parsed.enabled.filter(id => typeof id === 'string') : [],
      custom: typeof parsed?.custom === 'object' && parsed.custom !== null ? parsed.custom : {},
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: [], custom: {} }
    throw error
  }
}

async function writeConfig(path, config) {
  if (path === undefined) return
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

function reasoningOf(model) {
  if (model?.reasoning !== true) return undefined
  const levels = getSupportedThinkingLevels(model)
  if (levels.length === 0) return undefined
  return {
    efforts: levels.map(id => ({ id, name: THINKING_NAMES[id] ?? id })),
    defaultEffort: levels.includes('medium') ? 'medium' : levels.at(-1),
  }
}

function catalogEntry(model, runtime) {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
    id: model.id,
    name: model.name ?? model.id,
    input: [...(model.input ?? ['text'])],
    ...(runtime.hasConfiguredAuth(model.provider) ? {} : { needsKey: true }),
    ...(reasoningOf(model) ? { reasoning: reasoningOf(model) } : {}),
  }
}

export class OwnedModels {
  #runtime
  #path
  #config

  constructor(runtime, path, config) {
    this.#runtime = runtime
    this.#path = path
    this.#config = config
  }

  static async open(runtime, { configPath } = {}) {
    const config = await readConfig(configPath)
    const models = new OwnedModels(runtime, configPath, config)
    for (const [id, entry] of Object.entries(config.custom)) models.#registerCustom(id, entry)
    return models
  }

  get runtime() { return this.#runtime }

  catalog() {
    return this.#runtime.getModels().map(model => catalogEntry(model, this.#runtime))
  }

  keyRefs() {
    return new Map(this.#runtime.getProviders()
      .filter(provider => provider.auth?.apiKey !== undefined)
      .map(provider => [provider.id, keyRefFor(provider.id)]))
  }

  defaultModel() {
    return this.catalog().find(model => model.needsKey !== true)?.ref
  }

  reasoning(ref) {
    const slash = String(ref).indexOf('/')
    if (slash < 1) return undefined
    return reasoningOf(this.#runtime.getModel(String(ref).slice(0, slash), String(ref).slice(slash + 1)))
  }

  async refresh() {
    await this.#runtime.refresh({ allowNetwork: true })
    return this.catalog()
  }

  async providersView() {
    const enabled = new Set(this.#config.enabled)
    const custom = new Set(Object.keys(this.#config.custom))
    const providers = []
    const addable = []
    for (const provider of this.#runtime.getProviders()) {
      const models = this.catalog().filter(model => model.provider === provider.id).map(model => ({ ref: model.ref, name: model.name }))
      const configured = this.#runtime.getProviderAuthStatus(provider.id)
      const isEnabled = enabled.has(provider.id) || custom.has(provider.id) || configured.configured || provider.auth === undefined
      if (!isEnabled && !custom.has(provider.id)) {
        addable.push({ id: provider.id, name: provider.name ?? provider.id })
        continue
      }
      providers.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models,
        key: provider.auth?.apiKey === undefined ? null : { configured: configured.configured, writable: configured.source !== 'environment' },
        removable: enabled.has(provider.id) || custom.has(provider.id),
        custom: custom.has(provider.id),
      })
    }
    providers.sort((a, b) => Number(a.removable) - Number(b.removable))
    return { available: true, providers, addable, protocols: PROTOCOLS }
  }

  async setProviderKey(provider, value) {
    if (this.#runtime.getProvider(provider) === undefined) throw invalid(`${provider} is not set up`)
    const status = this.#runtime.getProviderAuthStatus(provider)
    if (status.source === 'environment') throw invalid(`The API key for ${provider} is set outside Cue and cannot be changed here`)
    const key = checkKey(value)
    await this.#runtime.login(provider, 'api_key', {
      prompt: async () => key,
      notify: () => {},
    })
  }

  async clearProviderKey(provider) {
    const status = this.#runtime.getProviderAuthStatus(provider)
    if (status.source === 'environment') throw invalid(`The API key for ${provider} is set outside Cue and cannot be changed here`)
    await this.#runtime.logout(provider)
  }

  async addProvider(body) {
    const provider = String(body.provider ?? '').trim()
    if (this.#config.enabled.includes(provider) || this.#config.custom[provider] !== undefined) throw invalid(`${provider} is already set up`)
    if (body.custom === true) {
      if (this.#runtime.getProvider(provider) !== undefined) throw invalid(`Pi already offers ${provider}; add it from its list`)
      const config = customProviderConfig(body)
      this.#config.custom[provider] = config
      this.#registerCustom(provider, config)
    } else {
      if (this.#runtime.getProvider(provider) === undefined) throw invalid(`Pi offers no provider ${provider}`)
      this.#config.enabled.push(provider)
    }
    await writeConfig(this.#path, this.#config)
    if (typeof body.key === 'string' && body.key.trim() !== '') await this.setProviderKey(provider, body.key)
    return this.providersView()
  }

  async removeProvider(provider) {
    const custom = this.#config.custom[provider] !== undefined
    const enabled = this.#config.enabled.includes(provider)
    if (!custom && !enabled) throw invalid(`${provider} is not set up or comes with this setup`)
    await this.#runtime.logout(provider).catch(() => undefined)
    if (custom) {
      this.#runtime.unregisterProvider(provider)
      delete this.#config.custom[provider]
    }
    this.#config.enabled = this.#config.enabled.filter(id => id !== provider)
    await writeConfig(this.#path, this.#config)
    return this.providersView()
  }

  async discoverModels(body, { fetch: fetcher = globalThis.fetch } = {}) {
    const provider = typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined
    if (provider !== undefined) {
      if (this.#runtime.getProvider(provider) === undefined) throw invalid(`Pi offers no provider ${provider}`)
      await this.#runtime.refresh({ allowNetwork: true }).catch(() => undefined)
      return this.#runtime.getModels(provider).slice(0, MAX_MODELS).map(model => this.#modelView(model))
    }
    const baseUrl = checkEndpoint(body.baseURL ?? body.baseUrl)
    if (body.api !== undefined && !PROTOCOLS.includes(body.api)) throw invalid(`The protocol must be one of ${PROTOCOLS.join(', ')}`)
    const headers = { accept: 'application/json' }
    if (typeof body.key === 'string' && body.key.trim() !== '') headers.authorization = `Bearer ${checkKey(body.key)}`
    const response = await fetcher(`${baseUrl}/models`, { headers })
    if (!response.ok) throw invalid(`The endpoint refused model discovery (${response.status})`)
    const value = await response.json()
    const entries = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.models) ? value.models : []
    if (entries.length === 0) throw invalid('The endpoint returned no models')
    return entries.slice(0, MAX_MODELS).map(model => this.#modelView(model))
  }

  #modelView(model) {
    const input = model.inputModalities ?? model.input
    return {
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(Array.isArray(input) ? { inputModalities: [...input] } : {}),
    }
  }

  #registerCustom(provider, config) {
    this.#runtime.registerProvider(provider, {
      name: config.name,
      baseUrl: config.baseUrl,
      api: config.api,
      authHeader: true,
      models: config.models,
    })
  }
}
