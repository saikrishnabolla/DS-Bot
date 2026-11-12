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

test('commands that open selectors or accept optional input run their bare form', () => {
  const commands = agentSlashCommands('/', true)
  assert.deepEqual(commands.filter(command => ['plan', 'permission'].includes(command.id)).map(command => [command.id, command.action, command.line]), [
    ['plan', 'run', '/plan'],
    ['permission', 'run', '/permission'],
  ])
})
