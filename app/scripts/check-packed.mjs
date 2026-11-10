// Check the packaged app outside the checkout: the owned Host and UI are present, the state
// endpoint answers, closing hides the window, a second launch brings it back, and quit stops it.
import { spawn, spawnSync } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'ds-bot-packed-')))
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
  const script = `
    const assert = require('node:assert/strict')
    const { existsSync, readFileSync } = require('node:fs')
    const { createRequire } = require('node:module')
    const { join } = require('node:path')
    const root = ${JSON.stringify(packageRoot)}
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(existsSync(join(root, 'ui', 'dist', 'index.html')), 'ui/dist/index.html is missing')
    const req = createRequire(join(root, 'package.json'))
    const host = req.resolve('ds-bot/host')
    assert.match(readFileSync(host, 'utf8'), /class OwnedHost/u)
    const retiredScope = '@' + 'deepseek-ai'
    assert.equal(Object.keys(manifest.dependencies).some(name => name.startsWith(retiredScope + '/')), false)
    assert.equal(existsSync(join(root, 'node_modules', retiredScope)), false)
    console.log('check-packed: owned Host and UI are packaged without DeepSeek packages')
  `
  const result = spawnSync(app, ['-e', script], {
    cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, encoding: 'utf8', timeout: 60_000,
  })
  if (result.error || result.status !== 0) throw new Error(`packaged files check failed (exit ${String(result.status)}): ${result.error?.message ?? result.stderr}`)
  console.log(result.stdout.trim())
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

let failed = false
const problems = []
try {
  const packedApp = outsideCheckout(resolve(executable))
  checkFiles(packedApp)
  const port = await freePort()
  const mainPort = await freePort()
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, { DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell') })
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
      expression: `(() => { const { app, BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('http://127.0.0.1:')); return ${expression} })()`,
      returnByValue: true, awaitPromise: true,
    })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result?.value
  }
  const handoffDeadline = Date.now() + 10_000
  while (Date.now() < handoffDeadline && await windowState('BrowserWindow.getAllWindows().length !== 1 || !win.isVisible()')) await sleep(100)
  if (await windowState('BrowserWindow.getAllWindows().length === 1 && win.isVisible()') !== true) throw new Error('the team window did not finish its handoff')
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
}
stopChildren()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
