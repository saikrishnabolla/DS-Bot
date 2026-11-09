import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRuntime } from '../index.js'
import { OwnedContext } from '../src/engine/owned-context.js'

const contextFixture = async (t, options = {}) => {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'ds-bot-context-'))
  if (options.dataDir === undefined) t.after(() => rm(dataDir, { recursive: true, force: true }))
  const provider = options.provider ?? fauxProvider(options.providerOptions)
  const models = options.models ?? createModels()
  if (options.models === undefined) models.setProvider(provider.provider)
  const ctx = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  return { ctx, dataDir, models, provider }
}

test('owned context runs a Pi conversation through the session controller and projects a restart-safe page', async t => {
  const { ctx, dataDir, models, provider } = await contextFixture(t)
  provider.setResponses([fauxAssistantMessage('durable answer')])
  const { sessionId } = await ctx.sessionController.create({ workspaceId: 'default' })
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const feed = []
  const events = []
  ctx.subscribeFeed((event, data) => feed.push({ event, data }))
  ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, type: event.type }))
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  ctx.resume()

  agent.followup({ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', requestId: 'one' } })
  await ctx.sessions.flush(agent.session)
  await agent.whenIdle()

  const page = await ctx.sessionController.page({ sessionId, maxMessages: 20 })
  assert.deepEqual(page.records.map(record => record.event.type), ['user/message', 'turn/start', 'assistant/message', 'turn/end'])
  assert.equal(page.records[0].event.data.source.requestId, 'one')
  assert.equal(page.records[2].event.data.message.content[0].text, 'durable answer')
  assert.deepEqual(events.map(event => event.type), ['user/message', 'turn/start', 'assistant/message', 'turn/end'])
  assert.ok(feed.some(item => item.event === 'message' && item.data.item.kind === 'bot'))
  assert.ok(feed.some(item => item.event === 'stream' && item.data.phase === 'start'))
  assert.ok(feed.some(item => item.event === 'stream' && item.data.phase === 'end'))
  await ctx.close()

  const restarted = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  t.after(() => restarted.close())
  restarted.resume()
  const after = await restarted.sessionController.page({ sessionId, maxMessages: 20 })
  assert.deepEqual(after.records, page.records)
  const listed = await restarted.sessionController.list({})
  assert.equal(listed.items.some(item => item.sessionId === sessionId), true)
})

test('owned context adapts legacy tools per conversation and keeps exec.agent compatibility', async t => {
  const { ctx, provider } = await contextFixture(t)
  t.after(() => ctx.close())
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('echo_legacy', { text: 'hello' }, { id: 'call-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('tool complete'),
  ])
  const executions = []
  const definition = {
    name: 'echo_legacy',
    description: 'Echo text',
    parameters: { text: { type: 'string', required: true } },
    output: { render: (_args, value) => [{ type: 'text', text: `rendered ${value}` }] },
    execute: async (args, exec) => {
      executions.push({ args, agentId: exec.agent.id, callId: exec.callId, hasSignal: exec.signal instanceof AbortSignal })
      return args.text
    },
  }
  ctx.installTools([definition])
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  const dispose = agent.ctx.tools.register(definition)
  await ctx.sessions.flush(agent.session)
  ctx.resume()

  agent.followup({ content: 'use the tool', source: { kind: 'user' } })
  await agent.whenIdle()

  assert.deepEqual(executions, [{ args: { text: 'hello' }, agentId: sessionId, callId: 'call-1', hasSignal: true }])
  const page = await ctx.sessionController.page({ sessionId, maxMessages: 30 })
  assert.ok(page.records.some(record => record.event.type === 'tool/call' && record.event.data.name === 'echo_legacy'))
  const result = page.records.find(record => record.event.type === 'tool/result').event.data.message
  assert.equal(result.content[0].text, 'rendered hello')
  assert.equal(page.records.findLast(record => record.event.type === 'assistant/message').event.data.message.content[0].text, 'tool complete')
  dispose()
  await ctx.sessions.flush(agent.session)
})

test('owned context configures models, routes dispatch, publishes feed, aborts, and closes cleanly', async t => {
  const { ctx } = await contextFixture(t, { providerOptions: { tokensPerSecond: 1 } })
  const { sessionId } = await ctx.sessionController.create()
  const selected = await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  assert.deepEqual(selected, { selected: { provider: 'faux', model: 'faux-1' } })
  assert.equal((await ctx.harness.agent(sessionId)).model.modelId, 'faux-1')

  ctx.connection.fetch.register({
    path: '/api/bot', methods: ['POST'],
    fetch: async request => new Response(JSON.stringify({ ok: true, value: (await request.json()).endpoint })),
  })
  assert.deepEqual(await ctx.dispatch('state', {}), { ok: true, value: 'state' })
  const feed = []
  const unsubscribe = ctx.subscribeFeed((event, data) => feed.push({ event, data }))
  ctx.publishFeed('revision', { revision: 4 })
  unsubscribe()
  assert.deepEqual(feed, [{ event: 'revision', data: { revision: 4 } }])

  await ctx.sessionController.resolveAgent(sessionId)
  ctx.resume()
  await ctx.sessionController.prompt({ sessionId, requestId: 'slow', content: 'write a very long answer' })
  await ctx.harness.abort(sessionId, { background: true })
  await ctx.harness.waitForIdle(sessionId)
  await ctx.close()
  await ctx.close()
})

test('owned context accepts the complete DS Bot host tool catalog', async t => {
  const { ctx, dataDir } = await contextFixture(t)
  t.after(() => ctx.close())
  const rt = createRuntime(ctx, {
    home: join(dataDir, 'bot'),
    github: false,
    diagnosticsFile: false,
    browser: false,
    computer: false,
  })
  ctx.installTools(rt.teamTools, rt)

  assert.ok(rt.teamTools.length > 20)
  assert.equal(ctx.tools.schemas().some(schema => schema.name === 'list_bots'), true)
  assert.equal(ctx.tools.schemas().some(schema => schema.name === 'message_bot'), true)
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.resolveAgent(sessionId)
  assert.equal((await ctx.harness.agent(sessionId)).extensions.some(extension => extension.name === 'ds-bot-system-prompt'), true)
  await ctx.close()
})
