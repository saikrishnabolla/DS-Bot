import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findTeam, importTeam, sessionIdsOf, teamInUse } from '../src/import.mjs'

function write(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, value)
}

function fixture(root) {
  const from = join(root, 'dsh')
  const state = {
    version: 1,
    workspaceId: 'old-workspace',
    mainBotIds: ['bot-a'],
    bots: { 'bot-a': { id: 'bot-a', name: 'Chief', sessionId: 'chat-a', segments: [{ sessionId: 'chat-a-1' }] } },
    rooms: { 'room-a': { id: 'room-a', name: 'Ops', members: ['bot-a'], sessions: { 'bot-a': 'group-a' } } },
    agents: { old: { id: 'old' } },
  }
  write(join(from, 'bot', 'state.json'), JSON.stringify(state))
  write(join(from, 'bot', 'state.lock'), '{}')
  write(join(from, 'bot', 'inflight.json'), '{}')
  write(join(from, 'bot', 'memory', 'bot-a.md'), 'remember this')
  write(join(from, 'bot', 'workspace', 'notes.txt'), 'old notes')
  for (const id of ['bot-a', 'chat-a', 'chat-a-1', 'room-a', 'group-a']) {
    write(join(from, 'sessions', '--team--', id, 'session.v4.jsonl.zstd'), id)
  }
  write(join(from, 'sessions', '--team--', 'unrelated', 'session.v4.jsonl.zstd'), 'unrelated')
  write(join(from, 'attachments', 'ab', 'file'), 'attachment')
  return { from, state }
}

test('one-way import copies a 0.3.2 team for the owned host without changing the source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-app-import-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { from, state } = fixture(root)
  const before = readFileSync(join(from, 'bot', 'state.json'), 'utf8')
  const to = join(root, 'owned')
  const workspace = join(root, 'DS Bot')
  const summary = await importTeam({ from, to, workspace })

  assert.deepEqual(summary, { from, bots: 1, rooms: 1, sessions: 5, missingSessions: [] })
  const imported = JSON.parse(readFileSync(join(to, 'bot', 'state.json'), 'utf8'))
  assert.equal(imported.workspaceId, undefined)
  assert.deepEqual(imported.agents, {})
  assert.equal(imported.bots['bot-a'].name, 'Chief')
  for (const id of sessionIdsOf(state)) assert.equal(readFileSync(join(to, 'sessions', '--team--', id, 'session.v4.jsonl.zstd'), 'utf8'), id)
  assert.equal(existsSync(join(to, 'sessions', '--team--', 'unrelated')), false)
  assert.equal(readFileSync(join(to, 'attachments', 'ab', 'file'), 'utf8'), 'attachment')
  assert.equal(readFileSync(join(workspace, 'notes.txt'), 'utf8'), 'old notes')
  assert.equal(readFileSync(join(from, 'bot', 'state.json'), 'utf8'), before)
  assert.equal(findTeam(to).bots, 1)
})

test('one-way import honors the workspace choices', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-app-import-options-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { from } = fixture(root)
  write(join(from, 'bot', 'workspace', 'node_modules', 'package', 'index.js'), 'generated')

  const withoutGenerated = join(root, 'without-generated')
  await importTeam({ from, to: join(root, 'owned-a'), workspace: withoutGenerated, leaveRegenerable: true })
  assert.equal(readFileSync(join(withoutGenerated, 'notes.txt'), 'utf8'), 'old notes')
  assert.equal(existsSync(join(withoutGenerated, 'node_modules')), false)

  const withoutWork = join(root, 'without-work')
  await importTeam({ from, to: join(root, 'owned-b'), workspace: withoutWork, skipWork: true })
  assert.equal(existsSync(withoutWork), false)
})

test('one-way import refuses a live source and leaves an aborted target without a team', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-app-import-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { from } = fixture(root)
  write(join(from, 'bot', 'state.lock'), JSON.stringify({ pid: process.pid, host: 'here' }))
  assert.equal(teamInUse(from, { host: 'here' }), true)
  const to = join(root, 'owned')
  await assert.rejects(importTeam({ from, to, workspace: join(root, 'workspace'), signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(existsSync(join(to, 'bot')), false)
})
