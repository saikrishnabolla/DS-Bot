import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopComputerAction, desktopComputerCursor, desktopComputerEntries } from '../src/computer-bridge.js'

test('desktop computer entries include active and waiting Bots', () => {
  const roster = {
    byId: {
      b1: { id: 'b1', name: 'Builder', color: 'violet' },
      b2: { id: 'b2', name: 'Writer', color: 'cyan' },
    },
  }
  const live = {
    leases: [{ botId: 'b1', kind: 'app', appName: 'Notes' }],
    bots: { b2: { waitingFor: 'user-idle' } },
  }
  const value = desktopComputerEntries(roster, live)
  assert.deepEqual(value.rows.map(row => ({ botId: row.botId, waiting: row.waiting === true, label: row.label })), [
    { botId: 'b1', waiting: false, label: 'Builder · Notes' },
    { botId: 'b2', waiting: true, label: 'Writer waits for the computer' },
  ])
  assert.deepEqual(value.labels, { stop: 'Stop', stopAll: 'Stop all', letGo: 'Let it continue' })
})

test('desktop computer actions use the existing public operations', () => {
  const calls = []
  const actions = {
    computerStop: (botId, all) => { calls.push(['stop', botId, all]) },
    computerAllowForeground: botId => { calls.push(['continue', botId]) },
  }
  desktopComputerAction(actions, { kind: 'stop', botId: 'b1' })
  desktopComputerAction(actions, { kind: 'stopall', botId: null })
  desktopComputerAction(actions, { kind: 'letgo', botId: 'b2' })
  assert.deepEqual(calls, [
    ['stop', 'b1', undefined],
    ['stop', null, true],
    ['continue', 'b2'],
  ])
})

test('desktop cursor events carry the Bot look', () => {
  const roster = { byId: { b1: { id: 'b1', color: 'violet', avatar: { image: 'data:image/png;base64,YQ==' } } } }
  assert.deepEqual(desktopComputerCursor(roster, { botId: 'b1', x: 20, y: 40 }), {
    botId: 'b1', x: 20, y: 40, color: '#8B5CF6', avatar: 'data:image/png;base64,YQ==',
  })
})
