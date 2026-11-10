import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { createRuntime } from '../index.js'
import { OwnedContext } from '../src/engine/owned-context.js'

const contextFixture = async (t, options = {}) => {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'ds-bot-context-'))
  if (options.dataDir === undefined) t.after(() => rm(dataDir, { recursive: true, force: true }))
  const provider = options.provider ?? fauxProvider(options.providerOptions)
  const models = options.models ?? createModels()
  if (options.models === undefined) models.setProvider(provider.provider)
  const ctx = await OwnedContext.open({ dataDir, models, workspacePath: dataDir, settings: options.settings })
  return { ctx, dataDir, models, provider }
}

const legacyTool = (name, execute = async () => name) => ({
  name,
  description: `Run ${name}`,
  parameters: {},
  execute,
})

const selectedExtension = name => defineExtension({
  name: `ds-bot-${name}`,
  tools: [defineTool({
    name,
    description: `Run ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ output: [{ type: 'text', text: name }] }),
  })],
})

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

test('owned context exposes approvals through the host middleware', async t => {
  const { ctx } = await contextFixture(t)
  t.after(() => ctx.close())
  const seen = []
  ctx.on('approval/request', async (request, next) => {
    void next
    seen.push(request.reason)
    return 'allowed-once'
  })

  const outcome = await ctx.get('approval').request({ reason: 'Use the private value?' })
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(seen, ['Use the private value?'])
})

test('owned context applies legacy model middleware to main Pi generation', async t => {
  const { ctx } = await contextFixture(t)
  t.after(() => ctx.close())
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  ctx.on('llm/stream', (options, next) => {
    if (!options.messages.some(message => message.source?.handoff === true)) return next()
    return (async function* acknowledge() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Handoff received.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Handoff received.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
  ctx.resume()

  agent.followup({ content: 'continue', source: { kind: 'bot', handoff: true } })
  await agent.whenIdle()

  const page = await ctx.sessionController.page({ sessionId, maxMessages: 20 })
  assert.equal(page.records.find(record => record.event.type === 'assistant/message').event.data.message.content[0].text, 'Handoff received.')
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

test('owned context mounts Pi MCP tools and skill sections for one Bot', async t => {
  const { ctx, provider } = await contextFixture(t)
  t.after(() => ctx.close())
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', { text: 'hello' }, { id: 'call-mcp' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('MCP complete'),
  ])
  const calls = []
  const client = {
    connectionState: 'connected',
    serverInfo: { name: 'fixture', version: '1' },
    connect: async () => {},
    listTools: async () => [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: args.text }] }
    },
    close: async () => { client.connectionState = 'closed' },
  }
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  const mcp = await ctx.mountMcp({ name: 'fixture', transport: 'stdio', command: 'unused' }, { agent, client })
  const skill = ctx.mountSkill(agent, { name: 'guide', content: 'Use the fixture carefully.' })
  await Promise.all([mcp.await(), skill.await()])
  ctx.resume()

  agent.followup({ content: 'use the fixture', source: { kind: 'user' } })
  await agent.whenIdle()

  assert.deepEqual(calls, [{ name: 'echo', args: { text: 'hello' } }])
  assert.ok((await ctx.harness.agent(sessionId)).extensions.some(extension => extension.name === 'ds-bot-skill-capability-guide'))
  await Promise.all([mcp.dispose(), skill.dispose()])
  assert.equal(client.connectionState, 'closed')
})

test('owned context isolates same-named MCP tools between Bot sessions', async t => {
  const { ctx, provider } = await contextFixture(t)
  t.after(() => ctx.close())
  const calls = []
  const client = label => ({
    connectionState: 'connected',
    serverInfo: { name: 'fixture', version: '1' },
    connect: async () => {},
    listTools: async () => [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
    callTool: async (name, args) => {
      calls.push({ label, name, args })
      return { content: [{ type: 'text', text: `${label}:${args.text}` }] }
    },
    close: async () => {},
  })
  const sessionA = (await ctx.sessionController.create()).sessionId
  const sessionB = (await ctx.sessionController.create()).sessionId
  await Promise.all([
    ctx.sessionController.selectModel({ sessionId: sessionA, provider: 'faux', model: 'faux-1' }),
    ctx.sessionController.selectModel({ sessionId: sessionB, provider: 'faux', model: 'faux-1' }),
  ])
  const agentA = (await ctx.sessionController.resolveAgent(sessionA)).agent
  const agentB = (await ctx.sessionController.resolveAgent(sessionB)).agent
  const mountA = await ctx.mountMcp({ name: 'fixture', transport: 'stdio', command: 'unused' }, { agent: agentA, client: client('A') })
  const mountB = await ctx.mountMcp({ name: 'fixture', transport: 'stdio', command: 'unused' }, { agent: agentB, client: client('B') })
  await Promise.all([mountA.await(), mountB.await()])
  ctx.resume()

  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', { text: 'one' }, { id: 'call-a' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('A complete'),
  ])
  agentA.followup({ content: 'call A', source: { kind: 'user' } })
  await agentA.whenIdle()
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', { text: 'two' }, { id: 'call-b' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('B complete'),
  ])
  agentB.followup({ content: 'call B', source: { kind: 'user' } })
  await agentB.whenIdle()
  await mountA.dispose()
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', { text: 'three' }, { id: 'call-b-again' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('B still complete'),
  ])
  agentB.followup({ content: 'call B again', source: { kind: 'user' } })
  await agentB.whenIdle()

  assert.deepEqual(calls, [
    { label: 'A', name: 'echo', args: { text: 'one' } },
    { label: 'B', name: 'echo', args: { text: 'two' } },
    { label: 'B', name: 'echo', args: { text: 'three' } },
  ])
  await mountB.dispose()
})

test('owned context restricts tools per session with reference-counted idempotent lifts', async t => {
  const { ctx } = await contextFixture(t)
  t.after(() => ctx.close())
  const definition = legacyTool('scoped_fixture')
  const sessionA = (await ctx.sessionController.create()).sessionId
  const sessionB = (await ctx.sessionController.create()).sessionId
  const agentA = (await ctx.sessionController.resolveAgent(sessionA)).agent
  const agentB = (await ctx.sessionController.resolveAgent(sessionB)).agent
  agentA.ctx.tools.register(definition)
  agentB.ctx.tools.register(definition)
  await Promise.all([ctx.sessions.flush(agentA.session), ctx.sessions.flush(agentB.session)])

  const firstLift = agentA.ctx.tools.restrict({ deny: ['scoped_fixture'] })
  const secondLift = agentA.ctx.tools.restrict({ deny: ['scoped_fixture'] })
  assert.equal(ctx.tools.schemas(agentA).some(schema => schema.name === 'scoped_fixture'), false)
  assert.equal(ctx.tools.schemas(agentB).some(schema => schema.name === 'scoped_fixture'), true)
  await ctx.sessions.flush(agentA.session)
  assert.equal((await ctx.harness.agent(sessionA)).callable.some(tool => tool.name === 'scoped_fixture'), false)
  assert.equal((await ctx.harness.agent(sessionB)).callable.some(tool => tool.name === 'scoped_fixture'), true)

  firstLift()
  firstLift()
  await ctx.sessions.flush(agentA.session)
  assert.equal((await ctx.harness.agent(sessionA)).callable.some(tool => tool.name === 'scoped_fixture'), false)

  secondLift()
  await ctx.sessions.flush(agentA.session)
  assert.equal(ctx.tools.schemas(agentA).some(schema => schema.name === 'scoped_fixture'), true)
  assert.equal((await ctx.harness.agent(sessionA)).callable.some(tool => tool.name === 'scoped_fixture'), true)
})

test('owned context agent schemas merge selected global and session tools', async t => {
  const global = legacyTool('global_fixture')
  const { ctx } = await contextFixture(t, { settings: { extensions: [selectedExtension(global.name)] } })
  t.after(() => ctx.close())
  ctx.installTools([global])
  const sessionA = (await ctx.sessionController.create()).sessionId
  const sessionB = (await ctx.sessionController.create()).sessionId
  const agentA = (await ctx.sessionController.resolveAgent(sessionA)).agent
  const agentB = (await ctx.sessionController.resolveAgent(sessionB)).agent
  agentA.ctx.tools.register(legacyTool('only_a'))
  await ctx.sessions.flush(agentA.session)

  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), ['global_fixture'])
  assert.deepEqual(ctx.tools.schemas(agentA).map(schema => schema.name).sort(), ['global_fixture', 'only_a'])
  assert.deepEqual(ctx.tools.schemas(agentB).map(schema => schema.name), ['global_fixture'])

  const lift = agentA.ctx.tools.restrict({ deny: ['global_fixture'] })
  assert.deepEqual(ctx.tools.schemas(agentA).map(schema => schema.name), ['only_a'])
  assert.deepEqual(ctx.tools.schemas(agentB).map(schema => schema.name), ['global_fixture'])
  lift()
  await ctx.sessions.flush(agentA.session)
})

test('owned context denies a restricted tool execution before configuration settles', async t => {
  const { ctx } = await contextFixture(t)
  t.after(() => ctx.close())
  let executions = 0
  const definition = legacyTool('race_fixture', async () => { executions += 1; return 'ran' })
  const { sessionId } = await ctx.sessionController.create()
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  agent.ctx.tools.register(definition)
  await ctx.sessions.flush(agent.session)
  const registered = (await ctx.harness.agent(sessionId)).callable.find(tool => tool.name === 'race_fixture')

  agent.ctx.tools.restrict({ deny: ['race_fixture'] })
  const result = await registered.execute({}, { conversationId: sessionId, callId: 'direct-call' }, { abortSignal: new AbortController().signal })

  assert.equal(result.isError, true)
  assert.match(result.output[0].text, /not available/i)
  assert.equal(executions, 0)
})

test('owned context rebuilds active restrictions after restart and lets the new handle lift them', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-context-restrict-restart-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  const definition = legacyTool('restart_fixture')
  const settings = { extensions: [selectedExtension(definition.name)] }

  const first = (await contextFixture(t, { dataDir, models, settings })).ctx
  first.installTools([definition])
  first.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ deny: [definition.name] }) })
  const { sessionId } = await first.sessionController.create()
  const firstAgent = (await first.sessionController.resolveAgent(sessionId)).agent
  assert.equal(first.tools.schemas(firstAgent).some(schema => schema.name === definition.name), false)
  assert.equal((await first.harness.agent(sessionId)).callable.some(tool => tool.name === definition.name), false)
  await first.close()

  const restarted = (await contextFixture(t, { dataDir, models, settings })).ctx
  t.after(() => restarted.close())
  restarted.installTools([definition])
  let lift
  restarted.on('agent/created', ({ agent }) => { lift = agent.ctx.tools.restrict({ deny: [definition.name] }) })
  const restartedAgent = (await restarted.sessionController.resolveAgent(sessionId)).agent
  assert.equal(restarted.tools.schemas(restartedAgent).some(schema => schema.name === definition.name), false)
  assert.equal((await restarted.harness.agent(sessionId)).callable.some(tool => tool.name === definition.name), false)

  lift()
  await restarted.sessions.flush(restartedAgent.session)
  assert.equal(restarted.tools.schemas(restartedAgent).some(schema => schema.name === definition.name), true)
  assert.equal((await restarted.harness.agent(sessionId)).callable.some(tool => tool.name === definition.name), true)
})

test('owned context transforms every external model request and bridges scripted models', async t => {
  const models = createModels()
  const provider = fauxProvider()
  models.setProvider(provider.provider)
  const requests = []
  const streamSimple = models.streamSimple.bind(models)
  const completeSimple = models.completeSimple.bind(models)
  models.streamSimple = (model, context, options) => {
    requests.push({ kind: 'stream', context, options })
    return streamSimple(model, context, options)
  }
  models.completeSimple = async (model, context, options) => {
    requests.push({ kind: 'complete', context, options })
    return completeSimple(model, context, options)
  }
  const { ctx } = await contextFixture(t, { models, provider })
  t.after(() => ctx.close())
  const transformed = []
  ctx.llm.beforeRequest((messages, { conversationId }) => {
    transformed.push(conversationId)
    return messages.map(message => ({
      ...message,
      content: message.content.map(block => block.type === 'text' ? { ...block, text: block.text.replaceAll('TOP_SECRET', '[secret]') } : block),
    }))
  })
  const { sessionId } = await ctx.sessionController.create()
  await ctx.sessionController.selectModel({ sessionId, provider: 'faux', model: 'faux-1' })
  const { agent } = await ctx.sessionController.resolveAgent(sessionId)
  provider.setResponses([fauxAssistantMessage('redacted')])
  ctx.resume()
  agent.followup({ content: 'TOP_SECRET in stream', source: { kind: 'user' } })
  await agent.whenIdle()

  const model = ctx.harness.models.getModel('faux', 'faux-1')
  provider.setResponses([fauxAssistantMessage('compacted')])
  await ctx.harness.models.completeSimple(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'TOP_SECRET in compaction' }], timestamp: Date.now() }],
  }, { sessionId })

  const relayCalls = []
  const relay = ctx.llm.script('group-relay-test', ({ context }) => {
    relayCalls.push(context)
    return { content: [{ type: 'text', text: 'scripted relay' }], stopReason: 'stop' }
  })
  const streamedRelay = await ctx.llm.stream({
    provider: relay.provider,
    model: relay.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'TOP_SECRET stays internal' }], timestamp: Date.now() }],
  }).result()
  const relayModel = ctx.harness.models.getModel(relay.provider, relay.model)
  const completedRelay = await ctx.harness.models.completeSimple(relayModel, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'complete relay' }], timestamp: Date.now() }],
  })

  assert.equal(requests[0].context.messages[0].content[0].text, '[secret] in stream')
  assert.equal(requests[1].context.messages[0].content[0].text, '[secret] in compaction')
  assert.deepEqual(transformed, [sessionId, undefined])
  assert.equal(streamedRelay.content[0].text, 'scripted relay')
  assert.equal(completedRelay.content[0].text, 'scripted relay')
  assert.equal(relayCalls[0].messages[0].content[0].text, 'TOP_SECRET stays internal')
  relay.dispose()
})
