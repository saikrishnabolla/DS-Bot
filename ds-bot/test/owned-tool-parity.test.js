import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'
import { safeWebFetch } from '../src/engine/owned-desktop-tools.js'

const waitFor = async (check, timeout = 5_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the owned tool parity fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const outputText = result => result.output?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
const toolOf = (host, name) => host.runtime.teamTools.find(tool => tool.name === name)

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-owned-tools-'))
  const dataDir = join(root, 'data')
  const uiDir = join(root, 'ui')
  const workspacePath = join(root, 'workspace')
  await Promise.all([mkdir(dataDir), mkdir(uiDir), mkdir(workspacePath)])
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>DS Bot</title>')
  await writeFile(join(workspacePath, 'AGENTS.md'), '# Project rules\n\nKeep parity marker 4815 in every answer.\n')
  const models = await ModelRuntime.create({ authPath: join(dataDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider()
  const requests = []
  faux.setResponses(Array.from({ length: 40 }, () => async context => {
    requests.push(context)
    return fauxAssistantMessage('Ready.')
  }))
  models.registerNativeProvider(faux.provider)
  await models.refresh({ allowNetwork: false })
  const host = await OwnedHost.open({ dataDir, uiDir, workspacePath, models, ...options })
  t.after(async () => {
    await host.close()
    await rm(root, { recursive: true, force: true })
  })
  return { host, workspacePath, requests }
}

test('owned Host keeps the standard desktop tool catalog and project instructions', async t => {
  const { host, requests, workspacePath } = await fixture(t)
  const state = await host.runtime.handle('state', { locale: 'en' })
  assert.equal(state.ok, true)
  const bot = state.value.bots[0]
  assert.equal(host.runtime.sessionFolder({ id: bot.id, header: {} }), workspacePath)
  assert.equal((await host.runtime.handle('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  await waitFor(() => requests.length > 0)
  assert.equal((await host.runtime.handle('send', { sessionId: bot.id, text: 'Check the project rules.' })).ok, true)
  await waitFor(() => requests.find(item => JSON.stringify(item).includes('Check the project rules.')))
  const names = new Set(host.runtime.teamTools.map(tool => tool.name))
  for (const name of [
    'bash', 'glob', 'grep', 'job_kill', 'job_list', 'job_output', 'present', 'todo_write', 'web_fetch', 'web_search',
  ]) assert.ok(names.has(name), `missing ${name}`)
  assert.equal(names.has('powershell'), false)
  assert.match(JSON.stringify(requests), /Keep parity marker 4815 in every answer/)
})

test('owned Host selects PowerShell instead of bash for Windows', async t => {
  const { host } = await fixture(t, { platform: 'win32' })
  const names = new Set(host.runtime.teamTools.map(tool => tool.name))
  assert.ok(names.has('powershell'))
  assert.equal(names.has('bash'), false)
})

test('owned desktop tools search files, replace todos, present files, and use the injected web seam', async t => {
  const searches = []
  const { host, workspacePath } = await fixture(t, {
    web: {
      search: async request => {
        searches.push(request)
        return { content: `answer for ${request.query}`, sources: [{ url: `https://example.com/${request.query}`, title: request.query }], truncated: false }
      },
      fetch: async request => ({ url: request.url, statusCode: 200, body: { kind: 'html', content: '<main><h1>Useful page</h1><script>ignore me</script></main>' }, truncated: false }),
    },
  })
  await mkdir(join(workspacePath, 'notes'))
  await writeFile(join(workspacePath, 'notes', 'parity.txt'), 'owned tool marker 719\n')
  const agent = { id: 'tool-owner', session: { id: 'tool-owner', header: { cwd: workspacePath } } }
  const exec = { agent, callId: 'call-tools', signal: new AbortController().signal }

  const glob = await toolOf(host, 'glob').execute({ pattern: '**/*.txt' }, exec)
  assert.match(outputText(glob), /notes\/parity\.txt/)
  const grep = await toolOf(host, 'grep').execute({ pattern: 'marker 719', path: '.' }, exec)
  assert.match(outputText(grep), /parity\.txt/)

  const todo = await toolOf(host, 'todo_write').execute({ todos: [
    { content: 'Verify catalog', status: 'completed' },
    { content: 'Verify behavior', status: 'in_progress' },
  ] }, exec)
  assert.equal(outputText(todo), 'Updated todo list: 0 pending, 1 in progress, 1 completed.')
  assert.throws(() => toolOf(host, 'todo_write').execute({ todos: [
    { content: 'duplicate', status: 'pending' }, { content: 'duplicate', status: 'completed' },
  ] }, exec), /duplicate content/)

  const presented = await toolOf(host, 'present').execute({ files: [{ path: 'notes/parity.txt', description: 'Parity evidence' }] }, exec)
  assert.deepEqual(presented.structuredOutput.files, [{ path: join(workspacePath, 'notes', 'parity.txt'), description: 'Parity evidence' }])

  const searched = await toolOf(host, 'web_search').execute({ queries: ['alpha', 'beta'] }, exec)
  assert.deepEqual(searches.map(request => request.query), ['alpha', 'beta'])
  assert.match(outputText(searched), /External web content follows/)
  assert.match(outputText(searched), /https:\/\/example\.com\/alpha/)
  const fetched = await toolOf(host, 'web_fetch').execute({ url: 'https://example.com/page' }, exec)
  assert.match(outputText(fetched), /Useful page/)
  assert.doesNotMatch(outputText(fetched), /ignore me/)
})

test('owned background shell registers, streams, consumes, lists, and fences jobs', async t => {
  const { host } = await fixture(t)
  const state = await host.runtime.handle('state', { locale: 'en' })
  const bot = state.value.bots[0]
  const agent = { id: bot.id, session: { id: bot.id, header: {} } }
  const shell = toolOf(host, 'bash')
  const started = await shell.execute({ command: "printf 'job parity 913\\n'", run_in_background: true }, {
    conversationId: bot.id,
    callId: 'call-background',
  }, { abortSignal: new AbortController().signal })
  const jobId = started.structuredOutput.jobId
  const exec = { agent, callId: 'call-jobs', signal: new AbortController().signal }
  const output = await toolOf(host, 'job_output').execute({ job_id: jobId, wait: true, timeout_ms: 5_000 }, exec)
  assert.match(outputText(output), /job parity 913/)
  assert.equal(output.structuredOutput.job.status, 'completed')
  const consumed = await toolOf(host, 'job_output').execute({ job_id: jobId }, exec)
  assert.match(outputText(consumed), /no new output/)
  const listed = await toolOf(host, 'job_list').execute({}, exec)
  assert.ok(listed.structuredOutput.some(job => job.id === jobId && job.status === 'completed'))
  const killed = await toolOf(host, 'job_kill').execute({ job_id: jobId }, exec)
  assert.equal(killed.structuredOutput.outcome, 'already-finished')
  await assert.rejects(toolOf(host, 'job_output').execute({ job_id: jobId }, { ...exec, agent: { ...agent, id: 'other' } }), /Unknown job/)
})

test('owned web fetch blocks local network destinations before connecting', async () => {
  await assert.rejects(safeWebFetch({ url: 'http://127.0.0.1/private' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'http://[::1]/private' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'file:///etc/passwd' }), /HTTP\(S\)/)
})
