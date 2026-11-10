import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'
import { migrateLegacyTeam } from '../src/engine/legacy-import.js'

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

async function legacySession(dataDir, id, messages) {
  const dir = join(dataDir, 'sessions', '--team--', id)
  await mkdir(dir, { recursive: true })
  const rows = [
    { version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0 },
    ...messages.map((message, index) => message.role === 'user'
      ? { type: 'user/message', seq: index, time: message.timestamp, data: message }
      : { type: 'assistant/message', seq: index, time: message.timestamp, data: { turn: index, step: 1, message } }),
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
    mainBotIds: ['legacy-bot'],
    bots: {
      'legacy-bot': {
        id: 'legacy-bot', name: 'Chief', role: 'Lead', sessionId: 'legacy-private', createdAt: 1,
        model: 'faux/faux-1', segments: [{ sessionId: 'legacy-private-1', endedAt: 20 }],
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
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], api: 'faux', provider: 'faux', model: 'faux-1', usage: ZERO_USAGE, stopReason: 'stop', timestamp: 11 }
  await legacySession(dataDir, 'legacy-private', [user, assistant])
  await legacySession(dataDir, 'legacy-private-1', [{ ...user, content: [{ type: 'text', text: 'earlier question' }] }])
  await legacySession(dataDir, 'legacy-room', [])
  await legacySession(dataDir, 'legacy-group', [{ ...assistant, content: [{ type: 'text', text: 'group answer' }] }])
  await legacySession(dataDir, 'legacy-group-1', [{ ...user, content: [{ type: 'text', text: 'earlier group question' }] }])

  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  models.registerNativeProvider(fauxProvider().provider)
  await models.refresh({ allowNetwork: false })
  let host = await OwnedHost.open({ dataDir, uiDir, models, workspacePath: dataDir })
  t.after(() => host.close())
  const cookie = await authenticate(host)

  const current = await call(host, cookie, 'chat', { botId: 'legacy-bot' })
  assert.equal(current.ok, true, JSON.stringify(current))
  assert.ok(current.value.items.some(item => item.kind === 'user' && item.text === 'old question'))
  assert.ok(current.value.items.some(item => item.kind === 'bot' && item.text === 'old answer'))
  const earlier = await call(host, cookie, 'earlier', { sessionId: host.runtime.state.bots['legacy-bot'].sessionId })
  assert.equal(earlier.ok, true)
  assert.ok(earlier.value.items.some(item => item.kind === 'user' && item.text === 'earlier question'), JSON.stringify(earlier.value))

  const migrated = JSON.parse(await readFile(join(dataDir, 'bot', 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(migrated.bots), ['legacy-bot'])
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
      importConversation: async () => {
        firstCalls.push(firstCalls.length + 101)
        if (firstCalls.length === 2) throw new Error('interrupted')
        return String(firstCalls.at(-1))
      },
    },
  }), /interrupted/u)
  assert.deepEqual(firstCalls, [101, 102])
  const partial = JSON.parse(await readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8'))
  assert.deepEqual(partial.sessions, { private: '101' })
  assert.equal(partial.complete, false)

  const resumed = []
  await migrateLegacyTeam({
    dataDir,
    harness: { importConversation: async () => { resumed.push('102'); return '102' } },
  })
  assert.deepEqual(resumed, ['102'])
  const migrated = JSON.parse(await readFile(join(dataDir, 'bot', 'state.json'), 'utf8'))
  assert.equal(migrated.bots.chief.sessionId, '101')
  assert.equal(migrated.bots.chief.segments[0].sessionId, '102')
  const complete = JSON.parse(await readFile(join(dataDir, 'bot', 'pi-import.json'), 'utf8'))
  assert.equal(complete.complete, true)
})
