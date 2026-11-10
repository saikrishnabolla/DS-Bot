import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/header.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment' },
      'react-dom': { createPortal: node => node },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { HeaderPill } = module.exports

const roster = { byId: { a: { id: 'a', name: 'Chief', sessionId: 'a' } }, roomsById: {}, bots: [], exchangeTurns: {}, questions: {} }
const hook = value => select => select(value)
const header = (actions, navigation = {}) => HeaderPill({
  sessionId: 'a',
  useRoster: hook(roster),
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useSession: hook({}),
  useActivity: hook({}),
  useMemoryNews: hook({}),
  useTurnClock: hook({}),
  useUi: hook({}),
  useLive: hook({}),
  actions,
  ...navigation,
})
const sideButton = (node) => {
  if (node === null || typeof node !== 'object') return null
  if (node.props?.['data-bt-right-sidebar'] !== undefined) return node
  for (const child of node.children ?? []) {
    const found = sideButton(child)
    if (found) return found
  }
  return null
}

// 公开#456: the Bot header carries no right-sidebar toggle — the drawer and the
// column never share the window, and the way in sits in the drawer instead.
test('the Bot header has no right sidebar button', () => {
  assert.equal(sideButton(header({ hasRightSidebar: () => true, toggleRightSidebar: () => {} })), null)
  assert.equal(sideButton(header({})), null)
})
test('a Bot in another Conversation View can return to chat without changing its draft', () => {
  const state = { view: 'study-workspace', draft: 'Keep this draft', viewRequest: null }
  const views = [{ id: 'chat' }, { id: 'study-workspace' }]
  let details = 0
  const navigation = {
    useStore: hook(state), useConversationViews: hook(views),
    selectView: view => { state.view = view },
  }
  const actions = { toggleDetails: () => { details += 1 } }
  const pill = header(actions, navigation).children[0]
  assert.equal(pill.props['aria-label'], 'Back to chat')
  assert.equal(pill.props['aria-expanded'], undefined)
  assert.equal(pill.props.title, 'Chief')
  pill.props.onClick()
  assert.equal(state.view, 'chat')
  assert.equal(state.draft, 'Keep this draft')
  assert.equal(details, 0)
  const restored = header(actions, navigation).children[0]
  assert.equal(restored.props['aria-label'], 'View conversation details')
  restored.props.onClick()
  assert.equal(details, 1)
})

test('a missing View or navigation face keeps the ordinary Bot header', () => {
  const views = [{ id: 'chat' }, { id: 'trajectory' }]
  for (const view of [null, 'chat', 'missing-view']) {
    const pill = header({}, { useStore: hook({ view }), useConversationViews: hook(views), selectView() {} }).children[0]
    assert.equal(pill.props['aria-label'], 'View conversation details')
  }
  assert.equal(header({}).children[0].props['aria-label'], 'View conversation details')
})
