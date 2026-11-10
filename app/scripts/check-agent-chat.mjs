import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repository = join(root, '..')
const electron = createRequire(join(root, 'package.json'))('electron')
const runRoot = await mkdtemp(join(tmpdir(), 'cue-agent-chat-'))
const screenshot = join(tmpdir(), 'cue-agent-chat-check.png')
const queueScreenshot = join(tmpdir(), 'cue-agent-queue-check.png')
const failureScreenshot = join(tmpdir(), 'cue-bot-failure-check.png')
const pluginScreenshot = join(tmpdir(), 'cue-client-plugin-check.png')
const debugPort = 10_000 + (process.pid % 20_000)
const children = new Set()

const spawnChild = (command, args, options) => {
  const child = spawn(command, args, options)
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function startMock() {
  const mock = spawnChild(process.execPath, [join(repository, 'ds-bot', 'dev', 'mock-llm.mjs')], {
    env: {
      ...process.env,
      MOCK_PORT: '0',
      MOCK_LOG: join(runRoot, 'mock.jsonl'),
      MOCK_DELAY_MS: '1800',
      MOCK_JITTER_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', chunk => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/v1/u.exec(chunk)
      if (match) resolve({ child: mock, baseUrl: `http://127.0.0.1:${match[1]}/v1` })
    })
    mock.once('error', reject)
    mock.once('exit', code => reject(new Error(`mock model exited before it was ready (${String(code)})`)))
  })
}

async function pageTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(debugPort)}/json/list`)).json()
      const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch {
      // Electron has not opened its debugging port yet.
    }
    await sleep(100)
  }
  throw new Error('the Cue app page did not appear')
}

function devtools(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => socket.close() }
}

async function closeBrowser(app) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${String(debugPort)}/json/version`)).json()
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    socket.close()
  } catch {
    app.kill()
  }
}

let app
let cdp
try {
  await mkdir(join(runRoot, 'workspace'), { recursive: true })
  const pluginPath = join(runRoot, 'client-plugin')
  await mkdir(pluginPath, { recursive: true })
  await writeFile(join(pluginPath, 'package.json'), `${JSON.stringify({
    name: 'cue-client-e2e',
    version: '1.0.0',
    cue: { plugins: ['./plugin.mjs'], client: ['./client.mjs'] },
  })}\n`)
  await writeFile(join(pluginPath, 'plugin.mjs'), `
export default api => api.tools.register({
  name: 'client_e2e_echo',
  description: 'Echo text for the client plugin check.',
  parameters: { text: { type: 'string', required: true } },
  execute: async ({ text }) => 'client-e2e:' + text,
})
`)
  await writeFile(join(pluginPath, 'client.mjs'), `
export default api => {
  api.ui.style('[data-cue-client-e2e] { padding: 16px; }')
  return api.ui.register('settings.page', { id: 'client-e2e', label: 'Client E2E' }, ({ package: pkg, Section, Row }) =>
    api.React.createElement('div', { 'data-cue-client-e2e': '', 'data-version': pkg.version },
      api.React.createElement(Section, { title: 'Client plugin' },
        api.React.createElement(Row, { label: 'Loaded version', hint: 'Rendered from an installed Cue package.' }, pkg.version))))
}
`)
  const mock = await startMock()
  const appEnv = { ...process.env }
  for (const key of Object.keys(appEnv)) {
    if (key.endsWith('_API_KEY') || key.startsWith('AWS_')) delete appEnv[key]
  }
  delete appEnv.ELECTRON_RUN_AS_NODE
  Object.assign(appEnv, {
    DS_BOT_HOME: join(runRoot, 'data'),
    DS_BOT_SHELL_DATA: join(runRoot, 'shell'),
    DS_BOT_WORKSPACE: join(runRoot, 'workspace'),
  })
  app = spawnChild(electron, [root, `--remote-debugging-port=${String(debugPort)}`], { env: appEnv, stdio: 'inherit' })

  const page = await pageTarget(Date.now() + 60_000)
  cdp = devtools(page.webSocketDebuggerUrl)
  await cdp.opened
  await cdp.call('Page.enable')
  const evaluate = async expression => {
    const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const waitFor = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${expression}`)
  }
  const api = async (endpoint, payload = {}) => {
    const result = await evaluate(`fetch('/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify({ endpoint, payload }))},
    }).then(response => response.json())`)
    if (result?.ok !== true) throw new Error(result?.error?.message ?? `${endpoint} failed`)
    return result.value
  }
  const send = async text => {
    await evaluate(`(() => {
      const field = document.querySelector('textarea[data-composer-input]')
      if (!field) throw new Error('Agent composer is missing')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)})
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor("!document.querySelector('.dsb-send')?.disabled")
    await evaluate("document.querySelector('.dsb-send').click()")
  }

  await waitFor("document.querySelector('[data-bot-id]') && document.querySelector('textarea[data-composer-input]')")
  await api('provider-add', {
    custom: true,
    provider: 'runtime-check',
    name: 'Runtime check',
    api: 'anthropic-messages',
    baseURL: mock.baseUrl,
    key: 'mock-key',
    models: [{ id: 'mock-1', name: 'Mock 1', inputModalities: ['text'], contextWindow: 128000, maxTokens: 4096 }],
  })

  const initialState = await api('state', { locale: 'en' })
  const mainBotId = initialState.mainBotId
  if (!mainBotId) throw new Error('The Main Bot is missing')
  await api('update-bot', { id: mainBotId, model: 'runtime-check/mock-1' })
  await waitFor(`document.querySelector('[data-bot-id="${mainBotId}"]')`)
  await evaluate(`document.querySelector('[data-bot-id="${mainBotId}"]').click()`)
  await waitFor("document.querySelector('textarea[data-composer-input]')?.placeholder?.startsWith('Message ')")
  await send('报错')
  await waitFor("document.querySelector('.bt-fail:not([data-settled])')", 20_000)
  const failureFallback = await evaluate("document.querySelectorAll('.dsb-failure').length")
  if (failureFallback !== 0) throw new Error('The failed Bot turn used the desktop fallback instead of the repair card')
  await evaluate("document.querySelector('.bt-fail-tech summary').click()")
  await waitFor("document.querySelector('.bt-fail-tech')?.innerText.includes('401')").catch(() => {})
  const technicalDetails = await evaluate("document.querySelector('.bt-fail-tech')?.innerText")
  if (!technicalDetails?.includes('AUTH') || !technicalDetails.includes('401')) {
    throw new Error(`The repair card lost its technical details: ${JSON.stringify(technicalDetails)}`)
  }
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.bt-fail button')].find(node => node.textContent.trim() === 'Enter the key again')
    if (!button) throw new Error('The key recovery action is missing')
    button.click()
    return true
  })()`)
  await waitFor("document.querySelector('.bt-model-key input')")
  await evaluate(`(() => {
    const input = document.querySelector('.bt-model-key input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'fixed-mock-key')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor("!document.querySelector('.bt-model-key .bt-q-submit')?.disabled")
  await evaluate("document.querySelector('.bt-model-key .bt-q-submit').click()")
  try {
    await waitFor("!document.querySelector('.bt-model-key') && [...document.querySelectorAll('.bt-fail button')].some(node => node.textContent.trim() === 'Retry')")
  } catch (error) {
    const diagnostic = await evaluate(`({
      failure: document.querySelector('.bt-fail')?.innerText,
      keyCard: document.querySelector('.bt-model-key')?.innerText,
      body: document.body.innerText.slice(-1600),
    })`)
    const state = await api('state', { locale: 'en' })
    const providers = await api('providers')
    throw new Error(`${error.message}: ${JSON.stringify({ diagnostic, bot: state.bots.find(bot => bot.id === mainBotId), providers })}`)
  }
  const failureCapture = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(failureScreenshot, Buffer.from(failureCapture.data, 'base64'))
  await evaluate(`(() => {
    const original = window.fetch.bind(window)
    window.__cueApiCalls = []
    window.fetch = (input, init) => {
      try {
        if (typeof init?.body === 'string') window.__cueApiCalls.push(JSON.parse(init.body))
      } catch {}
      return original(input, init)
    }
    return true
  })()`)
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.bt-fail button')].find(node => node.textContent.trim() === 'Retry')
    if (!button) throw new Error('Retry is missing after the key was replaced')
    button.click()
    return true
  })()`)
  await waitFor("window.__cueApiCalls.some(call => call.endpoint === 'resume' && call.payload?.botId)")
  await waitFor("document.querySelector('[data-chat-flow]')?.innerText.includes('收到：')", 20_000)
  const retryCalls = await evaluate("window.__cueApiCalls.filter(call => call.endpoint === 'resume')")
  if (retryCalls.length !== 1 || retryCalls[0].payload?.botId !== mainBotId) {
    throw new Error(`Retry did not resume the failed Main Bot exactly once: ${JSON.stringify(retryCalls)}`)
  }

  const added = await api('add-agent')
  const sessionId = added.sessions[0]
  await waitFor(`document.querySelector('[data-agent-id="${added.id}"]')`)
  await evaluate(`document.querySelector('[data-agent-id="${added.id}"]').click()`)
  await waitFor(`document.querySelector('textarea[data-composer-input]')?.placeholder === 'Message Agent'`)

  const first = 'Agent runtime proof'
  await send(first)
  try {
    await waitFor(`document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(`收到：${first}`)})`, 20_000)
  } catch (error) {
    const diagnostic = await evaluate(`({
      body: document.body.innerText.slice(-1600),
      flow: document.querySelector('[data-chat-flow]')?.innerText,
      alert: document.querySelector('[role="alert"]')?.innerText,
    })`)
    const host = await evaluate(`(async () => {
      const post = (endpoint, payload = {}) => fetch('/api/bot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      }).then(response => response.json())
      const state = await post('state', { locale: 'en' })
      return {
        history: await post('agent-chat', { sessionId: ${JSON.stringify(sessionId)} }),
        sessions: await post('agent-sessions'),
        state: state.ok ? {
          defaultModel: state.value.defaultModel,
          models: state.value.models.filter(model => model.needsKey !== true).slice(0, 10),
          agents: state.value.agents,
        } : state,
      }
    })()`)
    throw new Error(`${error.message}: ${JSON.stringify({ ...diagnostic, host })}`)
  }

  await evaluate("document.querySelector('[data-bot-id]').click()")
  await waitFor("document.querySelector('[data-bot-id][aria-current=\"page\"]')")
  await evaluate(`document.querySelector('[data-agent-id="${added.id}"]').click()`)
  await waitFor(`document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(first)})`)
  await waitFor(`document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(`收到：${first}`)})`)

  const queueAnchor = 'Queue anchor turn'
  const queuedFollowUp = 'Queued follow-up proof'
  await send(queueAnchor)
  await waitFor("document.querySelector('.dsb-stop')")
  await send(queuedFollowUp)
  try {
    await waitFor(`document.querySelector('[data-queue-dock]')?.innerText.includes(${JSON.stringify(queuedFollowUp)})`)
  } catch (error) {
    const diagnostic = await evaluate(`({
      body: document.body.innerText.slice(-1800),
      flow: document.querySelector('[data-chat-flow]')?.innerText,
      queue: document.querySelector('[data-queue-dock]')?.innerText,
      stop: Boolean(document.querySelector('.dsb-stop')),
    })`)
    const hostQueue = await api('queue', { sessionId })
    throw new Error(`${error.message}: ${JSON.stringify({ diagnostic, hostQueue })}`)
  }
  const queuedOutsideTranscript = await evaluate(`!document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(queuedFollowUp)})`)
  if (!queuedOutsideTranscript) throw new Error('The queued follow-up appeared in the transcript before it was placed')
  const queuedCapture = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(queueScreenshot, Buffer.from(queuedCapture.data, 'base64'))
  await evaluate(`document.querySelector('[data-queue-dock] button[aria-label="Steer queued message"]')?.click()`)
  await waitFor(`!document.querySelector('[data-queue-dock]')`, 20_000)
  await waitFor(`document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(queuedFollowUp)})`, 20_000)
  await waitFor(`document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(`收到：${queuedFollowUp}`)})`, 20_000)

  await send('Stop this Agent turn')
  await waitFor("document.querySelector('.dsb-stop')")
  await evaluate("document.querySelector('.dsb-stop').click()")
  await waitFor("!document.querySelector('.dsb-stop')", 20_000)
  try {
    await waitFor("document.querySelector('[data-chat-flow]')?.innerText.includes('Stopped')", 20_000)
  } catch (error) {
    const history = await api('agent-chat', { sessionId })
    const flow = await evaluate("document.querySelector('[data-chat-flow]')?.innerText")
    throw new Error(`${error.message}: ${JSON.stringify({ flow, history })}`)
  }

  const creator = await api('agent-preset-start', { id: 'creator' })
  await api('send', {
    sessionId: creator.sessionId,
    content: [{ type: 'text', text: `调用 manage_cue_plugin ${JSON.stringify({ action: 'install', source: pluginPath })}` }],
  })
  const pluginDeadline = Date.now() + 30_000
  let installed
  while (Date.now() < pluginDeadline) {
    const current = await api('state', { locale: 'en' })
    for (const approval of current.work?.approvals ?? []) await api('approval-answer', { id: approval.id, choice: 'allow' })
    installed = (await api('plugin-client-entries')).find(row => row.name === 'cue-client-e2e')
    if (installed) break
    await sleep(100)
  }
  if (!installed) {
    const history = await api('agent-chat', { sessionId: creator.sessionId })
    throw new Error(`Creator did not install the client plugin: ${JSON.stringify(history)}`)
  }
  console.log(`check-agent-chat: client plugin entry ${JSON.stringify(installed)}`)
  await waitFor("document.querySelector('[aria-label=Account]')")
  await evaluate("document.querySelector('[aria-label=Account]').click()")
  await waitFor("[...document.querySelectorAll('[role=menuitem]')].some(node => node.textContent.trim() === 'Settings')")
  await evaluate("[...document.querySelectorAll('[role=menuitem]')].find(node => node.textContent.trim() === 'Settings').click()")
  try {
    await waitFor("[...document.querySelectorAll('.bt-settings-item')].some(node => node.textContent.trim() === 'Client E2E')")
  } catch (error) {
    const moduleUrl = `./api/bot/plugin/${installed.fingerprint}/${installed.entries[0]}`
    const diagnostic = await evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(moduleUrl)})
      let imported
      try { imported = { type: typeof (await import(${JSON.stringify(moduleUrl)})).default } }
      catch (failure) { imported = { error: failure.message, stack: failure.stack } }
      return {
        installed: ${JSON.stringify(installed)},
        status: response.status,
        type: response.headers.get('content-type'),
        text: (await response.text()).slice(0, 500),
        imported,
        labels: [...document.querySelectorAll('.bt-settings-item')].map(node => node.textContent.trim()),
        styles: [...document.querySelectorAll('style[data-cue-plugin]')].map(node => node.dataset.cuePlugin),
        alert: document.querySelector('[role=alert]')?.textContent,
        calls: window.__cueApiCalls?.filter(call => call.endpoint === 'plugin-client-entries'),
      }
    })()`)
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`)
  }
  await evaluate("[...document.querySelectorAll('.bt-settings-item')].find(node => node.textContent.trim() === 'Client E2E').click()")
  await waitFor("document.querySelector('[data-cue-client-e2e]')?.textContent.includes('Loaded version') && document.querySelector('[data-cue-client-e2e]')?.textContent.includes('1.0.0')")
  const pluginStyle = await evaluate("[...document.querySelectorAll('style[data-cue-plugin=\"cue-client-e2e\"]')].some(node => node.textContent.includes('[data-cue-client-e2e]'))")
  if (!pluginStyle) throw new Error('The client plugin page rendered without its registered style')
  await evaluate(`(() => {
    const animations = document.getAnimations().filter(animation =>
      Number.isFinite(animation.effect?.getTiming().iterations ?? Infinity))
    return Promise.race([
      Promise.allSettled(animations.map(animation => animation.finished)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]).then(() => true)
  })()`)
  await sleep(100)
  const pluginCapture = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(pluginScreenshot, Buffer.from(pluginCapture.data, 'base64'))
  await evaluate("document.querySelector('.bt-settings-close').click()")
  await waitFor("!document.querySelector('.bt-settings')")

  const result = await evaluate(`({
    sessionId: ${JSON.stringify(sessionId)},
    placeholder: document.querySelector('textarea[data-composer-input]')?.placeholder,
    hasFirstPrompt: document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(first)}),
    hasFirstAnswer: document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(`收到：${first}`)}),
    queuedFollowUp: document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(queuedFollowUp)}),
    queuedAnswer: document.querySelector('[data-chat-flow]')?.innerText.includes(${JSON.stringify(`收到：${queuedFollowUp}`)}),
    stopped: document.querySelector('[data-chat-flow]')?.innerText.includes('Stopped'),
    agentActive: document.querySelector('[data-agent-id="${added.id}"]')?.getAttribute('aria-current'),
  })`)
  if (result.placeholder !== 'Message Agent' || !result.hasFirstPrompt || !result.hasFirstAnswer || !result.queuedFollowUp || !result.queuedAnswer || !result.stopped || result.agentActive !== 'page') {
    throw new Error(`Agent chat check failed: ${JSON.stringify(result)}`)
  }
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(screenshot, Buffer.from(data, 'base64'))

  const firstApp = app
  cdp.close()
  cdp = undefined
  const firstExit = firstApp.exitCode === null ? new Promise(resolve => firstApp.once('exit', resolve)) : Promise.resolve()
  await closeBrowser(firstApp)
  await Promise.race([firstExit, sleep(20_000).then(() => { throw new Error('The first app did not exit for the plugin restart check') })])
  await sleep(300)
  app = spawnChild(electron, [root, `--remote-debugging-port=${String(debugPort)}`], { env: appEnv, stdio: 'inherit' })
  const restartedPage = await pageTarget(Date.now() + 60_000)
  cdp = devtools(restartedPage.webSocketDebuggerUrl)
  await cdp.opened
  const restartedEvaluate = async expression => {
    const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const restartedWaitFor = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await restartedEvaluate(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`timed out after restart waiting for ${expression}`)
  }
  await restartedWaitFor("document.querySelector('[aria-label=Account]')")
  await restartedEvaluate("document.querySelector('[aria-label=Account]').click()")
  await restartedWaitFor("[...document.querySelectorAll('[role=menuitem]')].some(node => node.textContent.trim() === 'Settings')")
  await restartedEvaluate("[...document.querySelectorAll('[role=menuitem]')].find(node => node.textContent.trim() === 'Settings').click()")
  await restartedWaitFor("[...document.querySelectorAll('.bt-settings-item')].some(node => node.textContent.trim() === 'Client E2E')")
  await restartedEvaluate("[...document.querySelectorAll('.bt-settings-item')].find(node => node.textContent.trim() === 'Client E2E').click()")
  await restartedWaitFor("document.querySelector('[data-cue-client-e2e]')?.textContent.includes('Loaded version') && document.querySelector('[data-cue-client-e2e]')?.textContent.includes('1.0.0')")
  if (!await restartedEvaluate("Boolean(document.querySelector('style[data-cue-plugin=\"cue-client-e2e\"]'))")) {
    throw new Error('The client plugin style did not return after restart')
  }
  console.log(`check-agent-chat: Agent history, send, queue, steer, stream and stop passed (${sessionId})`)
  console.log(`check-agent-chat: Bot failure card, technical details, key recovery and Retry passed (${mainBotId})`)
  console.log(`check-agent-chat: Creator installed, rendered and restored client plugin ${installed.fingerprint}`)
  console.log(`check-agent-chat: failure screenshot ${failureScreenshot}`)
  console.log(`check-agent-chat: queue screenshot ${queueScreenshot}`)
  console.log(`check-agent-chat: plugin screenshot ${pluginScreenshot}`)
  console.log(`check-agent-chat: screenshot ${screenshot}`)
} finally {
  cdp?.close()
  if (app) await closeBrowser(app)
  for (const child of children) child.kill()
  await sleep(200)
  await rm(runRoot, { recursive: true, force: true })
}
