const contentOf = value => (Array.isArray(value) ? value : [{ type: 'text', text: String(value ?? '') }])

export const createUserMessage = ({ content, source, timestamp = Date.now() }) => ({ role: 'user', content: contentOf(content), ...(source === undefined ? {} : { source }), timestamp })
export const createAssistantMessage = ({ content, provider, model, usage, stopReason, timestamp = Date.now() }) => ({ role: 'assistant', content: contentOf(content), ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}), timestamp })
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

export class BlockAssembler {
  #blocks = []
  #text = ''
  finish = { kind: 'stop' }
  usage

  push(chunk) {
    const text = textDelta(chunk)
    if (text !== '') this.#text += text
    if (chunk?.type === 'tool-call' || chunk?.type === 'tool_call' || chunk?.type === 'toolcall_end') {
      const call = chunk.toolCall ?? chunk
      this.#blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
    }
    if (chunk?.type === 'done' || chunk?.type === 'finish') {
      const reason = chunk.reason ?? chunk.stopReason ?? 'stop'
      this.finish = { kind: reason === 'toolUse' || reason === 'tool_calls' ? 'tool-calls' : String(reason) }
      this.usage = chunk.usage ?? chunk.message?.usage
    }
    if (chunk?.type === 'error') this.finish = { kind: 'error', error: chunk.error }
    if (chunk?.usage) this.usage = chunk.usage
  }

  blocks() {
    return [...(this.#text === '' ? [] : [{ type: 'text', text: this.#text }]), ...this.#blocks]
  }
}
