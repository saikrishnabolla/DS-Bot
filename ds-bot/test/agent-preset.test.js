import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Fei2411/DS-Bot#37: under desktop app's default PTC preset a model may call only
// run_code, so the group_relay call made for a group chat's Session was turned down
// and no group message reached its Bots.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief'], admin: 'chief', mode: 'everyone', sessions: {}, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ presets } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agent-preset-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const services = presets === undefined ? {} : { agentPresets: { list: async () => presets } }
  const ctx = fakeContext({ services })
  const created = []
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `new${created.length}` }
      },
      resolveAgent: async id => ({ agent: { id, session: { id } } }),
    },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const relay = ctx.listeners.get('llm/stream').find(listener => /relayOrPass/.test(String(listener)))
  const warnings = []
  const warn = rt.warn
  rt.warn = (...args) => { warnings.push(format(...args)); return warn(...args) }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, created, relay, warnings, stop }
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const userText = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const declared = (...names) => names.map(name => ({ name, description: '', parameters: {} }))
const relayCall = async (relay, tools) => {
  const chunks = await drain(relay({ provider: 'deepseek', model: 'v4', sessionId: 'room', messages: [userText('Hello team')], tools }, () => {
    throw new Error('a group round never reaches the model')
  }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  return chunks.find(chunk => chunk.type === 'block-end').block
}

test('a new Bot Session is made with the standard preset when Cue serves it', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'ptc' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await rt.createSession('Chief')
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'standard' }])
})

test('without a usable standard preset a Bot Session keeps Cue\'s default', async (t) => {
  for (const presets of [undefined, [{ id: 'ptc' }], [{ id: 'standard', broken: 'failed to start' }]]) {
    const { rt, created, stop } = start({ presets })
    t.after(stop)
    await rt.load()
    await rt.createSession('Chief')
    assert.deepEqual(created, [{ workspaceId: 'w1' }])
  }
})

test('a group round calls group_relay directly when the Session declares it', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const rounds = []
  for (const tools of [declared('read', 'group_relay'), declared('run_code', 'group_relay')]) {
    const block = await relayCall(relay, tools)
    assert.equal(block.name, 'group_relay')
    rounds.push(JSON.parse(block.arguments))
  }
  for (const args of rounds) assert.match(args.roundId, /^\d+-[0-9a-f-]{36}$/)
  assert.equal(new Set(rounds.map(args => args.roundId)).size, rounds.length)
})

test('a group made under the PTC preset relays through run_code', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const blocks = [await relayCall(relay, declared('run_code')), await relayCall(relay, declared('run_code'))]
  const roundIds = []
  for (const block of blocks) {
    assert.equal(block.name, 'run_code')
    const args = JSON.parse(block.arguments)
    const roundId = args.description.match(/^Relay the group chat to its Bots \((\d+-[0-9a-f-]{36})\)$/)?.[1]
    assert.ok(roundId)
    assert.equal(args.code, `return await tools.group_relay({ roundId: ${JSON.stringify(roundId)} })`)
    assert.equal(args.timeoutMs, 600_000)
    roundIds.push(roundId)
  }
  assert.notEqual(roundIds[0], roundIds[1])
})

test('a legacy round without roundId returns the same result as a new one', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  await rt.load()
  const tool = rt.teamTools.find(def => def.name === 'group_relay')
  const exec = { agent: { id: 'room' }, callId: 'legacy', signal: AbortSignal.abort() }
  // Each call names where its rows start in the group's book; the rest of the result is the same.
  const rest = (value) => {
    const { from, anchor, ...others } = JSON.parse(value)
    assert.ok(Number.isInteger(from) && typeof anchor === 'string')
    return others
  }
  const legacy = rest(await tool.execute({}, exec))
  const current = rest(await tool.execute({ roundId: `${Date.now()}-legacy` }, { ...exec, callId: 'current' }))
  assert.deepEqual(current, legacy)
  assert.deepEqual(current, {})
})

test('a group Session without either relay tool ends visibly instead of calling nothing', async (t) => {
  // #826: the relay used to synthesize group_relay even when the Session did not
  // declare it, and the "unknown tool" failure left no trace.
  const { relay, warnings, stop } = start()
  t.after(stop)
  const chunks = await drain(relay({ provider: 'deepseek', model: 'v4', sessionId: 'room', messages: [userText('Hello team')], tools: declared('read', 'write') }, () => {
    throw new Error('a group round never reaches the model')
  }))
  assert.ok(!chunks.some(chunk => chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call'))
  const text = chunks.find(chunk => chunk.type === 'text-delta')?.text
  assert.match(text ?? '', /relay tool is not available/)
  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block?.type, 'text')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(warnings.some(line => line.includes('cannot relay')))
})
