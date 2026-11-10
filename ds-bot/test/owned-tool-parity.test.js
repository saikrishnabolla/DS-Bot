import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { OwnedHost } from '../src/engine/owned-host.js'
import { htmlToGfm, pinnedLookup, safeWebFetch } from '../src/engine/owned-desktop-tools.js'

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
  return { host, workspacePath, requests, faux }
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
  assert.ok(names.has('pwsh'))
  assert.equal(names.has('powershell'), false)
  assert.equal(names.has('bash'), false)
})

test('owned Host guards the Windows pwsh shell with the normal approval', async t => {
  const { host, faux } = await fixture(t, { platform: 'win32' })
  const state = await host.runtime.handle('state', { locale: 'en' })
  const bot = state.value.bots[0]
  assert.equal((await host.runtime.handle('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  const agent = await host.runtime.resolveAgent(bot.id)
  await agent.whenIdle()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('pwsh', { command: 'Write-Output guarded' }, { id: 'guarded-pwsh' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The command was not run.'),
  ])

  assert.equal((await host.runtime.handle('send', { sessionId: bot.id, text: 'Try the Windows shell.' })).ok, true)
  const approval = await waitFor(async () => {
    const current = await host.runtime.handle('state', { locale: 'en' })
    return current.value.work.approvals.find(item => item.tool === 'pwsh')
  })
  assert.match(approval.reason, /run this shell command/)
  assert.equal((await host.runtime.handle('approval-answer', { id: approval.id, choice: 'reject' })).ok, true)
  await agent.whenIdle()
})

test('owned Host carries plan review through the existing question-card API', async t => {
  const { host, faux } = await fixture(t)
  const state = await host.runtime.handle('state', { locale: 'en' })
  const bot = state.value.bots[0]
  assert.equal((await host.runtime.handle('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  const agent = await host.runtime.resolveAgent(bot.id)
  await agent.whenIdle()
  assert.equal(await host.runtime.ctx.get('planMode').set(agent, true), 'committed')
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Review this plan\n\n1. Keep the existing interface.' }, { id: 'plan-call' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The approved plan is ready to carry out.'),
  ])

  assert.equal((await host.runtime.handle('send', { sessionId: bot.id, text: 'Make a plan.' })).ok, true)
  const card = await waitFor(async () => {
    const current = await host.runtime.handle('state', { locale: 'en' })
    return Object.values(current.value.questions).find(question => question.blockingKind === 'plan-review')
  })
  assert.equal(card.callId, 'plan-call')
  assert.equal(card.detail, '# Review this plan\n\n1. Keep the existing interface.')
  assert.deepEqual(card.options.map(option => option.label), ['Approve', 'Keep planning'])
  assert.equal((await host.runtime.handle('answer-question', {
    sessionId: bot.id,
    questionId: card.id,
    answer: { selected: ['Approve'] },
  })).ok, true)
  await agent.whenIdle()

  assert.deepEqual(await host.runtime.ctx.get('planMode').get(agent), { active: false, entered: true })
  const page = await host.runtime.ctx.sessionController.page({ sessionId: agent.id, maxMessages: 30 })
  const result = page.records.find(record => record.event.type === 'tool/result' && record.event.data.message.toolCallId === 'plan-call')
  assert.equal(result.event.data.message.isError, false)
  assert.match(result.event.data.message.content[0].text, /Plan approved/)
})

test('owned Host dismisses a plan card without leaving plan mode or a hung turn', async t => {
  const { host, faux } = await fixture(t)
  const state = await host.runtime.handle('state', { locale: 'en' })
  const bot = state.value.bots[0]
  assert.equal((await host.runtime.handle('update-bot', { id: bot.id, model: 'faux/faux-1' })).ok, true)
  const agent = await host.runtime.resolveAgent(bot.id)
  await agent.whenIdle()
  await host.runtime.ctx.get('planMode').set(agent, true)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('exit_plan_mode', { plan: '# Dismissed plan\n\n1. Wait for feedback.' }, { id: 'dismissed-plan-call' }), { stopReason: 'toolUse' }),
  ])

  assert.equal((await host.runtime.handle('send', { sessionId: bot.id, text: 'Show the plan.' })).ok, true)
  const card = await waitFor(async () => {
    const current = await host.runtime.handle('state', { locale: 'en' })
    return Object.values(current.value.questions).find(question => question.blockingKind === 'plan-review')
  })
  assert.equal((await host.runtime.handle('dismiss-question', { sessionId: agent.id, questionId: card.id })).ok, true)
  await agent.whenIdle()

  assert.deepEqual(await host.runtime.ctx.get('planMode').get(agent), { active: true, entered: true })
  const page = await host.runtime.ctx.sessionController.page({ sessionId: agent.id, maxMessages: 30 })
  const result = page.records.find(record => record.event.type === 'tool/result' && record.event.data.message.toolCallId === 'dismissed-plan-call')
  assert.equal(result.event.data.message.isError, false)
  assert.match(result.event.data.message.content[0].text, /plan mode remains active/i)
})

test('owned desktop tools search files, replace todos, present files, and use the injected web seam', async t => {
  const searches = []
  const { host, workspacePath } = await fixture(t, {
    web: {
      search: async request => {
        searches.push(request)
        return { content: `answer for ${request.query}`, sources: [{ url: `https://example.com/${request.query}`, title: request.query }], truncated: false }
      },
      fetch: async request => ({
        url: request.url,
        statusCode: 200,
        body: { kind: 'html', content: request.url.endsWith('/large') ? `<p>${'x'.repeat(1_100_000)}</p>` : [
          '<main><h1>Useful page</h1><p>See <a href="/docs">the docs</a>.</p>',
          '<ul><li>First</li><li>Second</li></ul>',
          '<pre><code class="language-js">const answer = 42\nconsole.log(answer)</code></pre>',
          '<table><tr><th>Name</th><th>Value</th></tr><tr><td>answer</td><td>42</td></tr></table>',
          '<script>ignore me</script><div hidden>hidden one</div><div aria-hidden="true">hidden two</div>',
          '<div style="display: none !important">hidden three</div></main>',
        ].join('') },
        truncated: false,
      }),
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
  assert.deepEqual(presented.structuredOutput.files, [{ path: await realpath(join(workspacePath, 'notes', 'parity.txt')), description: 'Parity evidence' }])
  await symlink(tmpdir(), join(workspacePath, 'notes', 'outside'))
  await assert.rejects(toolOf(host, 'present').execute({ files: [{ path: 'notes/outside' }] }, exec), /outside the Session working directory/)

  const searched = await toolOf(host, 'web_search').execute({ queries: ['alpha', 'beta'] }, exec)
  assert.deepEqual(searches.map(request => request.query), ['alpha', 'beta'])
  assert.match(outputText(searched), /External web content follows/)
  assert.match(outputText(searched), /https:\/\/example\.com\/alpha/)
  const fetched = await toolOf(host, 'web_fetch').execute({ url: 'https://example.com/page' }, exec)
  const fetchedText = outputText(fetched)
  assert.match(fetchedText, /# Useful page/)
  assert.match(fetchedText, /\[the docs\]\(\/docs\)/)
  assert.match(fetchedText, /-\s+First/)
  assert.match(fetchedText, /```js\nconst answer = 42/)
  assert.match(fetchedText, /\| Name\s+\| Value\s+\|/)
  assert.doesNotMatch(fetchedText, /ignore me|hidden one|hidden two|hidden three/)
  const large = outputText(await toolOf(host, 'web_fetch').execute({ url: 'https://example.com/large' }, exec))
  assert.ok(large.length < 201_000)
  assert.match(large, /Content truncated/)
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

test('owned background jobs bound memory, retain complete output, and stop process groups on close', async t => {
  const { host, workspacePath } = await fixture(t)
  const state = await host.runtime.handle('state', { locale: 'en' })
  const bot = state.value.bots[0]
  const agent = { id: bot.id, session: { id: bot.id, header: {} } }
  const shell = toolOf(host, 'bash')
  const exec = { agent, callId: 'call-jobs-bounded', signal: new AbortController().signal }
  const large = await shell.execute({
    command: "node -e \"process.stdout.write('x'.repeat(3 * 1024 * 1024))\"",
    run_in_background: true,
  }, { conversationId: bot.id, callId: 'call-large' }, { abortSignal: exec.signal })
  const largeId = large.structuredOutput.jobId
  const retained = await toolOf(host, 'job_output').execute({ job_id: largeId, wait: true, timeout_ms: 5_000 }, exec)
  assert.match(outputText(retained), /some output was dropped from memory/)
  assert.ok(Buffer.byteLength(retained.structuredOutput.text) <= 1_048_576)
  const spillPath = retained.structuredOutput.job.output.spillPaths[0]
  await waitFor(async () => (await stat(spillPath)).size === 3 * 1024 * 1024)
  assert.equal((await stat(spillPath)).size, 3 * 1024 * 1024)

  const pidFile = join(workspacePath, 'background-child.pid')
  const child = await shell.execute({
    command: `node -e 'require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)'`,
    run_in_background: true,
  }, { conversationId: bot.id, callId: 'call-child' }, { abortSignal: exec.signal })
  assert.ok(child.structuredOutput.jobId)
  const childPid = await waitFor(async () => {
    try { return Number(await readFile(pidFile, 'utf8')) || undefined } catch { return undefined }
  })
  await host.close()
  await waitFor(() => {
    try { process.kill(childPid, 0); return false } catch (error) { return error?.code === 'ESRCH' }
  })
})

test('a private-chat steer promotes a running shell and reaches the next model request', async t => {
  const { host, faux } = await fixture(t)
  const state = await host.runtime.handle('state', { locale: 'en' })
  const bot = state.value.bots[0]
  assert.equal((await host.runtime.handle('update-bot', { id: bot.id, model: 'faux/faux-1', permission: 'danger-full-access' })).ok, true)
  const agent = await host.runtime.resolveAgent(bot.id)
  await agent.whenIdle()

  let steeredAt
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'node -e "setTimeout(() => {}, 4000)"' }, { id: 'call-steer-shell' }), { stopReason: 'toolUse' }),
    async () => {
      steeredAt = Date.now()
      return fauxAssistantMessage('Steer received.')
    },
  ])
  assert.equal((await host.runtime.handle('send', { sessionId: bot.id, text: 'Start the long command.' })).ok, true)
  const jobs = host.runtime.ctx.get('jobs')
  const running = await waitFor(() => jobs.list(agent.id).find(job => job.status === 'running'))
  const sentAt = Date.now()
  assert.equal((await host.runtime.handle('send', { sessionId: bot.id, text: 'Change course now.' })).ok, true)
  await waitFor(() => steeredAt, 2_500)

  assert.ok(steeredAt - sentAt < 2_000)
  assert.equal(jobs.get(running.id, agent.id).status, 'running')
})

test('owned web fetch blocks local network destinations before connecting', async () => {
  await assert.rejects(safeWebFetch({ url: 'http://127.0.0.1/private' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'http://[::1]/private' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'http://[::ffff:127.0.0.1]/private' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'http://169.254.169.254/latest/meta-data' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'http://100.64.0.1/private' }), /blocked private address/)
  await assert.rejects(safeWebFetch({ url: 'file:///etc/passwd' }), /HTTP\(S\)/)
})

test('owned web fetch keeps DNS pinning under single-address and all-address clients', async () => {
  const pinned = { address: '203.0.113.9', family: 4 }
  const lookup = pinnedLookup(pinned)
  assert.deepEqual(await new Promise((resolve, reject) => lookup('ignored.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }))), pinned)
  assert.deepEqual(await new Promise((resolve, reject) => lookup('ignored.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), [pinned])
})

test('owned web fetch preserves GFM structure and rejects pathological HTML depth', () => {
  const markdown = htmlToGfm('<article><h2>Details</h2><ol><li>One</li><li>Two</li></ol><blockquote>Note</blockquote><table><tr><th>A</th></tr><tr><td>B</td></tr></table></article>')
  assert.match(markdown, /^## Details/m)
  assert.match(markdown, /1\.\s+One/)
  assert.match(markdown, /> Note/)
  assert.match(markdown, /\| A\s+\|/)
  const deep = `${'<div>'.repeat(257)}value${'</div>'.repeat(257)}`
  assert.throws(() => htmlToGfm(deep), /nesting exceeds 256/)
})

test('owned web fetch enforces redirect, media type, charset, and decoding contracts', async () => {
  const page = (statusCode, headers, bytes = Buffer.alloc(0), truncated = false) => ({
    response: { statusCode, headers }, bytes, truncated,
  })
  const seen = []
  const redirected = await safeWebFetch({ url: 'https://example.com/start' }, undefined, {
    request: async url => {
      seen.push(url.href)
      if (url.pathname === '/start') return page(302, { location: '/final' })
      return page(200, { 'content-type': 'text/plain; charset=utf-16le' }, Buffer.from('decoded', 'utf16le'))
    },
  })
  assert.deepEqual(seen, ['https://example.com/start', 'https://example.com/final'])
  assert.equal(redirected.url, 'https://example.com/final')
  assert.deepEqual(redirected.body, { kind: 'text', content: 'decoded' })

  let calls = 0
  await assert.rejects(safeWebFetch({ url: 'https://example.com/start' }, undefined, {
    request: async () => { calls += 1; return page(302, { location: 'https://other.example/final' }) },
  }), /blocked a cross-origin redirect/)
  assert.equal(calls, 1)

  await assert.rejects(safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, { 'content-type': 'application/octet-stream' }, Buffer.from([0, 1, 2])),
  }), /does not support Content-Type application\/octet-stream/)
  await assert.rejects(safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, {}, Buffer.from('plain')),
  }), /missing or invalid Content-Type/)
  await assert.rejects(safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, { 'content-type': 'text/plain; charset=not-a-real-charset' }, Buffer.from('plain')),
  }), /does not support charset/)
  await assert.rejects(safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, { 'content-type': 'text/plain; charset=' }, Buffer.from('plain')),
  }), /invalid charset/)
  await assert.rejects(safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, { 'content-type': 'text/plain; charset=utf-8; charset=utf-16le' }, Buffer.from('plain')),
  }), /conflicting charset/)
  await assert.rejects(safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from([0xc3, 0x28])),
  }), /could not decode utf-8 content/)
  const clipped = await safeWebFetch({ url: 'https://example.com/file' }, undefined, {
    request: async () => page(200, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('text €').subarray(0, -1), true),
  })
  assert.equal(clipped.body.content, 'text ')
  assert.equal(clipped.truncated, true)
})
