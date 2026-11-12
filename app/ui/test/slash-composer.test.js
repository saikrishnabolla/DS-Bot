import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

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

test('Bot and Agent composers execute slash commands without sending a prompt', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://owned.test/' })
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    File: dom.window.File,
    requestAnimationFrame: callback => callback(Date.now()),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const [{ createElement: h, act }, { createRoot }, { Composer }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../src/chat.js'),
  ])
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    requests.push(request)
    const value = request.payload.line === '/permission'
      ? { command: 'permission', permission: 'workspace-write', permissions: { options: [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace write' }] } }
      : { command: request.payload.line.slice(1) }
    return new Response(JSON.stringify({ ok: true, value }))
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  t.after(() => {
    act(() => root.unmount())
    globalThis.fetch = previousFetch
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })
  const roster = { prefs: {}, byId: {}, roomsById: {} }
  const actions = { speech: () => null, openVoice() {}, clearQuote() {}, canReferenceChat: () => false, openSettings() {} }
  const props = {
    sessionId: 'agent-session', placeholder: 'Message Agent', disabled: false, running: false,
    onSend: () => assert.fail('slash commands must not be sent as prompts'), onStop() {}, actions,
    useUi: select => select({}), useRoster: select => select(roster),
  }
  const type = async value => {
    const input = dom.window.document.querySelector('textarea')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }

  await act(async () => { root.render(h(Composer, { ...props, agentSession: false })) })
  await type('/')
  assert.equal(dom.window.document.querySelector('[aria-label="Commands"]'), null)

  await act(async () => { root.render(h(Composer, { ...props, agentSession: true })) })
  assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 8)
  await type('/co')
  assert.deepEqual([...dom.window.document.querySelectorAll('[role="option"]')].map(node => node.textContent), ['CompactCompact older conversation history'])
  await act(async () => { dom.window.document.querySelector('[role="option"]').click(); await waitImmediate() })
  assert.deepEqual(requests, [{ endpoint: 'agent-command', payload: { sessionId: 'agent-session', line: '/compact', content: [] } }])
  assert.equal(dom.window.document.querySelector('textarea').value, '')

  await type('/mod')
  await act(async () => { dom.window.document.querySelector('[role="option"]').click() })
  assert.equal(dom.window.document.querySelector('textarea').value, '/model ')

  await type('/per')
  await act(async () => { dom.window.document.querySelector('[role="option"]').click(); await waitImmediate() })
  assert.deepEqual([...dom.window.document.querySelectorAll('[aria-label="Permission presets"] [role="option"]')].map(node => [node.textContent, node.getAttribute('aria-selected')]), [
    ['Read only', 'false'], ['Workspace write', 'true'],
  ])
  await act(async () => { dom.window.document.querySelector('[aria-label="Permission presets"] [role="option"]').click(); await waitImmediate() })
  assert.equal(requests.at(-1).payload.line, '/permission read-only')

  const runningLines = [
    '/compact',
    '/plan Check the risky path',
    '/permission read-only',
    '/model faux/faux-1',
    '/goal Ship the demo',
    '/export',
    '/does-not-exist',
  ]
  await act(async () => { root.render(h(Composer, { ...props, agentSession: false, botSession: true, running: true })) })
  for (const line of runningLines) {
    await type(line)
    await act(async () => { dom.window.document.querySelector('[aria-label="Send message"]').click(); await waitImmediate() })
  }
  assert.deepEqual(requests.slice(-runningLines.length).map(request => request.payload.line), runningLines)
})
