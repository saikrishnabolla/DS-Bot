import assert from 'node:assert/strict'
import test from 'node:test'
import { dockCards, tailCards } from '../../../ds-bot/src/client/btw-model.js'
import { proposalPlacement } from '../../../ds-bot/src/client/learning-card-model.js'
import { transcribeWave } from '../../../ds-bot/src/client/speech.js'
import { createConversationState, createVoiceAdapter } from '../src/conversation-state.js'

const transcript = [
  { kind: 'user', text: 'First', seq: 11, turn: 10, time: 100 },
  { kind: 'bot', text: 'One', entryId: 'a1', block: 0, seq: 12, turn: 10, time: 120 },
  { kind: 'user', text: 'Second', seq: 21, turn: 20, time: 200 },
  { kind: 'bot', text: 'Working first', entryId: 'a2', block: 0, seq: 22, turn: 20, time: 220 },
  { kind: 'tool-call', entryId: 't1', block: 0, seq: 23, turn: 20, time: 225 },
  { kind: 'bot', text: 'Two A', entryId: 'a3', block: 0, seq: 24, turn: 20, time: 230 },
  { kind: 'bot', text: 'Two B', entryId: 'a3', block: 1, seq: 24, turn: 20, time: 230 },
]

test('loaded transcript tracks closed and open turns and notifies watchers', () => {
  const state = createConversationState()
  let changes = 0
  const off = state.watchTurns('s1', () => { changes += 1 })

  state.noteChat('s1', transcript, true)
  const live = state.turnFacts('s1')
  assert.equal(changes, 1)
  assert.deepEqual(live.openTurn, { seq: 20 })
  assert.deepEqual(live.turns.get(10), {
    kind: 'turn', turn: 10, start: { seq: 10, time: 100 },
    end: { seq: 12, time: 120 }, status: 'closed',
  })
  assert.deepEqual(live.turns.get(20), {
    kind: 'turn', turn: 20, start: { seq: 20, time: 200 }, status: 'open',
  })

  state.noteChat('s1', transcript, false)
  const settled = state.turnFacts('s1')
  assert.equal(changes, 2)
  assert.equal(settled.openTurn, undefined)
  assert.deepEqual(settled.turns.get(20)?.end, { seq: 24, time: 230 })
  assert.equal(settled.turns.get(20)?.status, 'closed')

  off()
  state.noteChat('s1', [...transcript, { kind: 'user', text: 'Third', seq: 31, turn: 30, time: 300 }], true)
  assert.equal(changes, 2)
})

test('turn facts place side-chat and learning cards from transcript context', () => {
  const state = createConversationState()
  state.noteChat('s1', transcript, true)
  const { turns } = state.turnFacts('s1')
  const closedCard = { id: 'closed', anchorSeq: 10 }
  const openCard = { id: 'open', anchorSeq: 20 }

  assert.deepEqual(dockCards([closedCard, openCard], { turns }).map(card => card.id), ['open'])
  assert.deepEqual(tailCards([closedCard, openCard], turns.get(10), turns).map(card => card.id), ['closed'])
  assert.deepEqual(proposalPlacement({ at: 150 }, turns), { kind: 'turn', turn: 10 })
})

test('closing replies follow the voice lifecycle without throwing', () => {
  const state = createConversationState()
  state.noteChat('s1', transcript, true)
  assert.equal(state.closingReply('missing', 20), null)
  assert.equal(state.closingReply('s1', 20), undefined)

  const spoken = []
  const read = () => {
    const reply = state.closingReply('s1', 20)
    if (reply !== undefined) spoken.push(reply)
  }
  const off = state.watchTurns('s1', read)
  state.noteChat('s1', transcript, false)
  assert.deepEqual(spoken, ['Two A\n\nTwo B'])
  off()

  state.noteChat('s2', [{ kind: 'user', text: 'No answer', seq: 41, turn: 40, time: 400 }], false)
  assert.equal(state.closingReply('s2', 40), '')
})

test('feed messages extend the tracked transcript before React republishes it', () => {
  const state = createConversationState()
  state.noteChat('s1', transcript.slice(0, 3), true)
  for (const item of transcript.slice(3)) state.noteMessage('s1', item)
  state.setRunning('s1', false)
  assert.equal(state.closingReply('s1', 20), 'Two A\n\nTwo B')

  state.noteMessage('s1', transcript.at(-1))
  assert.equal(state.closingReply('s1', 20), 'Two A\n\nTwo B')
})

test('voice adapter exposes an optional speech bridge and preparation', async () => {
  const calls = []
  const speech = {
    prepare: async providerId => { calls.push(providerId); return { ok: true } },
    catalog: async () => ({ ok: true }),
    transcribe: async (id, request) => { calls.push([id, request]); return { ok: true, value: { text: 'heard' } } },
    cancel: id => { calls.push(['cancel', id]) },
  }
  const adapter = createVoiceAdapter(speech)
  assert.equal(adapter.speech().owned, true)
  assert.equal(typeof adapter.speech().transcribe, 'function')
  assert.equal(await adapter.voiceSetup('local').prepare(), true)
  const controller = new AbortController()
  assert.equal(await transcribeWave(adapter.speech(), {
    selection: { providerId: 'local', language: 'en' }, maxAudioBytes: 100,
  }, new Uint8Array([1, 2]), controller.signal), 'heard')
  assert.equal(calls[0], 'local')
  assert.deepEqual(calls[1][1], { audioBase64: 'AQI=', providerId: 'local', language: 'en' })

  let release
  let pendingId
  speech.transcribe = async (id) => {
    pendingId = id
    return await new Promise(resolve => { release = resolve })
  }
  const pending = adapter.speech().transcribe({ audioBase64: 'Yg==' }, controller.signal)
  controller.abort(new Error('stop'))
  assert.deepEqual(calls.at(-1), ['cancel', pendingId])
  release({ ok: false })
  await pending

  const absent = createVoiceAdapter(null)
  assert.equal(absent.speech(), undefined)
  assert.equal(absent.voiceSetup('local'), null)
})
