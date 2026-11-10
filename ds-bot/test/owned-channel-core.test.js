import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'

const waitFor = async (check, timeout = 5_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the owned channel flow')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-owned-channel-core-'))
  const dataDir = join(root, 'data')
  const uiDir = join(root, 'ui')
  const workspacePath = join(root, 'workspace')
  await Promise.all([mkdir(dataDir), mkdir(uiDir), mkdir(workspacePath)])
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Cue</title>')
  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 300 }, () => fauxAssistantMessage('Ready.')))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })
  let host
  let call

  const open = async () => {
    host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath })
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
    return host
  }
  const close = async () => {
    if (host === undefined) return
    await host.close()
    host = undefined
    call = undefined
  }
  const restart = async () => {
    await close()
    return open()
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
    root, dataDir, workspacePath, faux, restart, close, state,
    host: () => host,
    call: (...args) => call(...args),
  }
}

const ok = result => {
  assert.equal(result.ok, true, result.error?.message)
  return result.value
}

const png = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 7),
]).toString('base64')}`

test('owned Host reports the built-in plugins mounted in its real session runtime', async t => {
  const env = await fixture(t)
  const inventory = ok(await env.call('plugin-inventory'))

  assert.equal(inventory.defaultPreset, 'standard')
  assert.deepEqual(inventory.presets.map(row => row.id), ['standard', 'ptc', 'minimal', 'creator'])
  assert.ok(Array.isArray(inventory.session))
  assert.ok(inventory.session.length > 0)
  assert.ok(inventory.session.some(row => row.id === 'read' && row.state === 'active'))
  assert.ok(inventory.session.some(row => (row.id === 'bash' || row.id === 'pwsh') && row.state === 'active'))
  assert.ok(inventory.session.some(row => row.id === 'web_search' && row.state === 'active'))
  for (const row of inventory.session) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.title, 'string')
    assert.equal(typeof row.description, 'string')
    assert.equal(row.scope, 'session')
  }
})

test('owned Agent presets persist the new-session default and apply it to created sessions', async t => {
  const env = await fixture(t)
  let presets = ok(await env.call('agent-presets'))
  assert.equal(presets.defaultPreset, 'standard')
  assert.deepEqual(presets.rows.map(row => row.id), ['standard', 'ptc', 'minimal', 'creator'])

  presets = ok(await env.call('agent-preset-default', { id: 'minimal' }))
  assert.equal(presets.defaultPreset, 'minimal')
  const agent = ok(await env.call('add-agent'))
  assert.equal(env.host().runtime.agentPresetOf(agent.sessions[0]), 'minimal')

  await env.restart()
  presets = ok(await env.call('agent-presets'))
  assert.equal(presets.defaultPreset, 'minimal')
  const restarted = (await env.state()).agents[0]
  assert.equal(env.host().runtime.agentPresetOf(restarted.sessions[0]), 'minimal')

  const refused = await env.call('agent-preset-default', { id: 'unknown' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Unknown Agent preset/)
})

test('owned Creator action starts a Creator session without changing the default', async t => {
  const env = await fixture(t)
  ok(await env.call('agent-preset-default', { id: 'minimal' }))

  const first = ok(await env.call('agent-preset-start', { id: 'creator' }))
  assert.equal(env.host().runtime.agentPresetOf(first.sessionId), 'creator')
  assert.equal(ok(await env.call('agent-presets')).defaultPreset, 'minimal')

  const second = ok(await env.call('agent-preset-start', { id: 'creator' }))
  assert.equal(second.agentId, first.agentId)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(env.host().runtime.agentPresetOf(second.sessionId), 'creator')
  assert.equal((await env.state()).agents.length, 1)
})

test('owned custom Agent preset API persists modes and resets a removed default', async t => {
  const env = await fixture(t)
  let presets = ok(await env.call('agent-preset-save', {
    id: 'review',
    name: 'Review mode',
    description: 'Review without editing.',
    tools: ['read', 'web_search'],
    instructions: 'Cite file and line evidence. Do not edit files.',
  }))
  assert.equal(presets.rows.find(row => row.id === 'review')?.group, 'custom')

  presets = ok(await env.call('agent-preset-default', { id: 'review' }))
  assert.equal(presets.defaultPreset, 'review')
  const agent = ok(await env.call('add-agent'))
  assert.equal(env.host().runtime.agentPresetOf(agent.sessions[0]), 'review')

  await env.restart()
  presets = ok(await env.call('agent-presets'))
  assert.equal(presets.defaultPreset, 'review')
  assert.equal(presets.rows.some(row => row.id === 'review'), true)

  presets = ok(await env.call('agent-preset-delete', { id: 'review' }))
  assert.equal(presets.defaultPreset, 'standard')
  assert.equal(presets.rows.some(row => row.id === 'review'), false)
  await env.restart()
  assert.equal(ok(await env.call('agent-presets')).rows.some(row => row.id === 'review'), false)
})

test('owned Host core roster, avatar and sidebar operations survive restart and expose workspace operations', async t => {
  const env = await fixture(t)
  const chief = (await env.state()).bots[0]
  const writer = ok(await env.call('create-bot', { name: 'Writer', role: 'Write', model: 'faux/faux-1' }))
  const copy = ok(await env.call('duplicate-bot', { id: writer.id }))
  assert.match(copy.name, /^Writer copy/)

  const prefs = ok(await env.call('set-prefs', {
    theme: 'dark', accent: '#123abc', motion: 'quiet', layout: 'flat', width: 72,
    flatWidth: 68, thinking: true, enterToSend: false, memoryAutoRecall: false,
  }))
  assert.deepEqual(prefs, {
    theme: 'dark', accent: '#123abc', motion: 'quiet', layout: 'flat', width: 72,
    flatWidth: 68, thinking: true, enterToSend: false, memoryAutoRecall: false,
  })

  const imported = ok(await env.call('avatar-import', { items: [{ name: 'team.png', image: png }] }))
  assert.equal(imported.imported.length, 1)
  const avatar = ok(await env.call('avatar-library')).items[0]
  assert.equal(avatar.image, png)
  assert.equal(ok(await env.call('avatar-delete', { id: avatar.id })), true)
  assert.equal(ok(await env.call('avatar-library')).total, 0)

  const first = ok(await env.call('section-save', { name: 'Delivery', color: 'orange', items: [writer.id] }))
  const second = ok(await env.call('section-save', { name: 'Review', color: 'green', items: [copy.id] }))
  ok(await env.call('set-flags', { id: writer.id, pinned: true, sectionId: second.id }))
  let view = ok(await env.call('section-order', { ids: [second.id, first.id] }))
  assert.deepEqual(view.sections.map(section => section.id), [second.id, first.id])
  assert.equal(view.bots.find(bot => bot.id === writer.id).pinned, true)

  ok(await env.call('set-main', { id: writer.id, main: true, primary: true }))
  view = await env.state()
  assert.equal(view.mainBotId, writer.id)
  assert.equal(view.bots.find(bot => bot.id === writer.id).sectionId, undefined)

  const room = ok(await env.call('create-room', { name: 'Core room', members: [chief.id, writer.id], admin: chief.id }))
  const changed = ok(await env.call('update-room', {
    id: room.id, name: 'Delivery room', notice: 'Keep the result concise.', mode: 'everyone', admin: writer.id,
  }))
  assert.equal(changed.room.name, 'Delivery room')
  assert.equal(changed.room.notice, 'Keep the result concise.')
  assert.equal(changed.room.mode, 'everyone')
  assert.equal(changed.room.admin, writer.id)

  const folders = ok(await env.call('folders'))
  assert.equal(typeof folders.team, 'string')
  assert.equal(folders.picker, 'browse')
  const listing = ok(await env.call('folder-list', { path: env.root }))
  assert.equal(listing.path, await realpath(env.root))
  assert.ok(listing.entries.some(entry => entry.name === 'workspace'))
  const pick = await env.call('folder-pick')
  assert.equal(pick.ok, false)
  assert.match(pick.error.message, /no folder chooser/)

  const moved = ok(await env.call('team-workspace', { path: join(env.root, 'moved-workspace') })).team
  assert.equal(ok(await env.call('folders')).team, moved)

  ok(await env.call('section-delete', { id: second.id }))
  ok(await env.call('delete-room', { id: room.id }))
  ok(await env.call('delete-bot', { id: copy.id }))
  ok(await env.call('set-main', { id: writer.id, main: false }))
  ok(await env.call('delete-bot', { id: writer.id }))

  const privateDir = join(env.root, 'private-work')
  await mkdir(privateDir)
  const privateBot = ok(await env.call('create-bot', { name: 'Ledger', role: 'Books', model: 'faux/faux-1', workDir: privateDir }))
  ok(await env.call('update-bot', { id: privateBot.id, private: true }))
  view = ok(await env.call('delete-bot', { id: privateBot.id }))
  assert.equal(view.privateArchives[0].id, privateBot.id)
  view = ok(await env.call('private-release', { id: privateBot.id }))
  assert.deepEqual(view.privateArchives, [])

  await env.restart()
  view = await env.state()
  assert.equal(view.prefs.theme, 'dark')
  assert.equal(view.prefs.enterToSend, false)
  assert.equal(view.bots.length, 1)
  assert.equal(view.bots[0].id, chief.id)
  assert.equal(view.rooms.length, 0)
  assert.deepEqual(view.privateArchives, [])
  assert.deepEqual(view.sections.map(section => section.id), [first.id])
  assert.equal(ok(await env.call('avatar-library')).total, 0)
})

test('owned Host core conversation, part, question, view and goal operations use real runtime state', async t => {
  const env = await fixture(t)
  const chief = (await env.state()).bots[0]
  const writer = ok(await env.call('create-bot', { name: 'Writer', role: 'Write', model: 'faux/faux-1' }))
  const host = env.host()
  const chiefSession = host.runtime.chatOf(chief.id)
  const chiefAgent = await host.runtime.resolveAgent(chiefSession)

  const message = host.runtime.teamTools.find(tool => tool.name === 'message_bot')
  assert.ok(message)
  assert.match(await message.execute({ to: writer.name, message: 'Check the core workflow.' }, { agent: chiefAgent }), /Delivered to Writer/)
  const exchange = await waitFor(async () => {
    const entries = ok(await env.call('exchange', { a: chief.id, b: writer.id }))
    return entries.find(entry => entry.from === chief.id && entry.to === writer.id)
  })
  assert.match(exchange.text, /core workflow/)

  ok(await env.call('send', { sessionId: writer.id, text: 'Keep this in the earlier part.' }))
  await waitFor(async () => (await env.call('chat', { botId: writer.id })).value.items.some(item => item.kind === 'bot'))
  const beforePart = (await env.state()).bots.find(bot => bot.id === writer.id).sessionId
  ok(await env.call('bot-new-part', { botId: writer.id }))
  const afterPart = await waitFor(async () => {
    const bot = (await env.state()).bots.find(entry => entry.id === writer.id)
    return bot.sessionId !== beforePart && bot.parts?.includes(beforePart) ? bot.sessionId : undefined
  })
  const earlier = ok(await env.call('earlier', { sessionId: afterPart }))
  assert.ok(earlier.items.some(item => item.kind === 'user' && item.text === 'Keep this in the earlier part.'))
  assert.equal(ok(await env.call('bot-open-part', { botId: writer.id, sessionId: beforePart })), true)
  assert.equal((await env.state()).bots.find(bot => bot.id === writer.id).sessionId, beforePart)

  const ask = host.runtime.teamTools.find(tool => tool.name === 'ask_user')
  const show = host.runtime.teamTools.find(tool => tool.name === 'show_view')
  assert.ok(ask)
  assert.ok(show)
  await ask.execute({ question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }] }, {
    agent: { id: beforePart }, callId: 'question-answer', concludeTurn() {},
  })
  let state = await env.state()
  const question = state.questions[beforePart]
  assert.ok(question)
  assert.equal(ok(await env.call('answer-question', { sessionId: writer.id, questionId: question.id, answer: { selected: ['B'] } })), true)
  assert.equal((await env.state()).questions[beforePart], undefined)
  await ask.execute({ question: 'Dismiss me', options: [{ label: 'Yes' }] }, {
    agent: { id: beforePart }, callId: 'question-dismiss', concludeTurn() {},
  })
  assert.equal(ok(await env.call('dismiss-question', { sessionId: beforePart })), true)
  assert.equal((await env.state()).questions[beforePart], undefined)

  const choices = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
  await show.execute({ title: 'Pick', view: choices }, { agent: { id: beforePart }, callId: 'view-answer', concludeTurn() {} })
  state = await env.state()
  const view = state.views[beforePart]
  assert.ok(view)
  assert.equal(ok(await env.call('view-reply', { sessionId: writer.id, viewId: view.id, action: 'pick', values: { selected: ['A'] } })), true)
  assert.equal((await env.state()).views[beforePart], undefined)
  await show.execute({ title: 'Dismiss', view: choices }, { agent: { id: beforePart }, callId: 'view-dismiss', concludeTurn() {} })
  assert.equal(ok(await env.call('dismiss-view', { sessionId: beforePart })), true)
  assert.equal((await env.state()).views[beforePart], undefined)

  const room = ok(await env.call('create-room', { name: 'Goal room', members: [chief.id, writer.id], admin: chief.id }))
  assert.equal(ok(await env.call('stop-member-work', { roomId: room.id, botId: writer.id })), false)
  ok(await env.call('goal-draft', { roomId: room.id, text: 'Prove the core workflow' }))
  state = await env.state()
  let goal = state.rooms.find(entry => entry.id === room.id).goal
  assert.equal(goal.status, 'drafting')
  ok(await env.call('goal-control', { roomId: room.id, goalId: goal.id, action: 'stop' }))
  goal = (await env.state()).rooms.find(entry => entry.id === room.id).goal
  assert.equal(goal.status, 'stopped')
  ok(await env.call('goal-control', { roomId: room.id, goalId: goal.id, action: 'clear' }))
  assert.equal((await env.state()).rooms.find(entry => entry.id === room.id).goal, undefined)

  const resumedAgent = await env.host().runtime.resolveAgent((await env.state()).bots.find(bot => bot.id === writer.id).sessionId)
  await resumedAgent.whenIdle()
  const callsBeforeResume = env.faux.state.callCount
  assert.equal(ok(await env.call('resume', { botId: writer.id })), true)
  await waitFor(() => env.faux.state.callCount > callsBeforeResume)
  const abandoned = await env.call('abandon-work', { id: 'no-open-nested-work' })
  assert.equal(abandoned.ok, false)
  assert.equal(abandoned.error.code, 'bot/stale')

  await env.restart()
  state = await env.state()
  assert.ok(ok(await env.call('exchange', { a: chief.id, b: writer.id })).some(entry => entry.id === exchange.id))
  assert.equal(state.bots.find(bot => bot.id === writer.id).sessionId, beforePart)
  assert.equal(state.questions[beforePart], undefined)
  assert.equal(state.views[beforePart], undefined)
  assert.equal(state.rooms.find(entry => entry.id === room.id).goal, undefined)
})

test('owned Host deletes persisted side cards and settles learning proposals across restart', async t => {
  const env = await fixture(t)
  const chief = (await env.state()).bots[0]
  const writer = ok(await env.call('create-bot', { name: 'Writer', role: 'Write', model: 'faux/faux-1' }))
  const writerSession = env.host().runtime.chatOf(writer.id)
  await env.close()

  const card = {
    id: 'saved-side-card', botId: writer.id, partId: writerSession, atSeq: 1,
    question: 'Keep this card?', answer: 'No.', status: 'done', createdAt: 1, finishedAt: 2,
  }
  const cardDir = join(env.dataDir, 'bot', 'btw', writer.id)
  await mkdir(cardDir, { recursive: true })
  await writeFile(join(cardDir, `${writerSession}.json`), JSON.stringify([card]))

  const proposal = {
    id: 'learning-proposal', kind: 'skill', botId: writer.id, action: 'create',
    name: 'release-checks', description: 'Use when checking a release.',
    content: 'Run the release checks.', why: 'The work showed a reusable check.', createdAt: 3,
  }
  const learningDir = join(env.dataDir, 'bot', 'learning')
  await mkdir(learningDir, { recursive: true })
  await writeFile(join(learningDir, 'state.json'), JSON.stringify({ proposals: { [proposal.id]: proposal } }))

  await env.restart()
  let state = await env.state()
  assert.equal(state.btwCards[writer.id][0].id, card.id)
  assert.equal(state.learning[writer.id][0].id, proposal.id)
  assert.deepEqual(ok(await env.call('btw-delete', { sessionId: writerSession, cardId: card.id })), { deleted: true })
  assert.deepEqual(ok(await env.call('learning-answer', { id: proposal.id, approve: false })), { applied: false })

  await env.restart()
  state = await env.state()
  assert.equal(state.btwCards[writer.id], undefined)
  assert.equal(state.learning[writer.id], undefined)
  assert.equal(state.learningSettled[writer.id][0].id, proposal.id)
  assert.equal(state.learningSettled[writer.id][0].outcome, 'declined')
  assert.equal(state.bots.some(bot => bot.id === chief.id), true)
})
