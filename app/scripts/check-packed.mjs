// Check the packaged app outside the checkout: the owned Host and UI are present, the state
// endpoint answers, closing hides the window, a second launch brings it back, and quit stops it.
import { spawn, spawnSync } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given, shotFile] = process.argv.slice(2)
const executable = given || packedExecutable()

function packedExecutable() {
  const out = join(root, 'dist-pack')
  if (process.platform === 'win32') return join(out, 'win-unpacked', 'DS Bot.exe')
  if (process.platform === 'linux') return join(out, 'linux-unpacked', 'dsbot')
  const dir = ['mac-arm64', 'mac'].find(name => existsSync(join(out, name))) ?? 'mac'
  return join(out, dir, 'DS Bot.app', 'Contents', 'MacOS', 'DS Bot')
}

if (!existsSync(executable)) {
  console.error(`check-packed: no app at ${executable}. Run npm run pack first.`)
  process.exit(2)
}

const workRoot = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : tmpdir()
const work = mkdtempSync(join(workRoot, 'ds-bot-packed-'))
mkdirSync(join(work, 'home'))
mkdirSync(join(work, 'shell'))
writeFileSync(join(work, 'shell', 'tray-close-acknowledged'), '')
const children = []

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill()
  }
}

function printCursorDiagnostics() {
  try {
    const lines = readFileSync(join(work, 'shell', 'logs', 'main.log'), 'utf8')
      .split(/\r?\n/u).filter(line => line.includes('cursor diagnostic')).slice(-20)
    if (lines.length > 0) console.error(`check-packed: cursor diagnostics:\n${lines.join('\n')}`)
  } catch {}
}

setTimeout(() => {
  console.error('check-packed: FAILED: gave up after 5 minutes')
  stopChildren()
  process.exit(1)
}, 5 * 60_000).unref()

function outsideCheckout(file) {
  const fromCheckout = relative(resolve(root, '..'), file)
  if (fromCheckout.startsWith('..') || isAbsolute(fromCheckout)) return file
  const appDir = process.platform === 'darwin' ? resolve(file, '..', '..', '..') : dirname(file)
  const copy = join(work, basename(appDir))
  cpSync(appDir, copy, { recursive: true, verbatimSymlinks: true })
  console.log(`check-packed: runs a copy of ${appDir} in ${work}`)
  return join(copy, relative(appDir, file))
}

function checkFiles(app) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const packageRoot = join(resources, process.platform === 'linux' ? 'app' : 'app.asar')
  const unpackedRoot = process.platform === 'linux' ? packageRoot : join(resources, 'app.asar.unpacked')
  const script = `
    const assert = require('node:assert/strict')
    const { existsSync, readFileSync } = require('node:fs')
    const { createRequire } = require('node:module')
    const { join } = require('node:path')
    const { pathToFileURL } = require('node:url')
    const root = ${JSON.stringify(packageRoot)}
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(existsSync(join(root, 'ui', 'dist', 'index.html')), 'ui/dist/index.html is missing')
    const req = createRequire(join(root, 'package.json'))
    const host = req.resolve('ds-bot/host')
    assert.match(readFileSync(host, 'utf8'), /class OwnedHost/u)
    const retiredScope = '@' + 'deepseek-ai'
    assert.equal(Object.keys(manifest.dependencies).some(name => name.startsWith(retiredScope + '/')), false)
    assert.equal(existsSync(join(root, 'node_modules', retiredScope)), false)
    const speech = req('sherpa-onnx-node')
    assert.equal(typeof speech.OfflineRecognizer, 'function', 'the packaged speech native module did not load')
    ;(async () => {
      const module = await import(pathToFileURL(join(${JSON.stringify(unpackedRoot)}, 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href)
      const driver = module.CuaDriver.create({ embedded: true })
      try {
        const inventory = JSON.parse(await driver.listToolsJson())
        assert.ok(Array.isArray(inventory.tools), 'the packaged computer driver returned no tool inventory')
        const result = await driver.callTool('list_windows', '{}')
        const windows = JSON.parse(result.structuredJson)
        assert.ok(Array.isArray(windows.windows), 'the packaged computer driver could not list native windows')
      } finally {
        await driver.shutdown()
        driver.uniffiDestroy?.()
      }
      console.log('check-packed: owned Host, UI, speech and a native computer call work without DeepSeek packages')
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  const result = spawnSync(app, ['-e', script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, encoding: 'utf8', timeout: 60_000,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged files check failed (exit ${String(result.status)}): ${result.error?.message ?? result.stderr}`)
  console.log(result.stdout.trim())
}

function packagedWindowPid(app, bounds, expectedPid) {
  const resources = process.platform === 'darwin' ? resolve(app, '..', '..', 'Resources') : join(dirname(app), 'resources')
  const unpackedRoot = process.platform === 'linux' ? join(resources, 'app') : join(resources, 'app.asar.unpacked')
  const script = `
    const { join } = require('node:path')
    const { pathToFileURL } = require('node:url')
    ;(async () => {
      const module = await import(pathToFileURL(join(${JSON.stringify(unpackedRoot)}, 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href)
      const driver = module.CuaDriver.create({ embedded: true })
      try { console.log((await driver.callTool('list_windows', '{}')).structuredJson) }
      finally { await driver.shutdown(); driver.uniffiDestroy?.() }
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  const result = spawnSync(app, ['-e', script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, encoding: 'utf8', timeout: 60_000,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged native window lookup failed: ${result.error?.message ?? result.stderr}`)
  const windows = JSON.parse(result.stdout.trim()).windows
  const candidates = windows.filter(window => Number.isInteger(window.pid) && window.bounds)
  const current = candidates.find(window => window.pid === expectedPid)
  if (current !== undefined) return current.pid
  candidates.sort((left, right) => {
    const score = window => Math.abs(window.bounds.x - bounds.x) + Math.abs(window.bounds.y - bounds.y)
      + Math.abs(window.bounds.width - bounds.width) + Math.abs(window.bounds.height - bounds.height)
    return score(left) - score(right)
  })
  const target = candidates[0]
  const distance = target === undefined ? Infinity : Math.abs(target.bounds.x - bounds.x) + Math.abs(target.bounds.y - bounds.y)
    + Math.abs(target.bounds.width - bounds.width) + Math.abs(target.bounds.height - bounds.height)
  if (target === undefined || distance > 8) throw new Error('the packaged computer driver could not identify the team window')
  return target.pid
}

async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const { port } = server.address()
  await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()) })
  return port
}

async function appPage(port, deadline, main = false) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => main ? target.type === 'node' : target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the window did not answer ${method}`)) }, 30_000)
    pending.set(id, {
      resolve: value => { clearTimeout(timer); done(value) },
      reject: error => { clearTimeout(timer); reject(error) },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

async function hostAlive() {
  const { port } = JSON.parse(readFileSync(join(work, 'shell', 'host-port.json'), 'utf8'))
  await new Promise((done, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); done() })
    socket.once('error', reject)
  })
}

async function browserClose(port) {
  const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  socket.close()
}

async function rendererValue(cdp, expression) {
  const answer = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
  return answer.result?.value
}

async function checkPackedSpeech(cdp) {
  const speechRoot = process.env.DS_BOT_SPEECH_E2E_ROOT
  if (!speechRoot) {
    console.log('check-packed: known-audio speech check skipped (set DS_BOT_SPEECH_E2E_ROOT)')
    return
  }
  if (!isAbsolute(speechRoot)) throw new Error('DS_BOT_SPEECH_E2E_ROOT must be absolute')
  const audioUrl = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/zh.wav'
  const response = await fetch(audioUrl)
  if (!response.ok) throw new Error(`speech fixture returned HTTP ${String(response.status)}`)
  const request = {
    providerId: 'sensevoice-local',
    language: 'zh',
    audioBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
  }
  const prepared = await rendererValue(cdp, "window.dsBotApp.speech.prepare('sensevoice-local')")
  if (prepared?.ok !== true) throw new Error(`the packaged speech provider did not prepare: ${prepared?.error?.message ?? 'unknown error'}`)
  const ready = await rendererValue(cdp, `(async () => {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const answer = await window.dsBotApp.speech.catalog()
      const phase = answer?.value?.providers?.[0]?.preparation?.phase
      if (phase === 'ready') return true
      if (phase === 'failed' || phase === 'cancelled') return answer
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  })()`)
  if (ready !== true) throw new Error(`the packaged speech worker did not become ready: ${JSON.stringify(ready)}`)
  const known = await rendererValue(cdp, `window.dsBotApp.speech.transcribe('packed-known', ${JSON.stringify(request)})`)
  if (known?.ok !== true || known?.value?.text !== '开饭时间早上9点至下午5点。') {
    throw new Error(`the packaged speech worker returned the wrong transcript: ${JSON.stringify(known)}`)
  }
  const cancelled = await rendererValue(cdp, `(async () => {
    const request = ${JSON.stringify(request)}
    const first = window.dsBotApp.speech.transcribe('packed-replaced', request)
    const second = window.dsBotApp.speech.transcribe('packed-replaced', request)
    const [replaced, completed] = await Promise.all([first, second])
    return { replaced, completed }
  })()`)
  if (cancelled?.replaced?.ok !== false || cancelled?.completed?.ok !== true) {
    throw new Error(`the packaged speech cancellation path failed: ${JSON.stringify(cancelled)}`)
  }
  console.log('check-packed: packaged speech transcribed known audio and cancelled a replaced request')
}

let failed = false
const problems = []
try {
  const packedApp = outsideCheckout(resolve(executable))
  checkFiles(packedApp)
  const port = await freePort()
  const mainPort = await freePort()
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, { DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'), DS_BOT_CURSOR_DIAGNOSTICS: '1' })
  if (process.env.DS_BOT_SPEECH_E2E_ROOT) Object.assign(env, {
    DS_BOT_SPEECH_MODEL_DIRECTORY: join(process.env.DS_BOT_SPEECH_E2E_ROOT, 'models', 'sensevoice-onnx'),
    DS_BOT_SPEECH_VAD_MODEL: join(process.env.DS_BOT_SPEECH_E2E_ROOT, 'models', 'silero', 'silero_vad.onnx'),
  })
  const app = spawn(packedApp, [`--remote-debugging-port=${String(port)}`, `--inspect=127.0.0.1:${String(mainPort)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise(done => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  const cdp = devtools((await appPage(port, Date.now() + 120_000)).webSocketDebuggerUrl, problems)
  await cdp.opened
  const main = devtools((await appPage(mainPort, Date.now() + 30_000, true)).webSocketDebuggerUrl, problems)
  await main.opened
  await cdp.call('Runtime.enable')
  const state = await cdp.call('Runtime.evaluate', {
    expression: "fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state', payload: {} }) }).then(r => r.json())",
    returnByValue: true, awaitPromise: true,
  })
  if (state.exceptionDetails || state.result?.value?.ok !== true) throw new Error(`the owned Host state endpoint failed: ${JSON.stringify(state.exceptionDetails ?? state.result?.value)}`)
  console.log('check-packed: owned Host state endpoint answered')
  if (shotFile) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(shotFile), Buffer.from(data, 'base64'))
  }
  const windowState = async expression => {
    const answer = await main.call('Runtime.evaluate', {
      expression: `(() => { const { app, BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const windows = BrowserWindow.getAllWindows().filter(item => !item.isDestroyed() && !item.webContents.isDestroyed()); const win = windows.find(item => item.webContents.getURL().startsWith('http://127.0.0.1:')); return ${expression} })()`,
      returnByValue: true, awaitPromise: true,
    })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result?.value
  }
  const handoffDeadline = Date.now() + 10_000
  while (Date.now() < handoffDeadline && await windowState('windows.length !== 1 || !win.isVisible()')) await sleep(100)
  if (await windowState('windows.length === 1 && win.isVisible()') !== true) throw new Error('the team window did not finish its handoff')
  await checkPackedSpeech(cdp)
  await rendererValue(cdp, `(() => {
    window.__packedComputerAction = null
    window.dsBotApp.onComputerAction(action => { window.__packedComputerAction = action })
    window.dsBotApp.computer({ rows: [{ botId: 'packed-bot', name: 'Packed Bot', label: 'Packed Bot', app: 'DS Bot' }], labels: { stop: 'Stop' } })
    return true
  })()`)
  const indicatorDeadline = Date.now() + 10_000
  while (Date.now() < indicatorDeadline && await windowState("windows.filter(item => item.webContents.getURL().startsWith('data:text/html')).length") !== 1) await sleep(100)
  const indicatorActed = await windowState(`(async () => {
    const indicator = windows.find(item => item.webContents.getURL().startsWith('data:text/html'))
    if (!indicator) return false
    return await indicator.webContents.executeJavaScript("document.querySelector('[data-act^=\\\"stop:\\\"]')?.click(); true")
  })()`)
  if (indicatorActed !== true) throw new Error('the packaged computer indicator did not open')
  const actionDeadline = Date.now() + 10_000
  let action
  while (Date.now() < actionDeadline) {
    action = await rendererValue(cdp, 'window.__packedComputerAction')
    if (action?.kind === 'stop' && action?.botId === 'packed-bot') break
    await sleep(100)
  }
  if (action?.kind !== 'stop' || action?.botId !== 'packed-bot') throw new Error('the packaged computer indicator action did not reach the team window')
  await rendererValue(cdp, 'window.dsBotApp.computer({ rows: [], labels: {} }); true')
  await windowState('app.focus({ steal: true }); win.show(); win.moveTop(); win.focus(); true')
  await sleep(300)
  if (process.platform !== 'linux') {
    const cursorTarget = await windowState('({ bounds: win.getBounds() })')
    const cursorPid = packagedWindowPid(packedApp, cursorTarget.bounds, app.pid)
    await rendererValue(cdp, `window.dsBotApp.computerCursor({ botId: 'packed-bot', pid: ${String(cursorPid)}, x: ${String(cursorTarget.bounds.x + 100)}, y: ${String(cursorTarget.bounds.y + 100)}, ripple: true, color: '#3b82f6' }); true`)
    const cursorDeadline = Date.now() + 10_000
    let cursorVisible = false
    while (Date.now() < cursorDeadline) {
      cursorVisible = await windowState("windows.some(item => item.webContents.getURL().startsWith('data:text/html') && decodeURIComponent(item.webContents.getURL()).includes('<svg'))")
      if (cursorVisible) break
      await sleep(100)
    }
    if (!cursorVisible) throw new Error('the packaged computer cursor did not appear')
  }
  console.log('check-packed: packaged computer indicator, action and cursor flow passed')
  await windowState('win.close()')
  await sleep(500)
  if (app.exitCode !== null) throw new Error('the app ended with its window')
  if (await windowState('win !== undefined && !win.isDestroyed() && !win.isVisible()') !== true) throw new Error('the window is not hidden')
  await hostAlive()
  console.log('check-packed: the window is hidden and the Host goes on')
  const second = spawn(packedApp, [`--remote-debugging-port=${String(await freePort())}`], { stdio: 'ignore', env })
  children.push(second)
  const secondExit = await Promise.race([new Promise(done => { second.once('exit', code => { done(code) }) }), sleep(30_000).then(() => undefined)])
  if (secondExit === undefined) throw new Error('the second copy of the app did not end')
  if (app.exitCode !== null) throw new Error('the app ended when it was started again')
  if (await windowState('win !== undefined && !win.isDestroyed() && win.isVisible()') !== true) throw new Error('the window did not come back')
  console.log('check-packed: the window came back when the app was started again')
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  cdp.close()
  main.close()
  await browserClose(port)
  const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
  if (outcome === undefined) throw new Error('the app did not exit after the quit')
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  console.log('check-packed: passed')
} catch (error) {
  failed = true
  console.error(`check-packed: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  printCursorDiagnostics()
}
stopChildren()
await sleep(500)
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
} catch (error) {
  console.error(`check-packed: cleanup warning: could not remove ${work}: ${error instanceof Error ? error.message : String(error)}`)
}
process.exit(failed ? 1 : 0)
