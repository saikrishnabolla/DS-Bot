import assert from 'node:assert/strict'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { BlockAssembler } from '../src/engine/messages.js'

test('the compatibility assembler consumes native Pi stream events', async () => {
  const provider = fauxProvider()
  provider.setResponses([fauxAssistantMessage('hello')])
  const models = createModels()
  models.setProvider(provider.provider)
  const assembler = new BlockAssembler()
  for await (const event of models.stream(models.getModel('faux', 'faux-1'), {
    messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
  })) assembler.push(event)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'hello' }])
  assert.equal(assembler.finish.kind, 'stop')
  assert.equal(assembler.usage.totalTokens, 4)
})

test('the compatibility assembler projects Pi tool calls', async () => {
  const provider = fauxProvider()
  provider.setResponses([fauxAssistantMessage([fauxToolCall('search', { q: 'pi' }, { id: 'call-1' })], { stopReason: 'toolUse' })])
  const models = createModels()
  models.setProvider(provider.provider)
  const assembler = new BlockAssembler()
  for await (const event of models.stream(models.getModel('faux', 'faux-1'), {
    messages: [{ role: 'user', content: 'search', timestamp: Date.now() }],
  })) assembler.push(event)
  assert.deepEqual(assembler.blocks(), [{ type: 'tool-call', id: 'call-1', name: 'search', arguments: { q: 'pi' } }])
  assert.equal(assembler.finish.kind, 'tool-calls')
})
