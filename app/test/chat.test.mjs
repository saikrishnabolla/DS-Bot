import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The app's composer shares the Enter preference with the plugin's: the voice
// buttons read it from the roster, and a plain Enter submits only while it says
// Enter sends; off, the field's own newline stands and the send button submits.
// Parts of the page outside the composer are stubbed: this checks the wiring
// from the chat's hooks down to the textarea and the plugin's voice buttons.
const stubs = {
  'cells.js': "export const Bubbles = props => ({ type: 'bubbles-marker', props: { ...props, children: [] } })\nexport const ChatRows = props => ({ type: 'rows-marker', props: { ...props, children: [] } })\nexport const Shimmer = () => null\nexport const ToolCell = props => ({ type: 'tool-cell-marker', props: { ...props, children: [] } })\n",
  'model-menu.js': 'export const ModelChoiceDock = () => null\nexport const ModelKeyCard = () => null\nexport const manageModels = actions => actions.openModels\n',
  'connectors.js': 'export const ConnectorDock = () => null\nexport const MailDock = () => null\n',
  'handoff-card.js': 'export const HandoffDock = () => null\n',
  'learning-card.js': 'export const LearningDock = () => null\n',
  'secret-card.js': 'export const SecretDock = () => null\n',
  'turn-error.js': "export const FailureCell = props => ({ type: 'failure-marker', props: { ...props, children: [] } })\n",
  'widget-cell.js': 'export const WidgetDock = () => null\n',
  'api.js': 'export const call = (...args) => globalThis.__chatCall(...args)\n',
}
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../ui/src/chat.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
  plugins: [{
    name: 'app-chat-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /src\/client\/(cells|model-menu|connectors|handoff-card|learning-card|secret-card|turn-error|widget-cell|api)\.js$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'app-chat-stub' }))
      bundler.onLoad({ filter: /.*/, namespace: 'app-chat-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})
let current
let chatCall = async () => ({ sessionId: 'b1', items: [], cursor: null })
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
// Null refs get a field stand-in: the composer's own effects touch its style,
// focus and caret before the browser would have attached the real textarea.
const field = {
  style: {}, scrollHeight: 0, selectionStart: 0, selectionEnd: 0,
  focus() {}, closest: () => null, contains: () => false,
  getBoundingClientRect: () => ({ left: 20, top: 700 }),
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
  addEventListener() {}, removeEventListener() {}, abort() {},
}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, next => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial === null ? field : initial })),
  useEffect: effect, useLayoutEffect: effect,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => slot(() => ({ id: 'card-id' })).id,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`no platform module ${name}`)
  },
  window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800 },
  document: { querySelector: () => null, body: {}, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { addEventListener() {}, removeEventListener() {} } },
  navigator: { language: 'en' },
  TextEncoder, btoa,
  setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  fetch: () => { throw new Error('no fetch in test') },
  __chatCall: (...args) => chatCall(...args),
})
const { Chat } = module.exports

// Function children stay inert in the React stand-in, so the tree is expanded by
// calling them: Composer, ComposerPlus and ComposerVoice really run, in order,
// sharing the hook slots the way React would.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: node.props.children.map(expand) } }
}
const mount = (props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = expand(Chat(next))
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
  }
  return instance
}
const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props.children, check)]
}
const textarea = node => all(node, child => child.type === 'textarea' && child.props?.['data-composer-input'] !== undefined)[0]
const sendButton = node => all(node, child => child.type === 'button' && child.props?.className === 'dsb-send')[0]
const answerField = node => all(node, child => child.props?.className === 'bt-q-input')[0]
const button = (node, label) => all(node, child => child.type === 'button' && child.props?.children?.some?.(item => item?.props?.children?.includes?.(label) || item === label))[0]
const option = node => all(node, child => child.type === 'button' && child.props?.role === 'option')[0]
const enter = (extra = {}) => ({
  key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, prevented: false,
  preventDefault() { this.prevented = true }, ...extra,
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

// Mounts a Bot's chat with `prefs` in the roster, types a draft, and returns the
// send log plus the rendered tree accessor.
const view = (prefs, ready = true, question, referenceRows = []) => {
  const sent = []
  const answered = []
  const roster = { ready, prefs, bots: [{ id: 'b1', name: 'Bot', sessionId: 'b1' }], rooms: [], byId: { b1: { id: 'b1', name: 'Bot' } }, roomsById: {}, questions: question ? { b1: question } : {} }
  let ui = {}
  const team = {
    actions: {
      noteSent() {},
      send: async (sessionId, text, attachments, references) => {
        sent.push(references?.length ? [sessionId, text, attachments, references] : [sessionId, text])
      },
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => referenceRows.length > 0,
      referenceChat: (sessionId, span) => { ui = { ...ui, referenceChat: { sessionId, span } } },
      closeReferenceChat: () => { ui = { ...ui, referenceChat: null } },
      referenceChats: async () => referenceRows,
      answerQuestion: async (sessionId, id, answer) => { answered.push([sessionId, id, answer]) },
      dismissQuestion() {},
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select(ui),
      useSessionStatus: select => select(new Map()),
    },
    chat: { on: () => () => {} },
  }
  const instance = mount({ sessionId: 'b1', team })
  textarea(instance.render()).props.onChange({ target: { value: 'hi' } })
  return { sent, answered, tree: () => instance.render() }
}

test('with Enter sending on, a plain Enter sends the draft and clears it', async () => {
  const { sent, tree } = view({ enterToSend: true })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(plain(sent), [['b1', 'hi']])
  assert.equal(textarea(tree()).props.value, '')
})

test('with Enter sending off, a plain Enter is a newline and the send button sends', async () => {
  const { sent, tree } = view({ enterToSend: false })
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, false)
  assert.deepEqual(plain(sent), [])
  assert.equal(textarea(tree()).props.value, 'hi')
  // The explicit send control carries the same send.
  sendButton(tree()).props.onClick()
  await tick()
  assert.deepEqual(plain(sent), [['b1', 'hi']])
  assert.equal(textarea(tree()).props.value, '')
})

test('a roster without the flag keeps the default: Enter sends', async () => {
  const { sent, tree } = view({})
  const event = enter()
  textarea(tree()).props.onKeyDown(event)
  await tick()
  assert.equal(event.prevented, true)
  assert.deepEqual(plain(sent), [['b1', 'hi']])
})

// The Bot's ask_user card shares the composer preference: off, a plain Enter in
// the own-answer field is the field's newline and the card's Submit answers.
test('the ask_user own-answer field honors the Enter preference', async () => {
  const question = { id: 'q1', question: 'Pick?', options: ['Alpha', 'Beta'], allowCustom: true }
  const sending = view({ enterToSend: true }, true, question)
  answerField(sending.tree()).props.onChange({ target: { value: 'own' } })
  const on = enter()
  answerField(sending.tree()).props.onKeyDown(on)
  await tick()
  assert.equal(on.prevented, true)
  assert.deepEqual(plain(sending.answered), [['b1', 'q1', { selected: [], custom: 'own' }]])
  const keeping = view({ enterToSend: false }, true, question)
  answerField(keeping.tree()).props.onChange({ target: { value: 'own' } })
  const off = enter()
  answerField(keeping.tree()).props.onKeyDown(off)
  await tick()
  assert.equal(off.prevented, false)
  assert.deepEqual(plain(keeping.answered), [])
})

test('Shift+Enter and IME confirmation keep their default behavior', async () => {
  for (const extra of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }]) {
    const { sent, tree } = view({ enterToSend: true })
    const event = enter(extra)
    textarea(tree()).props.onKeyDown(event)
    await tick()
    assert.equal(event.prevented, false)
    assert.deepEqual(plain(sent), [])
  }
})

test('Reference a chat picks a candidate at the captured caret and sends its durable reference', async () => {
  const row = { sessionId: 'other-session', label: 'Chat with Other', bot: { id: 'b2', name: 'Other' } }
  const { sent, tree } = view({ enterToSend: true }, true, undefined, [row])
  textarea(tree()).props.onChange({ target: { value: 'before after' } })
  field.selectionStart = 7
  field.selectionEnd = 7

  all(tree(), child => child.type === 'button' && child.props?.className === 'bt-plus')[0].props.onClick()
  button(tree(), 'Reference a chat').props.onClick()
  tree()
  await tick()
  option(tree()).props.onClick()

  assert.equal(textarea(tree()).props.value, 'before @Chat with Other after')
  sendButton(tree()).props.onClick()
  await tick()
  assert.equal(sent.length, 1)
  assert.deepEqual(plain(sent[0].slice(0, 3)), ['b1', 'before @Chat with Other after', []])
  assert.equal(sent[0][3][0].sessionId, 'other-session')
  assert.equal(sent[0][3][0].label, 'Chat with Other')
  assert.match(sent[0][3][0].ref, /^@\[Chat with Other\]\(cue-session:[A-Za-z0-9_-]+\)$/)
})

test('an Agent chat loads, sends, streams and stops only its own session', async () => {
  const calls = []
  const sent = []
  const stopped = []
  const listeners = new Set()
  const emit = (event, data) => { for (const listener of listeners) listener(event, data) }
  chatCall = async (endpoint, body) => {
    calls.push([endpoint, body])
    if (endpoint !== 'agent-chat') throw new Error(`unexpected endpoint ${endpoint}`)
    return { sessionId: 's1', items: [{ kind: 'user', text: 'Agent history', entryId: '1' }], cursor: null }
  }
  const agent = { id: 'a1', name: 'OpenCode', sessions: ['s1'] }
  const roster = {
    ready: true,
    prefs: { enterToSend: true },
    bots: [],
    rooms: [],
    byId: {},
    roomsById: {},
    agents: [agent],
    agentsById: { a1: agent },
    agentOf: { s1: 'a1' },
    questions: {},
  }
  let ui = {}
  const team = {
    actions: {
      noteSent() {},
      send: async (...args) => { sent.push(args) },
      stopAgentWork: async sessionId => { stopped.push(sessionId) },
      speech: () => undefined,
      openVoice() {},
      clearQuote() {},
      canReferenceChat: () => false,
      referenceChat() {},
      closeReferenceChat() {},
      referenceChats: async () => [],
      noteChat() {},
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select(ui),
      useSessionStatus: select => select(new Map([['s1', { running: true }]])),
    },
    chat: {
      on: next => { listeners.add(next); return () => listeners.delete(next) },
    },
  }
  const instance = mount({ sessionId: 's1', team })
  instance.render()
  await tick()

  let tree = instance.render()
  await tick()
  assert.equal(calls.some(([endpoint, body]) => endpoint === 'agent-chat' && body.sessionId === 's1'), true)
  assert.equal(all(tree, child => child.type === 'rows-marker' && child.props.items?.some(item => item.text === 'Agent history')).length, 1)

  emit('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'other', phase: 'start' })
  emit('stream', { botId: 'b1', sessionId: 'b1', attemptId: 'other', text: 'wrong conversation' })
  tree = instance.render()
  assert.equal(all(tree, child => child.type === 'bubbles-marker' && child.props.texts?.includes('wrong conversation')).length, 0)

  emit('stream', { sessionId: 's1', attemptId: 'own', phase: 'start' })
  emit('stream', { sessionId: 's1', attemptId: 'own', text: 'own reply' })
  tree = instance.render()
  assert.equal(all(tree, child => child.type === 'bubbles-marker' && child.props.texts?.includes('own reply')).length, 1)

  textarea(tree).props.onChange({ target: { value: 'hello Agent' } })
  sendButton(instance.render()).props.onClick()
  await tick()
  assert.deepEqual(plain(sent), [['s1', 'hello Agent', [], []]])

  button(instance.render(), 'Stop').props.onClick()
  await tick()
  assert.deepEqual(stopped, ['s1'])
})

test('tool calls render through the original tool cell contract', async () => {
  chatCall = async (endpoint) => {
    if (endpoint === 'chat') return {
      sessionId: 'b1',
      items: [
        { kind: 'tool-call', callId: 'c1', name: 'message_bot', arguments: { to: 'Other' } },
        { kind: 'tool-result', callId: 'c1', name: 'message_bot', text: 'sent', isError: false },
      ],
      cursor: null,
    }
    if (endpoint === 'queue') return { 'next-turn': [] }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }
  const mounted = view({})
  await tick()
  const tree = mounted.tree()
  const cells = all(tree, child => child.type === 'tool-cell-marker')
  assert.equal(cells.length, 1)
  assert.equal(cells[0].props.node.data.root.kind, 'tool-result')
  assert.equal(cells[0].props.node.data.root.name, 'message_bot')
  assert.equal(all(tree, child => child.props?.className === 'dsb-tool-row').length, 0)
})

test('a failed Bot turn uses the repair card and retries through the Bot resume action', async () => {
  const resumed = []
  chatCall = async (endpoint) => {
    if (endpoint === 'chat') {
      return {
        sessionId: 'b1',
        items: [{ kind: 'failure', entryId: 'e1', block: 0, turn: 4, reason: 'error', code: 'RATE_LIMIT', detail: 'provider request 429' }],
        cursor: null,
      }
    }
    if (endpoint === 'queue') return { 'next-turn': [] }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }
  const bot = { id: 'b1', name: 'Bot', sessionId: 'b1' }
  const roster = {
    ready: true,
    prefs: {},
    bots: [bot],
    rooms: [],
    byId: { b1: bot },
    roomsById: {},
    agents: [],
    agentsById: {},
    agentOf: {},
    questions: {},
    models: [],
    exchangeTurns: {},
  }
  const team = {
    actions: {
      noteSent() {}, send: async () => {}, stopBotWork: async () => {}, reportError() {},
      resume: async botId => { resumed.push(botId) },
      speech: () => undefined, openVoice() {}, clearQuote() {}, canReferenceChat: () => false,
      referenceChat() {}, closeReferenceChat() {}, referenceChats: async () => [], noteChat() {},
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useSessionStatus: select => select(new Map()),
      useTurnClock: select => select({ b1: { 4: { first: 1 } } }),
    },
    chat: { on: () => () => {} },
  }
  const instance = mount({ sessionId: 'b1', team })
  instance.render()
  await tick()

  const tree = instance.render()
  assert.equal(all(tree, child => child.props?.className === 'dsb-failure').length, 0)
  const failure = all(tree, child => child.type === 'failure-marker')[0]
  assert.deepEqual(plain(failure.props.node.data), {
    kind: 'turn-error', turn: 4, code: 'RATE_LIMIT', message: 'provider request 429',
  })
  await failure.props.actions.resume('b1')
  await tick()
  assert.deepEqual(resumed, ['b1'])
})

test('a running chat shows its durable queue and can explicitly steer a queued message', async () => {
  const calls = []
  const listeners = new Set()
  const emit = (event, data) => { for (const listener of listeners) listener(event, data) }
  chatCall = async (endpoint, body) => {
    calls.push([endpoint, body])
    if (endpoint === 'chat') return { sessionId: 'b1', items: [], cursor: null }
    if (endpoint === 'queue') return { 'next-turn': [] }
    if (endpoint === 'queue-update') return { itemId: 'q2' }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }
  const bot = { id: 'b1', name: 'Bot', sessionId: 'b1' }
  const roster = {
    ready: true,
    prefs: { enterToSend: true },
    bots: [bot],
    rooms: [],
    byId: { b1: bot },
    roomsById: {},
    agents: [],
    agentsById: {},
    agentOf: {},
    questions: {},
  }
  const team = {
    actions: {
      noteSent() {}, send: async () => {}, stopBotWork: async () => {}, reportError() {},
      speech: () => undefined, openVoice() {}, clearQuote() {}, canReferenceChat: () => false,
      referenceChat() {}, closeReferenceChat() {}, referenceChats: async () => [], noteChat() {},
    },
    hooks: {
      useRoster: select => select(roster),
      useUi: select => select({}),
      useSessionStatus: select => select(new Map([['b1', { running: true }]])),
    },
    sessionHook: () => select => select({ pendingSubmissions: [], running: true, subagent: null }),
    chat: {
      on: next => { listeners.add(next); return () => listeners.delete(next) },
    },
  }
  const instance = mount({ sessionId: 'b1', team })
  instance.render()
  await tick()
  emit('queue', {
    botId: 'b1',
    sessionId: 'b1',
    inbox: {
      'next-turn': [{ id: 'q1', content: [{ type: 'text', text: 'Run tests too' }], source: { kind: 'user' }, mode: 'followUp' }],
    },
  })

  const tree = instance.render()
  assert.equal(all(tree, child => child.props?.['data-queue-dock'] !== undefined).length, 1)
  const steer = all(tree, child => child.type === 'button' && child.props?.['aria-label'] === 'Steer queued message')[0]
  assert.ok(steer)
  steer.props.onClick()
  await tick()
  assert.equal(calls.some(([endpoint, body]) => endpoint === 'queue-update'
    && body.sessionId === 'b1' && body.itemId === 'q1' && body.action.kind === 'steer'), true)
})
