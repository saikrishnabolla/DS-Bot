import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { obj, str } from '@earendil-works/pi-schema'
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { OwnedHarness } from '../src/engine/owned-harness.js'
import { pageFromEntries, projectEntries, projectLive } from '../src/engine/projection.js'

test('projects actual Pi 1.5 user, reasoning, tool, result and assistant records', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-projection-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const echo = defineTool({
    name: 'echo',
    description: 'Echo text',
    parameters: obj({ text: str() }),
    execute: async ({ text }) => ({ output: [{ type: 'text', text: `echoed: ${text}` }], details: { echoed: true } }),
  })
  const extension = defineExtension({ name: 'projection-test', tools: [echo] })
  const registry = createRegistry()
  registry.install(extension)
  const provider = fauxProvider({ models: [{ id: 'faux-1', input: ['text', 'image'] }] })
  provider.setResponses([
    fauxAssistantMessage([fauxThinking('checking'), fauxToolCall('echo', { text: 'hello' }, { id: 'call-1' })], { stopReason: 'toolUse', timestamp: 1_700_000_000_100 }),
    fauxAssistantMessage('done', { timestamp: 1_700_000_000_200 }),
  ])
  const models = createModels()
  models.setProvider(provider.provider)
  const owned = await OwnedHarness.open({ dataDir, models, registry })
  t.after(() => owned.close())
  const id = await owned.createConversation({ model: { provider: 'faux', modelId: 'faux-1' }, extensions: [extension] })
  owned.resume()
  const submission = await owned.submit(id, {
    requestId: 'with-image',
    content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  })
  assert.equal((await submission.wait()).status, 'done')
  const page = await owned.entries(id, { limit: 20, order: 'ascending' })
  const items = projectEntries(page.items)

  assert.deepEqual(items.map(item => item.kind), ['user', 'reasoning', 'tool-call', 'tool-result', 'bot'])
  assert.deepEqual(items[0], {
    kind: 'user', text: 'hello', entryId: String(page.items[0].id), seq: page.items[0].id, time: page.items[0].model[0].timestamp,
    images: 1, attachments: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  })
  assert.equal(items[1].text, 'checking')
  assert.deepEqual({ callId: items[2].callId, name: items[2].name, arguments: items[2].arguments }, { callId: 'call-1', name: 'echo', arguments: { text: 'hello' } })
  assert.deepEqual({ callId: items[3].callId, name: items[3].name, text: items[3].text, isError: items[3].isError, details: items[3].details }, {
    callId: 'call-1', name: 'echo', text: 'echoed: hello', isError: false, details: { echoed: true },
  })
  assert.equal(items[4].text, 'done')
})

test('projects failures, reset and compaction without exposing compaction summaries as chat', () => {
  const entries = [
    { id: 10, conversationId: 2, kind: 'pi.assistant', model: [fauxAssistantMessage('partial', { stopReason: 'aborted', errorMessage: 'stopped', timestamp: 100 })] },
    { id: 11, conversationId: 2, kind: 'pi.reset' },
    { id: 12, conversationId: 2, kind: 'pi.reset', model: [{ role: 'user', content: 'handoff', timestamp: 120 }] },
    { id: 13, conversationId: 2, kind: 'pi.compaction', data: { reason: 'threshold' }, model: [{ role: 'user', content: 'private summary', timestamp: 130 }] },
  ]
  const items = projectEntries(entries, { live: { runFailure: { taskId: 19, inputs: [7], reason: 'interrupted', detail: 'host stopped' } } })
  assert.deepEqual(items.map(item => item.kind), ['bot', 'failure', 'divider', 'divider', 'user', 'divider', 'failure'])
  assert.deepEqual(items.filter(item => item.kind === 'divider').map(item => item.reason), ['reset', 'reset', 'compaction'])
  assert.equal(items.some(item => item.text === 'private summary'), false)
  assert.deepEqual(items.at(-1), { kind: 'failure', reason: 'interrupted', code: 'INTERRUPTED', detail: 'host stopped', taskId: '19', inputs: ['7'], source: 'run', entryId: 'run-failure:19' })
})

test('projects stable append-only stream events and resets a rewritten partial', () => {
  const view = (taskId, attempt, text) => ({ docs: { 'pi.live': { run: { taskId }, generation: { attempt, message: { content: [{ type: 'text', text }] } } } } })
  assert.deepEqual(projectLive({}, view(30, 1, 'hel')), [
    { phase: 'start', attemptId: '30:1' },
    { attemptId: '30:1', text: 'hel' },
  ])
  assert.deepEqual(projectLive(view(30, 1, 'hel'), view(30, 1, 'hello')), [{ attemptId: '30:1', text: 'lo' }])
  assert.deepEqual(projectLive(view(30, 1, 'hello'), view(30, 1, 'hi')), [
    { phase: 'start', attemptId: '30:1' },
    { attemptId: '30:1', text: 'hi' },
  ])
  assert.deepEqual(projectLive(view(30, 1, 'hi'), view(30, 2, 'again')), [
    { phase: 'end', attemptId: '30:1' },
    { phase: 'start', attemptId: '30:2' },
    { attemptId: '30:2', text: 'again' },
  ])
  assert.deepEqual(projectLive(view(30, 2, 'again'), { docs: { 'pi.live': {} } }), [{ phase: 'end', attemptId: '30:2' }])
})

test('pages newest records in ascending display order and stays stable after restart snapshots', () => {
  const entries = [1, 2, 3, 4].map(id => ({ id, conversationId: 2, kind: 'pi.user', model: [{ role: 'user', content: `message ${id}`, timestamp: id * 10 }] }))
  const first = pageFromEntries(entries, { limit: 2 })
  assert.deepEqual(first.items.map(item => item.text), ['message 3', 'message 4'])
  assert.deepEqual(first.cursor, { before: '3' })
  assert.deepEqual(pageFromEntries(entries, { before: first.cursor.before, limit: 2 }).items.map(item => item.text), ['message 1', 'message 2'])
  assert.deepEqual(projectEntries(entries), projectEntries(structuredClone(entries)))

  const piPage = { items: [entries[3], entries[2]], next: { after: 3, order: 'descending' } }
  assert.deepEqual(pageFromEntries(piPage).items.map(item => item.text), ['message 3', 'message 4'])
  assert.deepEqual(pageFromEntries(piPage).cursor, piPage.next)
})
