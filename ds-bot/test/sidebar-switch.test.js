import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { SHELL_CSS } from './src/client/styles.js'\nexport { SIDEBAR_CSS, TeamSidebar } from './src/client/sidebar.js'",
    resolveDir: ROOT,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})

const react = {
  createContext: initial => ({ value: initial }),
  useContext: context => context.value,
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280 },
})
const { SHELL_CSS, SIDEBAR_CSS, TeamSidebar } = module.exports

const roster = {
  bots: [{ id: 'writer', name: 'Writer', createdAt: 1 }],
  rooms: [{ id: 'room', name: 'Team', members: [], createdAt: 2 }],
  agents: [{ id: 'agent', name: 'Local', sessions: ['session'], createdAt: 3 }],
  byId: { writer: { id: 'writer', name: 'Writer', createdAt: 1 } },
  roomsById: {}, sections: [], ready: true,
}

const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

function sidebar(wide, overrides = {}) {
  const calls = []
  const actions = {
    openSession: id => { calls.push(['openSession', id]); return id },
    openAgent: id => { calls.push(['openAgent', id]); return id },
    openAgentSession: id => { calls.push(['openAgentSession', id]); return id },
    newAgentSession: id => { calls.push(['newAgentSession', id]); return id },
    toggleSidebar: () => calls.push(['toggleSidebar']),
    openPalette() {}, openNewChat() {}, clearUnread() {},
    ...overrides.actions,
  }
  const tree = TeamSidebar({
    wide, actions,
    useRoster: pick => pick(overrides.roster ?? roster),
    useUi: pick => pick({ unread: {}, bootFailed: false, renameSection: null }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }),
    useUpdate: pick => pick({}),
  })
  return { tree, calls }
}

test('the owned sidebar switches between full and rail layouts', () => {
  const full = sidebar(true)
  assert.equal(full.tree.props.className, 'bt-side')
  let collapse
  walk(full.tree, node => {
    if (node.type === 'button' && node.props?.['aria-label'] === 'Collapse sidebar') collapse = node
  })
  assert.ok(collapse)
  collapse.props.onClick()
  assert.deepEqual(full.calls, [['toggleSidebar']])

  const rail = sidebar(false)
  assert.equal(rail.tree.props.className, 'bt-side bt-rail')
  let railCollapse = false
  walk(rail.tree, node => {
    if (node.type === 'button' && node.props?.['aria-label'] === 'Collapse sidebar') railCollapse = true
  })
  assert.equal(railCollapse, false)
})

test('sidebar rows call Cue navigation directly', () => {
  const { tree, calls } = sidebar(true)
  const rows = []
  walk(tree, node => {
    if (['BotRow', 'RoomRow', 'AgentRow'].includes(node.type?.name)) rows.push(node)
  })
  assert.equal(rows.length, 3)
  rows[0].props.actions.openSession('bot-chat')
  rows[1].props.actions.openSession('room-chat')
  rows[2].props.actions.openAgent('agent')
  assert.deepEqual(calls, [
    ['openSession', 'bot-chat'],
    ['openSession', 'room-chat'],
    ['openAgent', 'agent'],
  ])
})

test('sidebar styles use only Cue-owned selectors', () => {
  const css = `${SHELL_CSS}\n${SIDEBAR_CSS}`
  assert.doesNotMatch(css, /\[class[*^$]?=/)
  assert.match(css, /\.bt-rail \.bt-list\{[^}]*gap:8px/)
  assert.match(css, /\.bt-side-foot-rail\{[^}]*gap:8px/)
})
