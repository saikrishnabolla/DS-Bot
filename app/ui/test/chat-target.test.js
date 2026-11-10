import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalsForConversation, chatRequest, feedMatches, stopRequest } from '../src/chat-target.js'

test('chat requests address Bots and group chats', () => {
  assert.deepEqual(chatRequest('b1', undefined), { botId: 'b1' })
  assert.deepEqual(chatRequest(undefined, 'r1', { before: '4' }), { roomId: 'r1', cursor: { before: '4' } })
})

test('feed events stay with their conversation', () => {
  assert.equal(feedMatches('b1', undefined, { botId: 'b1' }), true)
  assert.equal(feedMatches('b1', undefined, { botId: 'b1', roomId: 'r1' }), false)
  assert.equal(feedMatches('b1', undefined, { roomId: 'r1' }), false)
  assert.equal(feedMatches(undefined, 'r1', { roomId: 'r1' }), true)
  assert.equal(feedMatches(undefined, 'r1', { roomId: 'r2' }), false)
})

test('Stop uses the matching work endpoint', () => {
  assert.deepEqual(stopRequest('b1', undefined), { endpoint: 'stop-bot-work', payload: { botId: 'b1' } })
  assert.deepEqual(stopRequest(undefined, 'r1'), { endpoint: 'stop-room-work', payload: { roomId: 'r1' } })
})

test('approval cards stay with their Bot or group chat', () => {
  const work = { approvals: [
    { id: 'own', botId: 'b1' },
    { id: 'group', botId: 'b1', roomId: 'r1' },
    { id: 'other', botId: 'b2' },
  ] }
  assert.deepEqual(approvalsForConversation(work, 'b1', undefined).map(entry => entry.id), ['own'])
  assert.deepEqual(approvalsForConversation(work, undefined, 'r1').map(entry => entry.id), ['group'])
})
