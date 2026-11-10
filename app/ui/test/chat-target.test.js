import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalsForConversation, chatRequest, feedMatches, stopRequest } from '../src/chat-target.js'

test('chat requests address Bots, group chats and plain Agent sessions', () => {
  assert.deepEqual(chatRequest('b1', undefined), { botId: 'b1' })
  assert.deepEqual(chatRequest(undefined, 'r1', { before: '4' }), { roomId: 'r1', cursor: { before: '4' } })
  assert.deepEqual(chatRequest(undefined, undefined, { before: '4' }, 's1'), { sessionId: 's1', cursor: { before: '4' } })
})

test('feed events stay with their conversation', () => {
  assert.equal(feedMatches('b1', undefined, { botId: 'b1' }), true)
  assert.equal(feedMatches('b1', undefined, { botId: 'b1', roomId: 'r1' }), false)
  assert.equal(feedMatches('b1', undefined, { roomId: 'r1' }), false)
  assert.equal(feedMatches(undefined, 'r1', { roomId: 'r1' }), true)
  assert.equal(feedMatches(undefined, 'r1', { roomId: 'r2' }), false)
  assert.equal(feedMatches(undefined, undefined, { sessionId: 's1' }, 's1'), true)
  assert.equal(feedMatches(undefined, undefined, { sessionId: 's2' }, 's1'), false)
  assert.equal(feedMatches(undefined, undefined, { botId: 'b1', sessionId: 'b1' }, 's1'), false)
})

test('Stop uses the matching work endpoint', () => {
  assert.deepEqual(stopRequest('b1', undefined), { endpoint: 'stop-bot-work', payload: { botId: 'b1' } })
  assert.deepEqual(stopRequest(undefined, 'r1'), { endpoint: 'stop-room-work', payload: { roomId: 'r1' } })
  assert.deepEqual(stopRequest(undefined, undefined, 's1'), { endpoint: 'stop-agent-work', payload: { sessionId: 's1' } })
})

test('approval cards stay with their Bot, group chat, or Agent session', () => {
  const work = { approvals: [
    { id: 'own', botId: 'b1' },
    { id: 'group', botId: 'b1', roomId: 'r1' },
    { id: 'other', botId: 'b2' },
    { id: 'agent', botId: 'a1', sessionId: 's1' },
  ] }
  assert.deepEqual(approvalsForConversation(work, 'b1', undefined).map(entry => entry.id), ['own'])
  assert.deepEqual(approvalsForConversation(work, undefined, 'r1').map(entry => entry.id), ['group'])
  assert.deepEqual(approvalsForConversation(work, undefined, undefined, 's1').map(entry => entry.id), ['agent'])
})
