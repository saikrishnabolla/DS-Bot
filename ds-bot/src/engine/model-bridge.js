import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { BlockAssembler } from './messages.js'

const PROVIDER = 'ds-bot'
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

function messageOf(model, response) {
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
      const message = messageOf(model, {
        content: [],
        stopReason: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      stream.push({ type: 'error', reason: 'error', error: message })
    }
  })()
  return stream
}

function deferredStream(model, start) {
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
      const message = messageOf(model, {
        content: [],
        stopReason: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
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

function normalizeModelStream(model, source) {
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
          stream.push(event)
          if (event.type === 'done' || event.type === 'error') terminal = true
        }
      }
      if (legacy) {
        const reason = piStopReason(assembler.finish.kind)
        const message = messageOf(model, {
          content: assembler.blocks().map(piBlock),
          stopReason: reason,
          ...(assembler.finish.failure === undefined ? {} : { errorMessage: String(assembler.finish.failure) }),
        })
        stream.push(reason === 'error' || reason === 'aborted'
          ? { type: 'error', reason, error: message }
          : { type: 'done', reason, message })
      } else if (!terminal) {
        stream.end(await source.result?.())
      }
    } catch (error) {
      const message = messageOf(model, { content: [], stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error) })
      stream.push({ type: 'error', reason: 'error', error: message })
    }
  })()
  return stream
}

export function createModelBridge(models, transformRequest = async context => context, interceptStream) {
  const scripts = new Map()
  const bridged = new Proxy(models, {
    get(target, property, receiver) {
      if (property === 'getModel') {
        return (provider, id) => provider === PROVIDER && scripts.has(id) ? modelOf(id) : target.getModel(provider, id)
      }
      if (property === 'streamSimple') {
        return (model, context, options) => {
          const respond = model?.provider === PROVIDER ? scripts.get(model.id) : undefined
          if (respond !== undefined) return responseStream(model, respond, context, options)
          return deferredStream(model, async () => {
            const request = await transformRequest(context, options)
            const source = interceptStream === undefined
              ? target.streamSimple(model, request, options)
              : await interceptStream(model, request, options, () => target.streamSimple(model, request, options))
            return normalizeModelStream(model, source)
          })
        }
      }
      if (property === 'completeSimple') {
        return async (model, context, options) => {
          const respond = model?.provider === PROVIDER ? scripts.get(model.id) : undefined
          if (respond !== undefined) return responseStream(model, respond, context, options).result()
          return target.completeSimple(model, await transformRequest(context, options), options)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    models: bridged,
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
