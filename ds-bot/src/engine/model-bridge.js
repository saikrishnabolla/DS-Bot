import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { BlockAssembler } from './messages.js'
import { modelFailure } from './model-failure.js'

const PROVIDER = 'ds-bot'
const ADAPTER_API = 'ds-bot-adapter'
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const modelOf = id => ({
  id,
  name: id,
  api: 'ds-bot-host',
  provider: PROVIDER,
  baseUrl: 'in-process://ds-bot',
  reasoning: false,
  input: ['text'],
  cost: ZERO_USAGE.cost,
  contextWindow: 1_000_000_000,
  maxTokens: 4_096,
})

const adapterModelOf = (provider, model = {}) => ({
  id: String(model.id ?? 'default'),
  name: String(model.name ?? model.id ?? 'default'),
  api: ADAPTER_API,
  provider,
  baseUrl: `in-process://${provider}`,
  reasoning: model.reasoning !== undefined,
  input: model.inputModalities ?? model.input ?? ['text'],
  cost: ZERO_USAGE.cost,
  contextWindow: model.context?.contextWindow ?? model.contextWindow ?? 200_000,
  maxTokens: model.defaultMaxTokens ?? model.maxTokens ?? 32_768,
})

function messageOf(model, response) {
  const failure = response.failure ?? (response.stopReason === 'error' ? modelFailure({
    code: response.errorCode,
    message: response.errorMessage,
    status: response.errorStatus,
    requestId: response.requestId,
  }) : undefined)
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: response.content ?? [],
    usage: response.usage ?? ZERO_USAGE,
    stopReason: response.stopReason ?? 'stop',
    timestamp: response.timestamp ?? Date.now(),
    ...(response.errorMessage === undefined ? {} : { errorMessage: response.errorMessage }),
    ...(failure === undefined ? {} : { failure }),
  }
}

function responseStream(model, respond, context, options) {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    try {
      const response = options?.signal?.aborted
        ? { content: [], stopReason: 'aborted', errorMessage: 'Stopped' }
        : await respond({ model, context, options })
      const message = messageOf(model, response ?? { content: [], stopReason: 'stop' })
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'error', reason: message.stopReason, error: message })
      } else {
        stream.push({ type: 'done', reason: message.stopReason, message })
      }
    } catch (error) {
      const failure = modelFailure(error)
      const message = messageOf(model, {
        content: [],
        stopReason: 'error',
        errorMessage: failure.message,
        failure,
      })
      stream.push({ type: 'error', reason: 'error', error: message })
    }
  })()
  return stream
}

function deferredStream(model, start, response = {}) {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    try {
      const source = await start()
      let complete = false
      for await (const event of source) {
        stream.push(event)
        if (event.type === 'done' || event.type === 'error') complete = true
      }
      if (!complete) stream.end(await source.result())
    } catch (error) {
      const failure = modelFailure(error, response)
      const message = messageOf(model, {
        content: [],
        stopReason: 'error',
        errorMessage: failure.message,
        failure,
      })
      stream.push({ type: 'error', reason: 'error', error: message })
    }
  })()
  return stream
}

const piStopReason = kind => kind === 'tool-calls' ? 'toolUse'
  : kind === 'max-tokens' ? 'length'
    : kind === 'aborted' ? 'aborted'
      : kind === 'error' ? 'error' : 'stop'

function piBlock(block) {
  if (block.type === 'tool-call') {
    let args = block.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { args = {} }
    }
    return { type: 'toolCall', id: block.id, name: block.name, arguments: args ?? {} }
  }
  if (block.type === 'reasoning') return { type: 'thinking', thinking: block.text }
  return block
}

function normalizeModelStream(model, source, response = {}) {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    const assembler = new BlockAssembler()
    let legacy = false
    let terminal = false
    try {
      for await (const event of source) {
        const old = ['block-start', 'block-end', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'finish'].includes(event?.type)
        legacy ||= old
        if (legacy) assembler.push(event)
        else {
          if (event.type === 'error') {
            const failure = modelFailure(event.error?.failure ?? event.error ?? event, response)
            stream.push({ ...event, error: { ...event.error, errorMessage: failure.message, failure } })
          } else stream.push(event)
          if (event.type === 'done' || event.type === 'error') terminal = true
        }
      }
      if (legacy) {
        const reason = piStopReason(assembler.finish.kind)
        const failure = reason === 'error' ? modelFailure(assembler.finish.failure ?? 'Model request failed', response) : undefined
        const message = messageOf(model, {
          content: assembler.blocks().map(piBlock),
          stopReason: reason,
          ...(failure === undefined ? {} : { errorMessage: failure.message, failure }),
        })
        stream.push(reason === 'error' || reason === 'aborted'
          ? { type: 'error', reason, error: message }
          : { type: 'done', reason, message })
      } else if (!terminal) {
        stream.end(await source.result?.())
      }
    } catch (error) {
      const failure = modelFailure(error, response)
      const message = messageOf(model, { content: [], stopReason: 'error', errorMessage: failure.message, failure })
      stream.push({ type: 'error', reason: 'error', error: message })
    }
  })()
  return stream
}

export function createModelBridge(models, transformRequest = async context => context, interceptStream) {
  const scripts = new Map()
  const adapters = new Map()
  const adapterRecord = provider => adapters.get(provider)
  const cachedModels = (record, provider) => {
    let cached = record.models.get(provider)
    if (cached === undefined) {
      cached = new Map()
      record.models.set(provider, cached)
    }
    return cached
  }
  const adapterProvider = (provider, record) => {
    const info = record.adapter.providerInfo?.(provider) ?? { id: provider, name: provider }
    return { id: provider, name: info.name ?? provider }
  }
  const rememberModels = (provider, record, listed) => {
    const cached = cachedModels(record, provider)
    cached.clear()
    for (const model of listed ?? []) cached.set(String(model.id), adapterModelOf(provider, model))
  }
  const listAdapterModels = async (provider) => {
    const record = adapterRecord(provider)
    if (record === undefined) return undefined
    const listed = await record.adapter.listModels(provider)
    rememberModels(provider, record, listed)
    return listed
  }
  const resolveAdapterModel = async (provider, id) => {
    const record = adapterRecord(provider)
    if (record === undefined) return undefined
    const resolved = typeof record.adapter.resolveModel === 'function'
      ? await record.adapter.resolveModel(provider, id)
      : (await listAdapterModels(provider))?.find(model => model.id === id)
    if (resolved === undefined) return undefined
    cachedModels(record, provider).set(String(id), adapterModelOf(provider, resolved))
    return resolved
  }
  const adapterOptions = (model, request, options) => {
    const messages = [...(request.messages ?? [])]
    if (typeof request.systemPrompt === 'string' && request.systemPrompt !== '') {
      messages.unshift({ role: 'system', content: [{ type: 'text', text: request.systemPrompt }], timestamp: Date.now() })
    }
    return {
      ...options,
      provider: model.provider,
      model: model.id,
      messages,
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      ...(options?.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
    }
  }
  const bridged = new Proxy(models, {
    get(target, property, receiver) {
      if (property === 'getProviders') {
        return () => [
          ...target.getProviders(),
          ...[...adapters.entries()].map(([provider, record]) => adapterProvider(provider, record)),
        ]
      }
      if (property === 'getModels') {
        return provider => {
          if (provider === undefined) return [...target.getModels(), ...[...adapters.entries()].flatMap(([route, record]) => [...cachedModels(record, route).values()])]
          return adapterRecord(provider) === undefined ? target.getModels(provider) : [...cachedModels(adapterRecord(provider), provider).values()]
        }
      }
      if (property === 'getModel') {
        return (provider, id) => {
          if (provider === PROVIDER && scripts.has(id)) return modelOf(id)
          const record = adapterRecord(provider)
          if (record !== undefined) return cachedModels(record, provider).get(String(id)) ?? adapterModelOf(provider, { id })
          return target.getModel(provider, id)
        }
      }
      if (property === 'streamSimple') {
        return (model, context, options) => {
          const respond = model?.provider === PROVIDER ? scripts.get(model.id) : undefined
          if (respond !== undefined) return responseStream(model, respond, context, options)
          const response = {}
          return deferredStream(model, async () => {
            const request = await transformRequest(context, options)
            const record = adapterRecord(model?.provider)
            const next = override => {
              const onResponse = async (value, responseModel) => {
                response.status = value?.status
                response.headers = value?.headers
                await options?.onResponse?.(value, responseModel)
              }
              const nextOptions = { ...options, ...override, onResponse }
              return record === undefined
                ? target.streamSimple(model, request, nextOptions)
                : record.adapter.stream(adapterOptions(model, request, nextOptions))
            }
            const source = interceptStream === undefined
              ? next()
              : await interceptStream(model, request, options, next)
            return normalizeModelStream(model, source, response)
          }, response)
        }
      }
      if (property === 'completeSimple') {
        return async (model, context, options) => {
          const respond = model?.provider === PROVIDER ? scripts.get(model.id) : undefined
          if (respond !== undefined) return responseStream(model, respond, context, options).result()
          if (adapterRecord(model?.provider) !== undefined) return bridged.streamSimple(model, context, options).result()
          return target.completeSimple(model, await transformRequest(context, options), options)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    models: bridged,
    adapterProviders: () => [...adapters.entries()].map(([provider, record]) => adapterProvider(provider, record)),
    listAdapterModels,
    resolveAdapterModel,
    registerAdapter(routes, adapter) {
      const record = { adapter, models: new Map() }
      let current = new Set()
      const replace = (next) => {
        for (const route of current) {
          if (adapters.get(route) === record) adapters.delete(route)
          record.models.delete(route)
        }
        current = new Set((next ?? []).map(String))
        for (const route of current) adapters.set(route, record)
      }
      const dispose = () => replace([])
      dispose.replace = replace
      replace(routes)
      return dispose
    },
    script(id, respond) {
      const key = String(id)
      scripts.set(key, respond)
      return {
        provider: PROVIDER,
        model: key,
        dispose: () => { if (scripts.get(key) === respond) scripts.delete(key) },
      }
    },
  }
}
