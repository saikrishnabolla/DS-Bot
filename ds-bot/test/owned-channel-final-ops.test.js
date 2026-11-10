import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the owned channel operation')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-owned-channel-final-'))
  const dataDir = join(root, 'data')
  const uiDir = join(root, 'ui')
  const workspacePath = join(root, 'workspace')
  await Promise.all([mkdir(dataDir), mkdir(uiDir), mkdir(workspacePath)])
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')
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
  }
  const close = async () => {
    if (host === undefined) return
    await host.close()
    host = undefined
    call = undefined
    faux = undefined
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

async function remember(env, botId, args, callId) {
  const runtime = env.host().runtime
  const tool = runtime.teamTools.find(entry => entry.name === 'remember')
  assert.ok(tool)
  const agent = await runtime.resolveAgent(runtime.chatOf(botId))
  return tool.execute(args, { agent, callId })
}

test('owned Host reports models, thinking, run stats and usage while schedules and diagnostics survive restart', async t => {
  const env = await fixture(t)
  let state = await env.state()
  const chief = state.bots[0]
  ok(await env.call('update-bot', { id: chief.id, model: 'faux/faux-1' }))

  const models = ok(await env.call('models'))
  assert.equal(typeof models.modelsKey, 'string')
  assert.ok(models.modelsKey.length > 0)
  env.faux().setResponses([
    fauxAssistantMessage('Telemetry answer.'),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage('{"changes":[]}')),
  ])
  ok(await env.call('send', { sessionId: chief.id, text: 'Report telemetry.' }))
  await waitFor(async () => {
    const chat = ok(await env.call('chat', { botId: chief.id }))
    return chat.items.some(item => item.kind === 'bot' && item.text === 'Telemetry answer.')
  })

  const sessionId = (await env.state()).bots.find(bot => bot.id === chief.id).sessionId
  const thinking = ok(await env.call('thinking', { sessionId, turn: 1 }))
  assert.equal(typeof thinking, 'object')
  if (thinking.ms !== undefined) assert.equal(Number.isFinite(thinking.ms), true)
  const stats = ok(await env.call('run-stats', { botId: chief.id }))
  assert.ok(stats.sessionStats.turns >= 1)
  assert.ok(stats.tokenUsage.outputTokens > 0)
  assert.ok(stats.contextPressure.pressureTokens > 0)

  const usage = await waitFor(async () => {
    const value = ok(await env.call('usage', { timeZone: 'UTC' }))
    const hasModelRow = value.rows.some(row => value.models[row[2]]?.key === 'faux/faux-1')
    return value.scanning === false && hasModelRow ? value : undefined
  })
  assert.ok(usage.models.some(model => model.key === 'faux/faux-1'))
  assert.ok(usage.rows.some(row => usage.models[row[2]]?.key === 'faux/faux-1'))

  const schedules = ok(await env.call('schedule-create', {
    target: chief.id,
    title: 'Parity reminder',
    prompt: 'Check parity.',
    when: { kind: 'every', minutes: 60 },
  }))
  const task = schedules.tasks.find(entry => entry.title === 'Parity reminder')
  assert.ok(task)
  env.host().runtime.warn('ds-bot: owned diagnostics marker')
  assert.match(ok(await env.call('diagnostics-log')), /owned diagnostics marker/)

  await env.restart()
  state = await env.state()
  assert.equal(state.bots[0].id, chief.id)
  let restartedSchedules = ok(await env.call('schedules'))
  assert.ok(restartedSchedules.tasks.some(entry => entry.id === task.id))
  assert.match(ok(await env.call('diagnostics-log')), /owned diagnostics marker/)

  restartedSchedules = ok(await env.call('schedule-delete', { sessionId: task.sessionId, id: task.id }))
  assert.equal(restartedSchedules.tasks.some(entry => entry.id === task.id), false)
  await env.restart()
  assert.equal(ok(await env.call('schedules')).tasks.some(entry => entry.id === task.id), false)
})

test('owned Host persists side chats through completion, cancellation and closing', async t => {
  const env = await fixture(t)
  const writer = ok(await env.call('create-bot', {
    name: 'Writer', role: 'Write', model: 'faux/faux-1',
  }))
  env.faux().setResponses([
    fauxAssistantMessage('Normal answer.'),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage('{"changes":[]}')),
  ])
  ok(await env.call('send', { sessionId: writer.id, text: 'Start the main chat.' }))
  await waitFor(async () => {
    const chat = ok(await env.call('chat', { botId: writer.id }))
    return chat.items.some(item => item.kind === 'bot' && item.text === 'Normal answer.')
  })
  const sessionId = (await env.state()).bots.find(bot => bot.id === writer.id).sessionId

  const empty = ok(await env.call('side-new', { sessionId }))
  await env.restart()
  let chats = (await env.state()).sideChats[writer.id]
  assert.ok(chats.some(chat => chat.id === empty.chatId && chat.entries.length === 0))

  env.faux().setResponses([fauxAssistantMessage('Side answer.')])
  const answered = ok(await env.call('side-ask', {
    sessionId, chatId: empty.chatId, text: 'What changed?',
  }))
  await env.host().runtime.sideJoin(answered.entryId)
  chats = (await env.state()).sideChats[writer.id]
  assert.equal(chats.find(chat => chat.id === empty.chatId).entries[0].answer, 'Side answer.')
  await env.restart()
  chats = (await env.state()).sideChats[writer.id]
  assert.equal(chats.find(chat => chat.id === empty.chatId).entries[0].status, 'done')

  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  env.faux().setResponses([async (_context, options) => {
    startedResolve()
    if (!options.signal.aborted) {
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    }
    return fauxAssistantMessage('Too late.')
  }])
  const pending = ok(await env.call('side-ask', { sessionId, text: 'Wait here.' }))
  await started
  assert.deepEqual(ok(await env.call('side-cancel', {
    chatId: pending.chatId, entryId: pending.entryId,
  })), { answering: true })
  await env.host().runtime.sideJoin(pending.entryId)
  await env.restart()
  chats = (await env.state()).sideChats[writer.id]
  assert.equal(chats.find(chat => chat.id === pending.chatId).entries[0].status, 'cancelled')

  ok(await env.call('side-close', { chatId: empty.chatId }))
  ok(await env.call('side-close', { chatId: pending.chatId }))
  await env.restart()
  assert.equal((await env.state()).sideChats[writer.id], undefined)
})

test('owned Host persists memory panel changes, history restores and tidy undo', async t => {
  const env = await fixture(t)
  const state = await env.state()
  const chief = state.bots[0]
  const writer = ok(await env.call('create-bot', {
    name: 'Writer', role: 'Write', model: 'faux/faux-1',
  }))

  await remember(env, writer.id, { text: 'Prefers concise drafts' }, 'remember-concise')
  await remember(env, writer.id, { text: 'Move this fact' }, 'remember-move')
  await remember(env, writer.id, { text: 'Forget this fact' }, 'remember-forget')
  await remember(env, chief.id, { text: 'Team uses review gates', scope: 'team' }, 'remember-team')

  let view = ok(await env.call('memory-view', { botId: writer.id }))
  assert.ok(view.entries.some(entry => entry.scope === 'own' && entry.text === 'Prefers concise drafts'))
  assert.ok(view.entries.some(entry => entry.scope === 'team' && entry.text === 'Team uses review gates'))

  view = ok(await env.call('memory-pin', {
    botId: writer.id, scope: 'own', text: 'Prefers concise drafts', pin: true,
  }))
  assert.equal(view.entries.find(entry => entry.text === 'Prefers concise drafts').pinned, true)
  const history = ok(await env.call('memory-history', { botId: writer.id }))
  const pinRow = history.rows.find(row => row.op === 'replace' && row.text === 'Prefers concise drafts')
  assert.ok(pinRow)
  view = ok(await env.call('memory-restore', { botId: writer.id, id: pinRow.id }))
  assert.equal(view.entries.find(entry => entry.text === 'Prefers concise drafts').pinned, false)

  view = ok(await env.call('memory-layer', {
    botId: writer.id, topic: 'shared', text: 'Team uses review gates', always: true,
  }))
  assert.equal(view.entries.find(entry => entry.text === 'Team uses review gates').topic, null)
  view = ok(await env.call('memory-move', {
    botId: writer.id, scope: 'own', text: 'Move this fact', to: `bot:${chief.id}`,
  }))
  assert.equal(view.entries.some(entry => entry.text === 'Move this fact'), false)
  view = ok(await env.call('memory-forget', {
    botId: writer.id, scope: 'own', topic: null, text: 'Forget this fact',
  }))
  assert.equal(view.entries.some(entry => entry.text === 'Forget this fact'), false)

  env.faux().setResponses([fauxAssistantMessage(JSON.stringify({
    reply: 'Concise drafts.', changes: [],
  }))])
  const answer = ok(await env.call('memory-ask', {
    botId: writer.id, text: 'What drafting style is preferred?',
  }))
  assert.equal(answer.reply, 'Concise drafts.')

  for (let at = 1; at <= 8; at += 1) {
    await remember(env, writer.id, { text: `Tidy fact ${at}` }, `remember-tidy-${at}`)
  }
  env.faux().setResponses([fauxAssistantMessage(JSON.stringify({
    changes: [{ op: 'retire', entry: 1, why: 'duplicate' }],
  }))])
  await env.host().runtime.tidyMemoryNow(`bot:${writer.id}`)
  view = ok(await env.call('memory-view', { botId: writer.id }))
  assert.ok(view.tidy?.batch)
  assert.equal(view.entries.some(entry => entry.text === 'Prefers concise drafts'), false)
  view = ok(await env.call('memory-tidy-undo', {
    botId: writer.id, scope: 'own', batch: view.tidy.batch,
  }))
  assert.equal(view.tidy, null)
  assert.ok(view.entries.some(entry => entry.text === 'Prefers concise drafts'))

  await env.restart()
  view = ok(await env.call('memory-view', { botId: writer.id }))
  assert.ok(view.entries.some(entry => entry.text === 'Prefers concise drafts'))
  assert.equal(view.entries.some(entry => entry.text === 'Forget this fact'), false)
  const chiefView = ok(await env.call('memory-view', { botId: chief.id }))
  assert.ok(chiefView.entries.some(entry => entry.scope === 'own' && entry.text === 'Move this fact'))
  assert.equal(chiefView.entries.find(entry => entry.text === 'Team uses review gates').topic, null)
})
