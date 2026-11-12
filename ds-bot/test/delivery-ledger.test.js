import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { install as installDelivery } from '../src/host/delivery.js'
import { bookFile, install as installLedger, parseBook } from '../src/host/ledger.js'

function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-delivery-ledger-'))
  const delivered = []
  const warnings = []
  const cleanups = []
  let flush = async () => {}
  const agent = { session: { id: 'b' }, followup: message => delivered.push(message), steer: message => delivered.push(message) }
  const ctx = {
    effect(setup) {
      const cleanup = setup()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    sessionController: { resolveAgent: async () => ({ agent }) },
    sessions: { flush: (...args) => flush(...args) },
  }
  const bots = {
    a: { id: 'a', name: 'Chief', sessionId: 'a' },
    b: { id: 'b', name: 'Writer', sessionId: 'b' },
  }
  const rt = {
    home,
    ctx,
    state: { exchanges: [] },
    readOnly: () => undefined,
    warn: (...args) => warnings.push(args),
    botOf: id => bots[id],
    roomOf: () => undefined,
    chatOf: id => bots[id]?.sessionId ?? id,
    ensureCapabilities: async () => {},
    hideBotUnusedTools: () => {},
  }
  installLedger(rt)
  installDelivery(rt)
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return {
    rt,
    home,
    delivered,
    warnings,
    setFlush: next => { flush = next },
    records: () => parseBook(readFileSync(join(home, 'ledger', bookFile('pair-a-b')), 'utf8')),
  }
}

const request = (rt, extra = {}) => rt.deliver({
  fromId: 'a',
  toId: 'b',
  role: 'request',
  text: 'Draft the plan',
  exchangeId: 'message-1',
  ...extra,
})

test('a Bot message is recorded before delivery and listed only after its delivery mark', async (t) => {
  const { rt, delivered, records } = start(t)
  await request(rt)
  assert.equal(delivered.length, 1)
  assert.deepEqual(records().map(record => record.event ?? 'message'), ['message', 'delivered'])
  assert.deepEqual(rt.exchangesOf('a', 'b').map(entry => [entry.id, entry.text]), [['message-1', 'Draft the plan']])
})

test('a Bot message is not sent when its ledger record cannot be written', async (t) => {
  const { rt, home, delivered, warnings } = start(t)
  writeFileSync(join(home, 'ledger'), 'not a directory')
  await assert.rejects(request(rt), /EEXIST|ENOTDIR/)
  await setImmediate()
  assert.equal(delivered.length, 0)
  assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  assert.ok(warnings.some(args => String(args.at(-1)).match(/EEXIST|ENOTDIR/)))
})

test('a merged request that fails delivery leaves the last delivered text in the dialog', async (t) => {
  const { rt, setFlush } = start(t)
  await request(rt, { text: 'First version' })
  setFlush(async () => { throw new Error('session write failed') })
  await assert.rejects(request(rt, { text: 'Replacement', merged: true }), /session write failed/)
  assert.deepEqual(rt.exchangesOf('a', 'b').map(entry => entry.text), ['First version'])
})
