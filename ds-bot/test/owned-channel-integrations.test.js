import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'
import { readZip } from '../src/office/zip.js'

async function fixture(t, { browser = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-owned-channel-integrations-'))
  const dataDir = join(root, 'data')
  const uiDir = join(root, 'ui')
  const workspacePath = join(root, 'workspace')
  await Promise.all([mkdir(dataDir), mkdir(uiDir), mkdir(workspacePath)])
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')
  let host
  let call
  let faux

  const open = async () => {
    const models = await ModelRuntime.create({
      authPath: join(dataDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    })
    faux = fauxProvider()
    faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage('Ready.')))
    models.registerNativeProvider(faux.provider)
    await models.refresh({ allowNetwork: false })
    const priorApp = process.env.DS_BOT_APP
    if (browser) process.env.DS_BOT_APP = '1'
    try {
      host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath })
    } finally {
      if (priorApp === undefined) delete process.env.DS_BOT_APP
      else process.env.DS_BOT_APP = priorApp
    }
    const launch = await fetch(host.launchUrl, { redirect: 'manual' })
    assert.equal(launch.status, 303)
    const cookie = launch.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    call = async (endpoint, payload = {}) => {
      const response = await fetch(`${host.origin}/api/bot`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      })
      assert.equal(response.status, 200)
      return response.json()
    }
  }
  const close = async () => {
    if (host === undefined) return
    await host.close()
    host = undefined
    call = undefined
  }
  const restart = async () => {
    await close()
    await open()
  }
  const state = async () => {
    const result = await call('state', { locale: 'en' })
    assert.equal(result.ok, true, result.error?.message)
    return result.value
  }
  t.after(async () => {
    await close()
    await rm(root, { recursive: true, force: true })
  })
  await open()
  return {
    root,
    dataDir,
    restart,
    state,
    host: () => host,
    faux: () => faux,
    call: (...args) => call(...args),
  }
}

const ok = result => {
  assert.equal(result.ok, true, result.error?.message)
  return result.value
}

const userQueue = items => items.filter(item => item.source.kind === 'user')

const refused = (result, message) => {
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/refused')
  assert.match(result.error.message, message)
}

async function requestSecret(env, botId, name, purpose) {
  const runtime = env.host().runtime
  const tool = runtime.teamTools.find(entry => entry.name === 'request_secret')
  assert.ok(tool)
  const agent = await runtime.resolveAgent(runtime.chatOf(botId))
  const text = await tool.execute({ name, purpose }, {
    agent,
    callId: `request-${name.toLowerCase()}`,
    concludeTurn() {},
  })
  assert.match(text, /card asking the user/)
  const requests = (await env.state()).secretRequests[botId]
  return requests.at(-1)
}

test('owned Host persists provider keys, Agent sessions and secret decisions across restart', async t => {
  const env = await fixture(t)
  let state = await env.state()
  const chief = state.bots[0]
  const writer = ok(await env.call('create-bot', {
    name: 'Writer', role: 'Write', model: 'faux/faux-1',
  }))
  const chiefPermission = ok(await env.call('agent-command', { sessionId: env.host().runtime.chatOf(chief.id), line: '/permission' }))
  assert.equal(chiefPermission.command, 'permission')

  let providers = ok(await env.call('provider-key', {
    provider: 'anthropic', value: 'sk-owned-integration',
  }))
  assert.equal(providers.providers.find(provider => provider.id === 'anthropic')?.key.configured, true)

  env.host().runtime.defaultModel = async () => 'faux/faux-1'
  const agent = ok(await env.call('add-agent'))
  assert.deepEqual((await env.host().runtime.ctx.harness.agent(agent.sessions[0])).model, { provider: 'faux', modelId: 'faux-1' })
  const compaction = env.host().runtime.ctx.get('compaction')
  const compactNow = compaction.compactNow
  let compacted
  compaction.compactNow = async target => { compacted = target.session.id }
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/compact' })), { command: 'compact' })
  compaction.compactNow = compactNow
  assert.equal(compacted, agent.sessions[0])
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/plan' })), { command: 'plan', active: true })
  const plainAgent = await env.host().runtime.resolveAgent(agent.sessions[0])
  assert.deepEqual(await env.host().runtime.ctx.get('planMode').get(plainAgent), { active: true, entered: true })
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/plan' })), { command: 'plan', active: true })
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/plan off' })), { command: 'plan', active: false })
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/plan Check the risky path' })), { command: 'plan', active: true })
  await plainAgent.whenIdle()
  assert.equal((await env.host().runtime.ctx.harness.context(agent.sessions[0])).messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === 'Check the risky path')), true)
  const reference = await env.host().runtime.ctx.get('attachments').saveFile({ data: Buffer.from('command attachment'), name: 'command.txt', mediaType: 'text/plain' })
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/plan Review the attachment', content: [{ type: 'file', attachment: reference }] })), { command: 'plan', active: true })
  await plainAgent.whenIdle()
  const planEntries = await env.host().runtime.ctx.harness.entries(agent.sessions[0], { limit: 100, order: 'ascending' })
  const planAttachment = planEntries.items.find(item => item.data?.content?.some(block => block.type === 'text' && block.text === 'Review the attachment'))
  assert.equal(planAttachment.data.content[0].type, 'file')
  const permissionMenu = ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/permission' }))
  assert.equal(permissionMenu.permission, 'workspace-write')
  assert.deepEqual(permissionMenu.permissions.options.map(option => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/permission read-only' })), { command: 'permission', permission: 'read-only' })
  assert.equal(env.host().runtime.ctx.get('permissionPresets').get(plainAgent.session), 'read-only')
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/model faux/faux-1' })), { command: 'model', model: 'faux/faux-1' })
  const goal = ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal Ship the demo', content: [{ type: 'file', attachment: reference }] }))
  assert.equal(goal.goal.objective, 'Ship the demo')
  await plainAgent.whenIdle()
  const goalEntries = await env.host().runtime.ctx.harness.entries(agent.sessions[0], { limit: 100, order: 'ascending' })
  const goalAttachment = goalEntries.items.find(item => item.data?.content?.some(block => block.type === 'text' && block.text === 'Reference attachments for the goal objective.'))
  assert.equal(goalAttachment.data.content[0].type, 'file')
  const refusedReplacement = await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal Replace it silently' })
  assert.equal(refusedReplacement.ok, false)
  assert.match(refusedReplacement.error.message, /already active/)
  const edited = ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal edit Ship the verified demo' }))
  assert.equal(edited.goal.objective, 'Ship the verified demo')
  assert.equal(edited.goal.id, goal.goal.id)
  const paused = ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal pause' }))
  assert.equal(paused.goal.phase, 'paused')
  const resumed = ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal resume' }))
  assert.equal(resumed.goal.phase, 'active')
  assert.equal(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal clear' })).goal, null)
  assert.equal(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal pause after verification' })).goal.objective, 'pause after verification')
  assert.equal(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal clear' })).goal, null)
  assert.equal(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/goal clear' })).text, 'No goal to clear.')
  const exported = ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/export' }))
  assert.equal(exported.download.type, 'application/zip')
  const members = readZip(Buffer.from(exported.download.base64, 'base64'))
  assert.deepEqual(members.map(member => member.name), ['session.v4.jsonl'])
  const log = members[0].data.toString('utf8')
  assert.match(log, /"conversationId"/)
  assert.match(log, /Check the risky path/)
  const unknown = await env.call('agent-command', { sessionId: agent.sessions[0], line: '/does-not-exist' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bot/invalid')
  assert.equal(ok(await env.call('send', { sessionId: agent.sessions[0], text: 'Plain Agent prompt' })), true)
  const resolvedAgent = await env.host().runtime.ctx.sessionController.resolveAgent(agent.sessions[0])
  await resolvedAgent.agent.whenIdle()
  const agentChat = ok(await env.call('agent-chat', { sessionId: agent.sessions[0] }))
  assert.deepEqual(agentChat.items.filter(item => item.kind === 'user' || item.kind === 'bot').map(item => [item.kind, item.text]).slice(-2), [
    ['user', 'Plain Agent prompt'],
    ['bot', 'Ready.'],
  ])
  let planInterrupted = false
  env.faux().setResponses([async (_context, options) => {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2_000)
      options?.signal?.addEventListener('abort', () => { planInterrupted = true; clearTimeout(timer); resolve() }, { once: true })
    })
    return fauxAssistantMessage('This plan answer should be interrupted.')
  }, fauxAssistantMessage('Planned with the new direction.')])
  assert.equal(ok(await env.call('send', { sessionId: agent.sessions[0], text: 'Start slow planning work' })), true)
  const planDeadline = Date.now() + 2_000
  while ((await env.host().runtime.ctx.sessionController.resolveAgent(agent.sessions[0])).agent.status !== 'running') {
    if (Date.now() >= planDeadline) assert.fail('Agent session did not start running')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(ok(await env.call('agent-command', { sessionId: agent.sessions[0], line: '/plan Redirect the active turn' })), { command: 'plan', active: true })
  await resolvedAgent.agent.whenIdle()
  assert.equal(planInterrupted, true)
  const planContext = await env.host().runtime.ctx.harness.context(agent.sessions[0])
  assert.equal(planContext.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === 'Redirect the active turn')), true)
  assert.equal(planContext.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('/plan'))), false)

  env.faux().setResponses([async (_context, options) => {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2_000)
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    return fauxAssistantMessage('This answer should be stopped.')
  }])
  assert.equal(ok(await env.call('send', { sessionId: agent.sessions[0], text: 'Start slow Agent work' })), true)
  const runningDeadline = Date.now() + 2_000
  while ((await env.host().runtime.ctx.sessionController.resolveAgent(agent.sessions[0])).agent.status !== 'running') {
    if (Date.now() >= runningDeadline) assert.fail('Agent session did not start running')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(ok(await env.call('stop-agent-work', { sessionId: agent.sessions[0] })), true)
  await resolvedAgent.agent.whenIdle()
  assert.equal(resolvedAgent.agent.status, 'idle')
  const agentRows = ok(await env.call('agent-sessions'))
  assert.deepEqual(agentRows.ids, [agent.sessions[0]])
  assert.equal(agentRows.byId[agent.sessions[0]].running, false)
  const second = ok(await env.call('agent-session', { agentId: agent.id }))
  const workspaceId = (await env.state()).workspaceId
  const plain = await env.host().runtime.ctx.sessionController.create({ workspaceId })
  assert.deepEqual(ok(await env.call('agent-adopt', {
    agentId: agent.id, sessionId: plain.sessionId,
  })), { sessionId: plain.sessionId })
  assert.equal(ok(await env.call('agent-rename', {
    agentId: agent.id, sessionId: agent.sessions[0], title: 'Integration scratch',
  })), true)
  assert.equal(ok(await env.call('agent-archive', {
    agentId: agent.id, sessionId: second.sessionId,
  })), true)

  const fill = await requestSecret(env, writer.id, 'INTEGRATION_TOKEN', 'Exercise the owned secret boundary')
  let secret = ok(await env.call('secret-set', {
    requestId: fill.id, value: 'owned-secret-value', scope: 'bot',
  }))
  assert.deepEqual(secret.scope, [writer.id])
  const allow = await requestSecret(env, chief.id, 'INTEGRATION_TOKEN', 'Use the saved integration token')
  secret = ok(await env.call('secret-allow', { requestId: allow.id }))
  assert.deepEqual(new Set(secret.scope), new Set([writer.id, chief.id]))
  const cancel = await requestSecret(env, writer.id, 'CANCEL_TOKEN', 'Exercise cancellation')
  assert.equal(ok(await env.call('secret-cancel', { requestId: cancel.id })), true)
  secret = ok(await env.call('secret-update', {
    name: 'INTEGRATION_TOKEN', scope: [chief.id], purpose: 'Updated purpose',
  }))
  assert.deepEqual(secret.scope, [chief.id])
  assert.equal(secret.purpose, 'Updated purpose')

  await env.restart()
  state = await env.state()
  providers = ok(await env.call('providers'))
  assert.equal(providers.providers.find(provider => provider.id === 'anthropic')?.key.configured, true)
  assert.deepEqual(state.agents.map(entry => entry.id), [agent.id])
  assert.deepEqual(state.agents[0].sessions, [agent.sessions[0], plain.sessionId])
  assert.equal(state.secrets.find(entry => entry.name === 'INTEGRATION_TOKEN')?.purpose, 'Updated purpose')
  assert.equal(JSON.stringify(state).includes('owned-secret-value'), false)

  assert.equal(ok(await env.call('secret-delete', { name: 'INTEGRATION_TOKEN' })), true)
  assert.equal(ok(await env.call('remove-agent', { agentId: agent.id })).agents.length, 0)
  providers = ok(await env.call('provider-key', { provider: 'anthropic', value: null }))
  assert.equal(providers.providers.some(provider => provider.id === 'anthropic'), false)
})

test('saving a provider key clears that provider\'s credential block', async t => {
  const env = await fixture(t)
  const chief = (await env.state()).bots[0]
  env.host().runtime.state.bots[chief.id].blocked = {
    code: 'AUTH', provider: 'anthropic', status: 401, at: 1,
  }

  ok(await env.call('provider-key', { provider: 'anthropic', value: 'sk-replaced' }))

  assert.equal((await env.state()).bots.find(bot => bot.id === chief.id).blocked, undefined)
})

test('a second private-chat send queues for the next turn by default', async t => {
  const env = await fixture(t)
  const callsBeforeCreate = env.faux().state.callCount
  const writer = ok(await env.call('create-bot', {
    name: 'Writer', role: 'Write', model: 'faux/faux-1',
  }))
  const kickoffDeadline = Date.now() + 5_000
  while (env.faux().state.callCount === callsBeforeCreate) {
    if (Date.now() >= kickoffDeadline) assert.fail('Writer kickoff did not start')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const sessionId = env.host().runtime.chatOf(writer.id)
  const { agent: writerAgent } = await env.host().runtime.ctx.sessionController.resolveAgent(sessionId)
  await writerAgent.whenIdle()
  let release
  let started
  const running = new Promise(resolve => { started = resolve })
  t.after(() => release?.())
  env.faux().setResponses([
    async () => {
      started()
      await new Promise(resolve => { release = resolve })
      return fauxAssistantMessage('First answer.')
    },
    fauxAssistantMessage('Second answer.'),
  ])

  assert.equal(ok(await env.call('send', { sessionId, text: 'First message' })), true)
  await running
  assert.equal(ok(await env.call('send', { sessionId, text: 'Second message' })), true)

  const watch = await env.host().runtime.ctx.harness.watch(sessionId, { min: 1, max: 20 })
  t.after(() => watch.stop())
  const modes = watch.value.docs['pi.inbox'].items
    .filter(item => item.entry?.data?.source?.kind === 'user')
    .map(item => item.mode)
  const queue = ok(await env.call('queue', { sessionId }))
  release()
  await writerAgent.whenIdle()
  assert.deepEqual(modes, ['followUp'])
  assert.deepEqual(userQueue(queue['next-turn']).map(item => [item.source.kind, item.content[0].text, item.mode]), [
    ['user', 'Second message', 'followUp'],
  ])
  const chat = ok(await env.call('chat', { botId: writer.id }))
  const rows = chat.items.filter(item => item.kind === 'user' || item.kind === 'bot').map(item => [item.kind, item.text])
  const first = rows.findIndex(item => item[0] === 'user' && item[1] === 'First message')
  assert.notEqual(first, -1)
  assert.deepEqual(rows.slice(first), [
    ['user', 'First message'],
    ['bot', 'First answer.'],
    ['user', 'Second message'],
    ['bot', 'Second answer.'],
  ])
})

test('queued private-chat messages can be edited, removed and explicitly steered', async t => {
  const env = await fixture(t)
  const writer = ok(await env.call('create-bot', {
    name: 'Writer', role: 'Write', model: 'faux/faux-1',
  }))
  let release
  let started
  t.after(() => release?.())
  const running = new Promise(resolve => { started = resolve })
  env.faux().setResponses([
    async () => {
      started()
      await new Promise(resolve => { release = resolve })
      return fauxAssistantMessage('First answer.')
    },
    fauxAssistantMessage('Steered answer.'),
  ])

  const sessionId = env.host().runtime.chatOf(writer.id)
  assert.equal(ok(await env.call('send', { sessionId, text: 'First message' })), true)
  await running
  try {
    assert.equal(ok(await env.call('send', { sessionId, text: 'Second message' })), true)
    let queue = userQueue(ok(await env.call('queue', { sessionId }))['next-turn'])
    assert.equal(queue.length, 1)

    ok(await env.call('queue-update', {
      sessionId,
      itemId: queue[0].id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'Edited message' }] },
    }))
    queue = userQueue(ok(await env.call('queue', { sessionId }))['next-turn'])
    assert.deepEqual(queue.map(item => [item.content[0].text, item.mode]), [['Edited message', 'followUp']])

    assert.equal(ok(await env.call('send', { sessionId, text: 'Delete this message' })), true)
    queue = userQueue(ok(await env.call('queue', { sessionId }))['next-turn'])
    assert.equal(queue.length, 2)
    ok(await env.call('queue-update', {
      sessionId,
      itemId: queue.find(item => item.content[0].text === 'Delete this message').id,
      action: { kind: 'remove' },
    }))
    queue = userQueue(ok(await env.call('queue', { sessionId }))['next-turn'])
    assert.deepEqual(queue.map(item => item.content[0].text), ['Edited message'])

    ok(await env.call('queue-update', {
      sessionId,
      itemId: queue[0].id,
      action: { kind: 'steer' },
    }))
    queue = userQueue(ok(await env.call('queue', { sessionId }))['next-turn'])
    assert.deepEqual(queue.map(item => [item.content[0].text, item.mode]), [['Edited message', 'steer']])
  } finally {
    release?.()
  }
  const { agent } = await env.host().runtime.ctx.sessionController.resolveAgent(sessionId)
  await agent.whenIdle()
  const chat = ok(await env.call('chat', { botId: writer.id }))
  const text = chat.items.filter(item => item.kind === 'user' || item.kind === 'bot').map(item => item.text)
  assert.deepEqual(text, ['First message', 'First answer.', 'Edited message', 'Steered answer.'])
})

test('owned Host persists connector settings, mail rules and capability attachments without external credentials', async t => {
  const env = await fixture(t)
  const state = await env.state()
  const chief = state.bots[0]

  refused(await env.call('connector-connect', { id: 'amap' }), /Paste a key first/)
  refused(await env.call('connector-sign-in-code', { id: 'notion', input: 'code' }), /No sign-in is waiting/)
  const scanned = ok(await env.call('connector-import-scan'))
  assert.ok(Array.isArray(scanned))
  const imported = ok(await env.call('connector-import', { items: [] }))
  assert.deepEqual(imported.created, [])

  let connectors = ok(await env.call('connector-add', {
    name: 'Fixture MCP', url: 'http://127.0.0.1:1/mcp',
  }))
  const custom = connectors.connectors.find(entry => entry.custom === true)
  assert.ok(custom)
  connectors = ok(await env.call('connector-set', { id: custom.id, offFor: [chief.id] }))
  assert.deepEqual(connectors.connectors.find(entry => entry.id === custom.id).offFor, [chief.id])
  connectors = ok(await env.call('connector-retry', { id: custom.id }))
  assert.ok(connectors.connectors.some(entry => entry.id === custom.id))

  refused(await env.call('mail-account-add', { address: 'not-an-address' }), /Enter an email address/)
  refused(await env.call('mail-account-remove', { id: 'missing' }), /No such account/)
  refused(await env.call('mail-send-answer', { requestId: 'missing', choice: 'cancel' }), /already answered/)
  let mail = ok(await env.call('mail-rule-set', {
    mode: 'no-draft', botId: chief.id, addRecipient: 'allowed@example.test',
  }))
  assert.deepEqual(mail.noDraftFor, [chief.id])
  assert.deepEqual(mail.allowedRecipients, ['allowed@example.test'])

  let capability = ok(await env.call('capability-save', {
    name: 'release-guide', kind: 'skill', description: 'Release checks', content: 'Run the release checks.',
  }))
  assert.equal(capability.kind, 'skill')
  assert.deepEqual(ok(await env.call('bot-capability', {
    botId: chief.id, name: capability.name, attached: true,
  })), [capability.name])
  const pending = await env.host().runtime.capabilitySave({
    name: 'pending-mcp', kind: 'mcp', transport: 'stdio', command: process.execPath,
    args: ['--version'], env: {}, description: 'Approval fixture',
  }, { botId: chief.id })
  assert.equal(pending.approved, false)
  capability = ok(await env.call('capability-approve', { name: pending.name }))
  assert.equal(capability.approved, true)

  assert.deepEqual(ok(await env.call('local-agent-models', { route: 'not-a-local-agent' })), [])

  await env.restart()
  const restarted = await env.state()
  assert.deepEqual(restarted.connectors.mail.noDraftFor, [chief.id])
  assert.deepEqual(restarted.connectors.mail.allowedRecipients, ['allowed@example.test'])
  assert.deepEqual(restarted.bots.find(bot => bot.id === chief.id).capabilities, ['release-guide'])
  assert.equal(restarted.capabilities.find(item => item.name === 'pending-mcp')?.approved, true)
  assert.deepEqual(restarted.connectors.connectors.find(entry => entry.id === custom.id)?.offFor, [chief.id])

  connectors = ok(await env.call('connector-disconnect', { id: custom.id }))
  assert.equal(connectors.connectors.some(entry => entry.id === custom.id), false)
  assert.deepEqual(ok(await env.call('bot-capability', {
    botId: chief.id, name: 'release-guide', attached: false,
  })), [])
  assert.equal(ok(await env.call('capability-delete', { name: 'release-guide' })), true)
  assert.equal(ok(await env.call('capability-delete', { name: 'pending-mcp' })), true)
})

test('owned Host browser operations exchange a real read and preserve takeover holds', async t => {
  const env = await fixture(t, { browser: true })
  const state = await env.state()
  const chief = state.bots[0]
  assert.equal(state.browser, true)

  assert.equal(ok(await env.call('browser-takeover', { botId: chief.id })), true)
  let poll = ok(await env.call('browser-wait', {
    clientId: 'desktop-window',
    open: { [chief.id]: { url: 'https://example.test/', title: 'Example' } },
  }))
  assert.equal(poll.holds[chief.id].reason, 'takeover')

  const runtime = env.host().runtime
  const read = runtime.teamTools.find(entry => entry.name === 'read_browser')
  assert.ok(read)
  const agent = await runtime.resolveAgent(runtime.chatOf(chief.id))
  const reading = read.execute({}, { agent })
  poll = ok(await env.call('browser-wait', {
    clientId: 'desktop-window',
    open: { [chief.id]: { url: 'https://example.test/', title: 'Example' } },
  }))
  assert.equal(poll.requests.length, 1)
  assert.equal(poll.requests[0].botId, chief.id)
  assert.equal(ok(await env.call('browser-result', {
    id: poll.requests[0].id,
    ok: true,
    page: {
      url: 'https://example.test/', title: 'Example', text: '# Browser proof',
      items: [{ role: 'link', name: 'Details', href: 'https://example.test/details' }],
    },
  })), true)
  assert.match(await reading, /Browser proof/)

  assert.equal(ok(await env.call('browser-give-back', { botId: chief.id })), true)
  assert.equal(ok(await env.call('browser-stop', { botId: chief.id })), true)
  poll = ok(await env.call('browser-wait', {
    clientId: 'desktop-window',
    open: { [chief.id]: { url: 'https://example.test/', title: 'Example' } },
  }))
  assert.equal(poll.holds[chief.id].reason, 'stopped')
  assert.equal(ok(await env.call('browser-give-back', { botId: chief.id })), true)
})

test('owned Host persists disabled IM routing while network-bound setup stays at typed boundaries', async t => {
  const env = await fixture(t)
  const chief = (await env.state()).bots[0]
  const writer = ok(await env.call('create-bot', {
    name: 'Writer', role: 'Write', model: 'faux/faux-1',
  }))

  refused(await env.call('im-add', {
    platform: 'telegram', botId: chief.id, fields: {},
  }), /Bot token is required/)
  refused(await env.call('im-login-start', {
    platform: 'telegram', botId: chief.id,
  }), /no QR login/)
  refused(await env.call('im-login-wait', {
    platform: 'telegram', botId: chief.id, loginId: 'missing',
  }), /no QR login/)

  const id = 'im_fixture'
  env.host().runtime.state.im = {
    connections: {
      [id]: {
        id,
        platform: 'telegram',
        account: { id: 'fixture', name: 'Fixture' },
        botId: chief.id,
        settings: {},
        secrets: {},
        enabled: false,
        paired: [],
        requests: [{ id: 'u1', name: 'User One', chatKey: 'dm-u1', chatKind: 'direct', at: 1 }],
        chats: { group: { kind: 'group', title: 'Fixture group', at: 1 } },
        createdAt: 1,
      },
    },
  }
  await env.host().runtime.save()

  let connection = ok(await env.call('im-update', {
    id, botId: writer.id, enabled: false,
  }))
  assert.equal(connection.botId, writer.id)
  assert.equal(connection.enabled, false)
  assert.equal(ok(await env.call('im-pair', { id, senderId: 'u1', allow: true })), true)
  assert.equal(ok(await env.call('im-chat', {
    id, chatKey: 'group', target: { botId: chief.id },
  })), true)

  await env.restart()
  connection = (await env.state()).im.connections.find(entry => entry.id === id)
  assert.equal(connection.botId, writer.id)
  assert.equal(connection.paired[0].id, 'u1')
  assert.deepEqual(connection.chats.group.target, { botId: chief.id })
  assert.equal(ok(await env.call('im-retry', { id })), true)
  assert.equal(ok(await env.call('im-remove', { id })), true)

  await env.restart()
  assert.equal((await env.state()).im.connections.some(entry => entry.id === id), false)
})
