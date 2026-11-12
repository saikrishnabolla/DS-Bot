import assert from 'node:assert/strict'
import test from 'node:test'
import { agentSlashCommands, isSlashCommand } from '../src/slash-commands.js'

test('slash commands open only in Agent chats and keep the original order', () => {
  assert.deepEqual(agentSlashCommands('/', false), [])
  assert.deepEqual(agentSlashCommands('/', true).map(command => command.id), [
    'file', 'goal', 'plan', 'feedback', 'compact', 'permission', 'model', 'export',
  ])
  assert.deepEqual(agentSlashCommands('/co', true).map(command => command.id), ['compact'])
  assert.deepEqual(agentSlashCommands('/compact now', true), [])
})

test('Agent slash lines are intercepted instead of becoming prompts', () => {
  assert.equal(isSlashCommand('/compact', true), true)
  assert.equal(isSlashCommand('/unknown', true), true)
  assert.equal(isSlashCommand('/compact', false), false)
  assert.equal(isSlashCommand('explain /compact', true), false)
})
