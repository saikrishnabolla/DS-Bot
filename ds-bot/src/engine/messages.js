import { parseToolCallArguments } from '@earendil-works/pi-ai/utils/json-parse'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

const contentOf = value => (Array.isArray(value) ? value : [{ type: 'text', text: String(value ?? '') }])

export const currentToolNames = messages => getCurrentTools(messages).map(tool => tool.name)
export const parseToolArguments = value => parseToolCallArguments(typeof value === 'string' ? value : JSON.stringify(value ?? {}))

export const createUserMessage = ({ content, source, timestamp = Date.now() }) => ({ role: 'user', content: contentOf(content), ...(source === undefined ? {} : { source }), timestamp })
export const createAssistantMessage = ({ content, api = 'openai-completions', provider = 'unknown', model = 'unknown', usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason = 'stop', timestamp = Date.now() }) => ({ role: 'assistant', content: contentOf(content), api, provider, model, usage, stopReason, timestamp })
export const createSystemMessage = ({ content, timestamp = Date.now() }) => ({ role: 'system', content: contentOf(content), timestamp })
export const createToolResultMessage = ({ toolCallId, toolName, content, isError = false, timestamp = Date.now() }) => ({ role: 'toolResult', toolCallId, toolName, content: contentOf(content), isError, timestamp })

export const boundContextSummary = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)

export class HarnessError extends Error {
  constructor(message, code = 'HARNESS_ERROR', options) {
    super(message, options)
    this.code = code
  }
}

export class LlmError extends HarnessError {}

export class WebError extends HarnessError {}

export class LlmAdapter {
  dispose() {}
}

const textDelta = chunk => {
  if (typeof chunk === 'string') return chunk
  if (chunk?.type === 'text-delta') return chunk.text ?? chunk.delta ?? ''
  if (chunk?.type === 'text_delta') return chunk.delta ?? chunk.text ?? ''
  if (chunk?.type === 'content_block_delta') return chunk.delta?.text ?? ''
  return ''
}

const finishKind = value => {
  const raw = typeof value === 'object' && value !== null ? value.kind ?? value.reason : value
  if (raw === 'toolUse' || raw === 'tool_calls' || raw === 'tool-calls') return 'tool-calls'
  if (raw === 'length' || raw === 'max_tokens' || raw === 'maxTokens' || raw === 'max-tokens') return 'max-tokens'
  if (raw === 'abort') return 'aborted'
  if (raw === 'end_turn' || raw === undefined || raw === null) return 'stop'
  return String(raw)
}

const failureOf = value => {
  const candidate = value?.failure ?? value?.error ?? value
  const message = candidate?.errorMessage ?? candidate?.message
    ?? (typeof candidate === 'string' ? candidate : undefined)
  if (message === undefined) return undefined
  return { ...(typeof candidate === 'object' && candidate !== null ? candidate : {}), message: String(message) }
}

const usageOf = usage => {
  if (usage === undefined) return undefined
  return {
    ...usage,
    ...(usage.inputTokens !== undefined || usage.input === undefined ? {} : { inputTokens: usage.input }),
    ...(usage.outputTokens !== undefined || usage.output === undefined ? {} : { outputTokens: usage.output }),
    ...(usage.cacheReadTokens !== undefined || usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead }),
    ...(usage.cacheWriteTokens !== undefined || usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite }),
  }
}

export class BlockAssembler {
  #blocks = []
  #text = ''
  #reasoning = ''
  #toolCalls = new Map()
  finish = { kind: 'stop' }
  usage

  push(chunk) {
    const text = textDelta(chunk)
    if (text !== '') this.#text += text
    if (chunk?.type === 'thinking_delta' || chunk?.type === 'reasoning-delta') {
      this.#reasoning += chunk.delta ?? chunk.text ?? ''
    }
    if (chunk?.type === 'tool-call-delta') {
      const key = chunk.index ?? chunk.id ?? this.#toolCalls.size
      const current = this.#toolCalls.get(key) ?? { type: 'tool-call', id: chunk.id, name: chunk.name, arguments: '' }
      if (chunk.id !== undefined) current.id = chunk.id
      if (chunk.name !== undefined) current.name = chunk.name
      current.arguments += chunk.argumentsDelta ?? chunk.delta ?? ''
      this.#toolCalls.set(key, current)
    }
    if (chunk?.type === 'tool-call' || chunk?.type === 'tool_call' || chunk?.type === 'toolcall_end') {
      const call = chunk.toolCall ?? chunk
      const key = chunk.contentIndex ?? chunk.index ?? call.id ?? this.#toolCalls.size
      this.#toolCalls.set(key, { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
    }
    if (chunk?.type === 'done' || chunk?.type === 'finish') {
      const reason = chunk.reason ?? chunk.stopReason ?? chunk.message?.stopReason ?? 'stop'
      const kind = finishKind(reason)
      const failure = failureOf(reason) ?? failureOf(chunk.failure) ?? failureOf(chunk.error) ?? failureOf(chunk.message)
      this.finish = { kind, ...((kind === 'error' || kind === 'aborted') && failure ? { failure } : {}) }
      const usage = usageOf(chunk.usage ?? chunk.message?.usage)
      if (usage !== undefined) this.usage = usage
    }
    if (chunk?.type === 'error') {
      const kind = finishKind(chunk.reason ?? chunk.error?.stopReason ?? 'error')
      const failure = failureOf(chunk.error) ?? failureOf(chunk)
      this.finish = { kind, ...(failure ? { failure } : {}) }
      this.usage = usageOf(chunk.error?.usage ?? chunk.usage ?? this.usage)
    }
    if (chunk?.usage) this.usage = usageOf(chunk.usage)
  }

  blocks() {
    return [
      ...(this.#text === '' ? [] : [{ type: 'text', text: this.#text }]),
      ...(this.#reasoning === '' ? [] : [{ type: 'reasoning', text: this.#reasoning }]),
      ...this.#blocks,
      ...this.#toolCalls.values(),
    ]
  }
}
