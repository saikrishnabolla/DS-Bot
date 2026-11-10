import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from '../../../ds-bot/node_modules/jsdom/lib/api.js'

const peerModules = {
  react: new URL('../../node_modules/react/index.js', import.meta.url).href,
  'react-dom': new URL('../../node_modules/react-dom/index.js', import.meta.url).href,
}
const loader = `const peers = ${JSON.stringify(peerModules)}
export async function resolve(specifier, context, nextResolve) {
  if (peers[specifier]) return { url: peers[specifier], shortCircuit: true }
  return nextResolve(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
await waitImmediate()
const { createTeam } = await import('../src/team.js')

const state = ({ revision = 1, computerLive = {} } = {}) => ({
  revision,
  workspaceId: null,
  mainBotId: 'b1',
  mainBotIds: ['b1'],
  bots: [{ id: 'b1', name: 'Builder', color: 'violet', sessionId: 'b1', parts: [] }],
  rooms: [],
  privateArchives: [],
  exchangeTurns: {},
  questions: {},
  views: {},
  closedCards: {},
  closedViews: {},
  btwCards: {},
  sideChats: {},
  agents: [],
  sections: [],
  secrets: [],
  capabilities: [],
  capabilityStatuses: {},
  secretRequests: {},
  connectorRequests: {},
  mailRequests: {},
  colors: [],
  models: [],
  defaultModel: null,
  permissions: null,
  modelsKey: 'models-1',
  prefs: {},
  browser: false,
  memory: true,
  readOnly: null,
  im: { connections: [], platforms: [] },
  computer: { enabled: true },
  activity: {},
  work: { bots: {}, approvals: [] },
  memoryNews: {},
  memoryReviews: {},
  learning: {},
  learningSettled: {},
  connectors: [],
  imStatus: {},
  imVia: {},
  computerLive,
})

const reply = value => new Response(JSON.stringify({ ok: true, value }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

async function drain() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await waitImmediate()
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function installWindow(t) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://owned.test/' })
  const values = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => {
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })
  return dom.window.document.getElementById('root')
}

function installTimers(t) {
  const originals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const timeouts = []
  const intervals = []
  const make = (list, run, ms, args) => {
    const timer = { ms, cleared: false, run: () => run(...args) }
    list.push(timer)
    return timer
  }
  globalThis.setTimeout = (run, ms, ...args) => make(timeouts, run, ms, args)
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true }
  globalThis.setInterval = (run, ms, ...args) => make(intervals, run, ms, args)
  globalThis.clearInterval = timer => { if (timer) timer.cleared = true }
  t.after(() => Object.assign(globalThis, originals))
  return { timeouts, intervals }
}

const feed = signal => new Response(new ReadableStream({
  start(controller) {
    signal?.addEventListener('abort', () => controller.close(), { once: true })
  },
}), { status: 200 })

test('createTeam follows the desktop updater from initial state through cleanup', async t => {
  const container = installWindow(t)
  const timers = installTimers(t)
  const previousFetch = globalThis.fetch
  const previousApp = globalThis.dsBotApp
  t.after(() => { globalThis.fetch = previousFetch; globalThis.dsBotApp = previousApp })
  let updateListener
  let unsubscribed = 0
  const calls = []
  globalThis.dsBotApp = {
    updates: {
      state: async () => ({ phase: 'available', version: '2.0.0' }),
      subscribe: listener => { updateListener = listener; return () => { unsubscribed += 1 } },
      check: async () => { calls.push('check') },
      install: async () => { calls.push('install') },
      open: async () => { calls.push('open') },
    },
  }
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'api/bot/feed') return feed(options.signal)
    const request = JSON.parse(options.body)
    if (request.endpoint === 'state') return reply(state())
    if (request.endpoint === 'update-check') return reply({ available: false, phase: 'idle', source: 'app' })
    return reply(true)
  }

  const team = createTeam()
  const observed = []
  function Probe() {
    observed.push(team.hooks.useUpdate(value => value))
    return null
  }
  const root = createRoot(container)
  let stop
  await act(async () => {
    root.render(createElement(Probe))
    stop = team.start()
    await drain()
  })
  assert.deepEqual(observed.at(-1).ownApp, { phase: 'available', version: '2.0.0' })
  assert.equal(typeof updateListener, 'function')

  await act(async () => {
    updateListener({ phase: 'downloaded', version: '2.0.0' })
    await drain()
  })
  assert.deepEqual(observed.at(-1).ownApp, { phase: 'downloaded', version: '2.0.0' })
  await team.actions.checkOwnApp()
  await team.actions.installOwnApp()
  await team.actions.openOwnApp()
  assert.deepEqual(calls, ['check', 'install', 'open'])

  const beforeCleanup = observed.length
  await act(async () => {
    stop()
    updateListener({ phase: 'ready', version: '2.0.0' })
    await drain()
  })
  assert.equal(unsubscribed, 1)
  assert.equal(observed.length, beforeCleanup)
  assert.equal(timers.intervals.every(timer => timer.cleared), true)
  await act(async () => { root.unmount() })
})

test('createTeam drives and cleans up the desktop computer indicator, cursor and idle bridge', async t => {
  installWindow(t)
  const timers = installTimers(t)
  const previousFetch = globalThis.fetch
  const previousApp = globalThis.dsBotApp
  t.after(() => { globalThis.fetch = previousFetch; globalThis.dsBotApp = previousApp })
  const indicator = []
  const cursors = []
  const apiCalls = []
  let action
  let actionDisposed = 0
  let cursorWaits = 0
  let releaseCursor
  let releaseIdle
  let deferIdle = false
  let deferState = false
  let releaseState
  globalThis.dsBotApp = {
    computer: entries => { indicator.push(entries) },
    computerCursor: event => { cursors.push(event) },
    idleSeconds: async () => deferIdle ? await new Promise(resolve => { releaseIdle = resolve }) : 7,
    onComputerAction: listener => {
      action = listener
      return () => { actionDisposed += 1 }
    },
  }
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'api/bot/feed') return feed(options.signal)
    const request = JSON.parse(options.body)
    apiCalls.push(request)
    if (request.endpoint === 'state') {
      if (deferState) return await new Promise(resolve => { releaseState = value => resolve(reply(value)) })
      return reply(state({ computerLive: { leases: [{ botId: 'b1', kind: 'app', appName: 'Notes' }], bots: {} } }))
    }
    if (request.endpoint === 'update-check') return reply({ available: false, phase: 'idle' })
    if (request.endpoint === 'computer-cursor-wait') {
      cursorWaits += 1
      if (cursorWaits === 1) return reply({ now: 10_000, events: [
        { seq: 1, t: 9_500, botId: 'b1', x: 20, y: 40 },
        { seq: 2, t: 4_000, botId: 'b1', x: 99, y: 99 },
      ] })
      return await new Promise(resolve => { releaseCursor = value => resolve(reply(value)) })
    }
    return reply(true)
  }

  const team = createTeam()
  const stop = team.start()
  await drain()
  assert.equal(typeof action, 'function')
  assert.equal(indicator.at(-1).rows[0].label, 'Builder · Notes')

  const cursorPause = timers.timeouts.find(timer => timer.ms === 2000 && !timer.cleared)
  assert.ok(cursorPause)
  cursorPause.run()
  await drain()
  assert.equal(cursorWaits, 2)
  assert.deepEqual(cursors, [{ seq: 1, t: 9_500, botId: 'b1', x: 20, y: 40, color: '#8B5CF6', avatar: undefined }])

  const idle = timers.intervals.find(timer => timer.ms === 2000 && !timer.cleared)
  assert.ok(idle)
  idle.run()
  await drain()
  assert.ok(apiCalls.some(call => call.endpoint === 'computer-user-active' && call.payload.idleSeconds === 7))

  action({ kind: 'stop', botId: 'b1' })
  action({ kind: 'stopall', botId: null })
  action({ kind: 'letgo', botId: 'b1' })
  await drain()
  assert.ok(apiCalls.some(call => call.endpoint === 'computer-stop' && call.payload.botId === 'b1'))
  assert.ok(apiCalls.some(call => call.endpoint === 'computer-stop' && call.payload.all === true))
  assert.ok(apiCalls.some(call => call.endpoint === 'computer-allow-foreground' && call.payload.botId === 'b1'))

  deferState = true
  const pending = team.actions.computerStop('b1')
  await drain()
  assert.equal(typeof releaseState, 'function')
  const indicatorCount = indicator.length
  const cursorCount = cursors.length
  const callCount = apiCalls.length
  deferIdle = true
  idle.run()
  await drain()
  assert.equal(typeof releaseIdle, 'function')
  stop()
  releaseState(state({ revision: 2, computerLive: { leases: [], bots: {} } }))
  releaseCursor({ now: 11_000, events: [{ seq: 3, t: 10_900, botId: 'b1', x: 30, y: 50 }] })
  releaseIdle(8)
  action({ kind: 'stop', botId: 'b1' })
  await pending
  await drain()
  assert.equal(indicator.length, indicatorCount)
  assert.equal(cursors.length, cursorCount)
  assert.equal(apiCalls.length, callCount)
  assert.equal(actionDisposed, 1)
  assert.equal(timers.intervals.every(timer => timer.cleared), true)
})
