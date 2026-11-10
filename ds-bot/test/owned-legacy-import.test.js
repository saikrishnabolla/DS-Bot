import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createModels } from '@earendil-works/pi-ai/models'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'
import { migrateLegacyTeam, readLegacyConversation } from '../src/engine/legacy-import.js'
import { prepareLegacyModels } from '../src/engine/legacy-model-import.js'
import { OwnedHarness } from '../src/engine/owned-harness.js'
import { OwnedModels } from '../src/engine/owned-models.js'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

async function legacySession(dataDir, id, messages, { version = 4 } = {}) {
  const dir = join(dataDir, 'sessions', '--team--', id)
  await mkdir(dir, { recursive: true })
  const events = messages.flatMap((message, index) => {
    if (message.role === 'user') return [{ type: 'user/message', time: message.timestamp, data: message }]
    if (message.role === 'tool') {
      const stored = version === 3
        ? { id: message.id, role: 'user', source: message.source, content: [{ type: 'tool-result', toolCallId: message.toolCallId, content: message.content, isError: message.isError }] }
        : message
      return [{ type: 'tool/result', time: message.timestamp, surfaceOp: 'append', data: { message: stored } }]
    }
    const calls = message.content.filter(block => block.type === 'tool-call')
    return [
      { type: 'assistant/message', time: message.timestamp, surfaceOp: 'append', data: { turn: index, step: 1, message, stream: [] } },
      ...calls.map(block => ({ type: 'tool/call', time: message.timestamp, data: { turn: index, step: 1, callId: block.id, name: block.name, arguments: block.arguments } })),
    ]
  }).map((event, seq) => ({ ...event, seq }))
  const rows = [
    { version, id, createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0 },
    ...events,
  ]
  const body = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(body))
}

async function authenticate(host) {
  const launched = await fetch(host.launchUrl, { redirect: 'manual' })
  const cookie = launched.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return cookie
}

async function call(host, cookie, endpoint, payload = {}) {
  const response = await fetch(`${host.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('owned Host migrates a 0.3.2 team and keeps its readable chats', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-legacy-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const uiDir = join(dataDir, 'ui')
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  await mkdir(uiDir)
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')

  const state = {
    version: 1,
    prefs: { defaultBotModel: 'deepseek-official/deepseek-flash' },
    mainBotIds: ['legacy-bot', 'legacy-v3-bot'],
    bots: {
      'legacy-bot': {
        id: 'legacy-bot', name: 'Chief', role: 'Lead', sessionId: 'legacy-private', createdAt: 1,
        model: 'faux/faux-1', segments: [{ sessionId: 'legacy-private-1', endedAt: 20 }],
      },
      'legacy-v3-bot': {
        id: 'legacy-v3-bot', name: 'Archivist', role: 'Archive', sessionId: 'legacy-v3', createdAt: 2,
        model: 'faux/faux-1', segments: [],
      },
    },
    rooms: {
      'legacy-room': {
        id: 'legacy-room', name: 'Ops', named: true, members: ['legacy-bot'], admin: 'legacy-bot', mode: 'admin', createdAt: 2,
        sessions: { 'legacy-bot': 'legacy-group' }, segments: { 'legacy-bot': [{ sessionId: 'legacy-group-1', endedAt: 30 }] },
      },
    },
  }
  await writeFile(join(dataDir, 'bot', 'state.json'), `${JSON.stringify(state)}\n`)
  const user = { role: 'user', content: [{ type: 'text', text: 'old question' }], timestamp: 10 }
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'old answer' },
      { type: 'tool-call', id: 'legacy-call', name: 'read', arguments: '{"path":"notes.txt"}' },
    ],
    api: 'faux', provider: 'faux', model: 'faux-1',
    usage: { ...ZERO_USAGE, input: 3, output: 4, totalTokens: 7 }, stopReason: 'toolUse', timestamp: 11,
  }
  const result = { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'legacy-call' }, toolCallId: 'legacy-call', content: [{ type: 'text', text: 'legacy tool result' }], isError: false, timestamp: 12 }
  await legacySession(dataDir, 'legacy-private', [user, assistant, result])
  const v3Assistant = { ...assistant, content: [{ type: 'tool-call', id: 'v3-call', name: 'read', arguments: '{"path":"v3.txt"}' }] }
  const v3Result = { ...result, id: 'v3-result', source: { kind: 'tool', callId: 'v3-call' }, toolCallId: 'v3-call', content: [{ type: 'text', text: 'v3 tool result' }] }
  await legacySession(dataDir, 'legacy-v3', [user, v3Assistant, v3Result], { version: 3 })
  const image = Buffer.from('89504e470d0a1a0a', 'hex')
  const digest = createHash('sha256').update(image).digest('hex')
  await mkdir(join(dataDir, 'attachments', 'v1', 'objects', digest.slice(0, 2)), { recursive: true })
  await writeFile(join(dataDir, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest), image)
  const imageBlock = { type: 'image', attachment: { attachmentId: `sha256:${digest}`, mediaType: 'image/png', bytes: image.length } }
  const unfinished = { ...assistant, content: [{ type: 'tool-call', id: 'unfinished-call', name: 'read', arguments: '{"path":"later.txt"}' }] }
  await legacySession(dataDir, 'legacy-private-1', [{ ...user, content: [{ type: 'text', text: 'earlier question' }, imageBlock] }, unfinished])
  const imageConversation = await readLegacyConversation(dataDir, 'legacy-private-1')
  assert.ok(imageConversation.messages[0].content.some(block => block.type === 'image' && block.data === image.toString('base64')))
  await legacySession(dataDir, 'legacy-room', [])
  await legacySession(dataDir, 'legacy-group', [{ ...assistant, content: [{ type: 'text', text: 'group answer' }] }])
  await legacySession(dataDir, 'legacy-group-1', [{ ...user, content: [{ type: 'text', text: 'earlier group question' }] }])

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })
  let host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  const cookie = await authenticate(host)

  const current = await call(host, cookie, 'chat', { botId: 'legacy-bot' })
  assert.equal(current.ok, true, JSON.stringify(current))
  assert.ok(current.value.items.some(item => item.kind === 'user' && item.text === 'old question'))
  assert.ok(current.value.items.some(item => item.kind === 'bot' && item.text === 'old answer'))
  assert.ok(current.value.items.some(item => item.kind === 'tool-call' && item.callId === 'legacy-call'))
  assert.ok(current.value.items.some(item => item.kind === 'tool-result' && item.text === 'legacy tool result'))
  const callIndex = current.value.items.findIndex(item => item.kind === 'tool-call' && item.callId === 'legacy-call')
  const resultIndex = current.value.items.findIndex(item => item.kind === 'tool-result' && item.callId === 'legacy-call')
  assert.ok(callIndex < resultIndex, JSON.stringify(current.value.items))
  const projections = (await host.runtime.ctx.sessionController.projections({ sessionId: host.runtime.chatOf('legacy-bot') })).values
  assert.equal(projections.tokenUsage.uncachedInputTokens, 3)
  assert.equal(projections.tokenUsage.outputTokens, 4)
  const earlier = await call(host, cookie, 'earlier', { sessionId: host.runtime.state.bots['legacy-bot'].sessionId })
  assert.equal(earlier.ok, true)
  assert.ok(earlier.value.items.some(item => item.kind === 'user' && item.text === 'earlier question'), JSON.stringify(earlier.value))
  assert.ok(earlier.value.items.some(item => item.kind === 'tool-call' && item.callId === 'unfinished-call'), JSON.stringify(earlier.value))
  const v3Chat = await call(host, cookie, 'chat', { botId: 'legacy-v3-bot' })
  assert.ok(v3Chat.value.items.some(item => item.kind === 'tool-result' && item.text === 'v3 tool result'))

  const migrated = JSON.parse(await readFile(join(dataDir, 'bot', 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(migrated.bots), ['legacy-bot', 'legacy-v3-bot'])
  assert.equal(migrated.prefs.defaultBotModel, 'deepseek/deepseek-flash')
  assert.deepEqual(Object.keys(migrated.rooms), ['legacy-room'])
  for (const id of [
    migrated.bots['legacy-bot'].sessionId,
    migrated.bots['legacy-bot'].segments[0].sessionId,
    migrated.rooms['legacy-room'].sessionId,
    migrated.rooms['legacy-room'].sessions['legacy-bot'],
    migrated.rooms['legacy-room'].segments['legacy-bot'][0].sessionId,
  ]) assert.match(id, /^[1-9]\d*$/u)
  const record = JSON.parse(await readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8'))
  assert.equal(record.version, 1)
  await host.close()
  host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  const restarted = await call(host, await authenticate(host), 'chat', { botId: 'legacy-bot' })
  assert.ok(restarted.value.items.some(item => item.kind === 'bot' && item.text === 'old answer'))
  assert.ok(restarted.value.items.some(item => item.kind === 'tool-result' && item.callId === 'legacy-call'))
  const restartedUsage = (await host.runtime.ctx.sessionController.projections({ sessionId: host.runtime.chatOf('legacy-bot') })).values.tokenUsage
  assert.equal(restartedUsage.uncachedInputTokens, 3)
  assert.equal(restartedUsage.outputTokens, 4)
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8')).sessions, record.sessions)
})

test('legacy migration resumes after a recorded conversation without importing it twice', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-legacy-resume-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  const state = {
    bots: {
      chief: { id: 'chief', sessionId: 'private', segments: [{ sessionId: 'earlier' }] },
    },
    rooms: {},
  }
  await writeFile(join(dataDir, 'bot', 'state.json'), `${JSON.stringify(state)}\n`)
  await legacySession(dataDir, 'private', [])
  await legacySession(dataDir, 'earlier', [])

  const firstCalls = []
  await assert.rejects(migrateLegacyTeam({
    dataDir,
    harness: {
      importConversations: async conversations => {
        firstCalls.push(...conversations.map(item => item.legacyId))
        throw new Error('interrupted')
      },
    },
  }), /interrupted/u)
  assert.deepEqual(firstCalls, ['private', 'earlier'])
  await assert.rejects(readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8'), { code: 'ENOENT' })

  const resumed = []
  await migrateLegacyTeam({
    dataDir,
    harness: { importConversations: async conversations => {
      resumed.push(...conversations.map(item => item.legacyId))
      return { private: '101', earlier: '102' }
    } },
  })
  assert.deepEqual(resumed, ['private', 'earlier'])
  const migrated = JSON.parse(await readFile(join(dataDir, 'bot', 'state.json'), 'utf8'))
  assert.equal(migrated.bots.chief.sessionId, '101')
  assert.equal(migrated.bots.chief.segments[0].sessionId, '102')
  const complete = JSON.parse(await readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8'))
  assert.equal(complete.complete, true)
})

test('legacy migration rejects malformed sessions without creating any conversation', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-legacy-atomic-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  const state = { bots: { chief: { id: 'chief', sessionId: 'valid', segments: [{ sessionId: 'broken' }] } }, rooms: {} }
  await writeFile(join(dataDir, 'bot', 'state.json'), `${JSON.stringify(state)}\n`)
  await legacySession(dataDir, 'valid', [{ role: 'user', content: [{ type: 'text', text: 'kept' }], timestamp: 1 }])
  const brokenDir = join(dataDir, 'sessions', '--team--', 'broken')
  await mkdir(brokenDir, { recursive: true })
  await writeFile(join(brokenDir, 'session.jsonl'), '{"version":4,"id":"broken"}\nnot-json\n')
  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  models.registerNativeProvider(fauxProvider().provider)
  await models.refresh({ allowNetwork: false })
  const harness = await OwnedHarness.open({ dataDir, models })
  t.after(() => harness.close())
  await assert.rejects(migrateLegacyTeam({ dataDir, harness }), /row 2/u)
  assert.equal((await harness.scanConversations({}, 20)).items.length, 0)
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'bot', 'state.json'), 'utf8')), state)
  await assert.rejects(readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8'), { code: 'ENOENT' })
})

test('legacy conversation mappings prevent duplicates across a harness restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-legacy-idempotent-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  models.registerNativeProvider(fauxProvider().provider)
  await models.refresh({ allowNetwork: false })
  const item = {
    legacyId: 'legacy-session',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'once' }], timestamp: 1 }],
  }
  let harness = await OwnedHarness.open({ dataDir, models })
  t.after(() => harness.close())
  const first = (await harness.importConversations([item]))['legacy-session']
  await harness.close()
  harness = await OwnedHarness.open({ dataDir, models })
  const second = (await harness.importConversations([item]))['legacy-session']
  assert.equal(second, first)
  assert.equal((await harness.scanConversations({}, 20)).items.length, 1)
})

test('real v3 and v4 tool histories reach OpenAI-style and Anthropic-style providers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-legacy-provider-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const assistant = {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"history.txt"}' }],
    api: 'legacy', provider: 'legacy', model: 'legacy', usage: ZERO_USAGE, stopReason: 'toolUse', timestamp: 2,
  }
  const result = {
    id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1',
    content: [{ type: 'text', text: 'history result' }], isError: false, timestamp: 3,
  }
  const repeated = { ...assistant, timestamp: 4 }
  const repeatedResult = { ...result, id: 'result-2', content: [{ type: 'text', text: 'second result' }], timestamp: 5 }
  await legacySession(dataDir, 'v4-session', [assistant, result, repeated, repeatedResult])
  await legacySession(dataDir, 'v3-session', [assistant, result, repeated, repeatedResult], { version: 3 })
  const seen = new Map()
  const openai = fauxProvider({ api: 'openai-completions', provider: 'openai-fixture', models: [{ id: 'model' }] })
  const anthropic = fauxProvider({ api: 'anthropic-messages', provider: 'anthropic-fixture', models: [{ id: 'model' }] })
  openai.setResponses([context => { seen.set('openai', context.messages); return fauxAssistantMessage('openai resumed') }])
  anthropic.setResponses([context => { seen.set('anthropic', context.messages); return fauxAssistantMessage('anthropic resumed') }])
  const models = createModels()
  models.setProvider(openai.provider)
  models.setProvider(anthropic.provider)
  const harness = await OwnedHarness.open({ dataDir, models })
  t.after(() => harness.close())
  const imported = await harness.importConversations([
    { ...(await readLegacyConversation(dataDir, 'v4-session')), legacyId: 'v4-session' },
    { ...(await readLegacyConversation(dataDir, 'v3-session')), legacyId: 'v3-session' },
  ])
  await harness.configure(imported['v4-session'], { model: { provider: 'openai-fixture', modelId: 'model' } })
  await harness.configure(imported['v3-session'], { model: { provider: 'anthropic-fixture', modelId: 'model' } })
  harness.resume()
  await (await harness.submit(imported['v4-session'], { content: 'continue', requestId: 'continue-v4' })).wait()
  await (await harness.submit(imported['v3-session'], { content: 'continue', requestId: 'continue-v3' })).wait()
  for (const messages of seen.values()) {
    const call = messages.flatMap(message => message.content ?? []).find(block => block.type === 'toolCall')
    assert.deepEqual(call.arguments, { path: 'history.txt' })
    const toolResult = messages.find(message => message.role === 'toolResult')
    assert.equal(toolResult.toolCallId, 'call-1')
    assert.equal(toolResult.toolName, 'read')
    assert.equal(messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'call-1').length, 2)
  }
  assert.deepEqual([...seen.keys()], ['openai', 'anthropic'])
})

test('legacy model migration preserves routes and credentials without overwriting owned settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-owned-model-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const dataDir = join(root, 'owned')
  await mkdir(join(source, 'profiles', 'desktop'), { recursive: true })
  await mkdir(join(source, 'profiles', 'other'), { recursive: true })
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  await writeFile(join(dataDir, 'bot', 'imported.json'), `${JSON.stringify({ from: source })}\n`)
  await writeFile(join(dataDir, 'auth.json'), `${JSON.stringify({ anthropic: { type: 'api_key', key: 'owned-secret' } })}\n`, { mode: 0o600 })
  await writeFile(join(dataDir, 'providers.json'), `${JSON.stringify({ enabled: ['anthropic'], custom: {} })}\n`, { mode: 0o600 })
  const credentialText = `version: 1
refs:
  OPENAI_API_KEY: legacy-ref-secret
  DEEPSEEK_API_KEY: deepseek-secret
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: access-secret
      refresh: refresh-secret
      expires: 1786000000000
  deepseek-account-platform/default:
    kind: grant
    payload:
      type: oauth
      access: not-a-pi-credential
`
  await writeFile(join(source, '.credentials.yaml'), credentialText, { mode: 0o600 })
  await writeFile(join(source, 'profiles', 'desktop', 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
      custom-route:
        displayName: Custom
        apiKeyEnv: OPENAI_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1/
        models:
          - id: custom-model
- id: llm-deepseek-api-key
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
`)
  await writeFile(join(source, 'profiles', 'other', 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      openai:
        apiKeyEnv: OTHER_OPENAI_KEY
`)
  await prepareLegacyModels({ dataDir })
  const auth = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'))
  assert.deepEqual(auth.anthropic, { type: 'api_key', key: 'owned-secret' })
  assert.deepEqual(auth.openai, { type: 'api_key', key: 'legacy-ref-secret' })
  assert.deepEqual(auth['openai-codex'], { type: 'oauth', access: 'access-secret', refresh: 'refresh-secret', expires: 1786000000000 })
  assert.deepEqual(auth['custom-route'], { type: 'api_key', key: 'legacy-ref-secret' })
  assert.deepEqual(auth.deepseek, { type: 'api_key', key: 'deepseek-secret' })
  assert.equal(auth.default, undefined)
  const providers = JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf8'))
  assert.deepEqual(providers.enabled, ['anthropic', 'openai', 'deepseek'])
  assert.equal(providers.custom['custom-route'].baseUrl, 'https://gateway.example/v1')
  assert.equal(providers.custom['custom-route'].models[0].id, 'custom-model')
  const runtime = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const owned = await OwnedModels.open(runtime, { configPath: join(dataDir, 'providers.json') })
  await runtime.refresh({ allowNetwork: false })
  assert.ok(owned.catalog().some(model => model.ref === 'custom-route/custom-model'))
  assert.equal(runtime.hasConfiguredAuth('openai'), true)
  assert.equal(runtime.hasConfiguredAuth('openai-codex'), true)
  assert.equal(runtime.hasConfiguredAuth('custom-route'), true)
  assert.equal(runtime.hasConfiguredAuth('deepseek'), true)
  const migrationRecord = JSON.parse(await readFile(join(dataDir, 'bot', 'pi-model-import.json'), 'utf8'))
  assert.ok(migrationRecord.issues.includes('DeepSeek account sign-in must be completed again'))
  assert.ok(migrationRecord.issues.includes('Skipped conflicting legacy model route openai'))
  await writeFile(join(source, '.credentials.yaml'), credentialText.replace('legacy-ref-secret', 'changed-secret'), { mode: 0o600 })
  await prepareLegacyModels({ dataDir })
  assert.equal(JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8')).openai.key, 'legacy-ref-secret')
  for (const path of [join(dataDir, 'bot', 'imported.json'), join(dataDir, 'bot', 'pi-model-import.json'), join(dataDir, 'providers.json')]) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /(?:legacy-ref|deepseek|access|refresh|not-a-pi)-secret/u)
  }
  for (const path of [join(dataDir, 'auth.json'), join(dataDir, 'providers.json'), join(dataDir, 'bot', 'pi-model-import.json')]) {
    assert.equal((await stat(path)).mode & 0o077, 0)
  }
})

test('legacy DeepSeek endpoint settings keep their production profile id and Messages protocol', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-deepseek-route-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  await mkdir(join(dataDir, 'profiles', 'desktop'), { recursive: true })
  await writeFile(join(dataDir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: deepseek-secret\nrecords: {}\n', { mode: 0o600 })
  await writeFile(join(dataDir, 'profiles', 'desktop', 'cordis.patch.yml'), `- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://deepseek.example/anthropic/
`)
  await prepareLegacyModels({ dataDir })
  const providers = JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf8'))
  assert.equal(providers.custom.deepseek.api, 'anthropic-messages')
  assert.equal(providers.custom.deepseek.baseUrl, 'https://deepseek.example/anthropic')
  assert.ok(providers.custom.deepseek.models.some(model => model.id === 'deepseek-flash'))
  const runtime = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const owned = await OwnedModels.open(runtime, { configPath: join(dataDir, 'providers.json') })
  await runtime.refresh({ allowNetwork: false })
  assert.ok(owned.catalog().some(model => model.ref === 'deepseek/deepseek-flash'))
})

test('malformed legacy model settings are reported without blocking startup or writing model files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-owned-model-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const dataDir = join(root, 'owned')
  await mkdir(join(source, 'profiles', 'desktop'), { recursive: true })
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  await writeFile(join(dataDir, 'bot', 'imported.json'), `${JSON.stringify({ from: source })}\n`)
  await writeFile(join(source, '.credentials.yaml'), 'version: 1\nrefs:\n  SECRET: [broken\n', { mode: 0o600 })
  await writeFile(join(source, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n')
  const result = await prepareLegacyModels({ dataDir })
  assert.ok(result.issues.some(issue => issue.includes('legacy model settings')))
  await assert.rejects(readFile(join(dataDir, 'auth.json'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(dataDir, 'providers.json'), 'utf8'), { code: 'ENOENT' })
  assert.ok(JSON.parse(await readFile(join(dataDir, 'bot', 'pi-model-import.json'), 'utf8')).issues.length > 0)
})

test('Windows imports a legacy credential file without POSIX mode checks', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-model-windows-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  await writeFile(join(dataDir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: windows-secret\nrecords: {}\n', { mode: 0o666 })
  await prepareLegacyModels({ dataDir, platform: 'win32' })
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8')).deepseek, { type: 'api_key', key: 'windows-secret' })
})

test('POSIX skips and reports a permission-loose legacy credential file without blocking startup', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-model-posix-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await mkdir(join(dataDir, 'bot'), { recursive: true })
  await writeFile(join(dataDir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: loose-secret\nrecords: {}\n', { mode: 0o644 })
  const result = await prepareLegacyModels({ dataDir, platform: 'darwin' })
  assert.ok(result.issues.some(issue => issue.includes('not private')))
  await assert.rejects(readFile(join(dataDir, 'auth.json'), 'utf8'), { code: 'ENOENT' })
})
