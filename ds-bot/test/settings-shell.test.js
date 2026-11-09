import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const bundle = async (contents) => (await build({
  stdin: { contents, resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})).outputFiles[0].text

// A stand-in React that draws one tree with effects left out.
const react = {
  Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useCallback: fn => fn, useRef: current => ({ current }), useMemo: make => make(), useId: () => 'id',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}
const load = (text) => {
  const module = { exports: {} }
  runInNewContext(text, {
    module, exports: module.exports,
    window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout, clearTimeout, Promise,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: (_, key) => key })),
  })
  return module.exports
}
const shell = load(await bundle("export * from './src/client/settings-shell.js'"))
const { SettingsDialog } = load(await bundle("export { SettingsDialog } from './src/client/settings.js'"))

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')
const roster = { byId: {}, roomsById: {}, bots: [], rooms: [], models: [], prefs: {} }
test('onboarding skips DSH\'s preview notice and keeps the ledger order', () => {
  const entries = [
    { options: { id: 'deepseek-official', order: 0 } },
    { options: { id: 'welcome-notice', order: -100 } },
    { options: { id: 'late', order: 5 } },
  ]
  assert.deepEqual(shell.stepRows(entries).map(row => row.id), ['deepseek-official', 'late'])
})

test('the coordinator runs first-run steps on a blank main view, and a requested step at any time', () => {
  const steps = [{ id: 'a' }, { id: 'b' }]
  const blank = { phase: 'ready', byId: { s: { retainedBy: { mainView: 1 }, blank: true } } }
  const busy = { phase: 'ready', byId: { s: { retainedBy: { mainView: 1 }, blank: false } } }
  assert.equal(shell.onboardingActive(blank), true)
  assert.equal(shell.onboardingActive(busy), false)
  assert.equal(shell.onboardingActive({ phase: 'loading', byId: {} }), false)
  assert.equal(shell.pickStep({ steps, active: true, completed: new Set(['a']) }).id, 'b')
  assert.equal(shell.pickStep({ steps, active: false, completed: new Set() }), undefined)
  assert.equal(shell.pickStep({ steps, requested: 'a', active: false, completed: new Set(['a']) }).id, 'a')
})

test('a step\'s openSection lands on DS Bot\'s page for that section', () => {
  assert.deepEqual([...shell.settingsPlace('models')], ['models'])
  assert.deepEqual([...shell.settingsPlace('general')], ['general'])
  assert.deepEqual([...shell.settingsPlace('plugins')], ['dsh', 'plugins'])
})

test('the Desktop update carrier feeds the status, and one action runs at a time', async () => {
  let push
  let opened = 0
  const source = shell.desktopUpdateSource({
    subscribe: (fn) => { push = fn; return () => {} },
    status: () => Promise.resolve({ phase: 'available', version: '0.3.0' }),
    open: () => { opened += 1; return new Promise(() => {}) },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(source.store.getSnapshot().presentation.phase, 'available')
  assert.equal(shell.updateCopy(source.store.getSnapshot()).label, 'New version')
  source.open()
  source.open()
  assert.equal(opened, 1)
  push({ phase: 'downloading', percent: 40, version: '0.3.0' })
  assert.equal(shell.updateCopy(source.store.getSnapshot()).label, '40%')
  source.dispose()
  assert.equal(shell.desktopUpdateSource(undefined).store.getSnapshot().presentation, undefined)
})

test('the settings file action shows only when the Host has a document to open', async () => {
  let view = { view: { hasDocument: true }, error: null }
  const describe = { getSnapshot: () => view, subscribe: () => () => {}, ensure: async () => {} }
  const ready = shell.documentSource(describe, async () => ({ ok: false, error: { message: 'no editor' } }))
  await ready.load()
  assert.equal(ready.store.getSnapshot().status, 'ready')
  await ready.open()
  assert.equal(ready.store.getSnapshot().error, 'no editor')
  view = { view: { hasDocument: false }, error: null }
  const none = shell.documentSource(describe, async () => ({ ok: true }))
  await none.load()
  assert.equal(none.store.getSnapshot().status, 'unavailable')
})

// The dialog with DSH's ledger: renderSlot answers with a marker naming what it drew.
function dialog({ page = 'general', id = null, sections, items = [], actions = {} } = {}) {
  const calls = []
  const drawn = []
  const dsh = {
    sections: sections ?? [{ id: 'account', order: -10, label: 'Account' }, { id: 'general', order: 0, label: 'General' }, { id: 'models', order: 10, label: 'Models' }, { id: 'plugins', order: 15, label: 'Plugins' }, { id: 'agent-presets', order: 20, label: 'Agent presets' }],
    items,
    renderSlot: (name, owner, opts) => { drawn.push([name, opts?.only ?? null]); return { type: 'slot', props: { name, only: opts?.only ?? null } } },
  }
  const all = { closeSettings: () => calls.push('close'), openSettings: (...args) => calls.push(args), providers: () => {}, ...actions }
  const tree = SettingsDialog({ page, id, roster, actions: all, useUpdate: pick => pick({}), dsh })
  return { tree, calls, drawn }
}
const navLabels = tree => walk(walk(tree, node => node.type === 'nav')[0], node => node.type === 'button').map(textOf)

test('one Settings: DS Bot\'s pages, then DSH\'s, then Feedback and About; no Harness settings', () => {
  const labels = navLabels(dialog().tree)
  assert.ok(!labels.includes('Harness settings'))
  assert.deepEqual(labels.slice(-5), ['Account', 'Plugins', 'Agent presets', 'Feedback', 'About DS Bot'])
  assert.equal(labels.filter(label => label === 'General').length, 1)
  assert.equal(labels.filter(label => label === 'Models').length, 1)
})

test('a DSH page opens in the dialog and draws that section', () => {
  const nav = dialog()
  walk(nav.tree, node => node.type === 'button' && textOf(node) === 'Plugins')[0].props.onClick()
  assert.deepEqual(nav.calls, [['dsh', 'plugins']])
  const page = dialog({ page: 'dsh', id: 'plugins' })
  assert.ok(page.drawn.some(([name, only]) => name === 'settings.section' && only === 'plugins'))
  assert.equal(textOf(walk(page.tree, node => node.type === 'h2')[0]), 'Plugins')
})

test('a DSH page that left the ledger falls back to General', () => {
  const { tree, drawn } = dialog({ page: 'dsh', id: 'gone' })
  assert.equal(textOf(walk(tree, node => node.type === 'h2')[0]), 'General')
  assert.ok(!drawn.some(([name]) => name === 'settings.section'))
})

test('DSH\'s Models page is Models → Advanced settings, with a way back', () => {
  const page = dialog({ page: 'models', id: 'advanced' })
  assert.ok(page.drawn.some(([name, only]) => name === 'settings.section' && only === 'models'))
  const [back] = walk(page.tree, node => node.type === 'button' && node.props['aria-label'] === 'Back to models')
  back.props.onClick()
  assert.deepEqual(page.calls, [['models']])
  const providersOf = tree => walk(tree, node => typeof node.type === 'function' && node.type.name === 'ProvidersPage')[0]
  assert.equal(typeof providersOf(dialog({ page: 'models' }).tree).props.advanced, 'function')
  assert.equal(providersOf(dialog({ page: 'models', sections: [] }).tree).props.advanced, null)
})

test('DSH\'s General rows join General: the look under Appearance, the rest under More', () => {
  const items = [{ id: 'permission', order: -20 }, { id: 'language', order: 0 }, { id: 'appearance', order: 10 }, { id: 'font-size', order: 11 }, { id: 'developer-tools', order: 15 }]
  const [general] = walk(dialog({ items }).tree, node => typeof node.type === 'function' && node.type.name === 'GeneralPage')
  const sections = general.type(general.props).filter(Boolean)
  const only = node => walk(node, item => item.type === 'slot').map(item => item.props.only)
  assert.deepEqual(only(sections.find(node => node.props.key === 'look')), ['appearance', 'font-size'])
  assert.deepEqual(only(sections.find(node => node.props.key === 'more')), ['permission', 'language', 'developer-tools'])
})

test('header actions from DSH and plugins sit beside the title', () => {
  assert.ok(dialog().drawn.some(([name]) => name === 'settings.action'))
})

test('General settings keeps the Classic Agent mode switch', () => {
  const calls = []
  const tree = SettingsDialog({
    page: 'general', id: null, roster, useUpdate: pick => pick({}),
    actions: { closeSettings() {}, openSettings() {}, setSurface: mode => calls.push(mode) },
  })
  const [general] = walk(tree, node => typeof node.type === 'function' && node.type.name === 'GeneralPage')
  const [row] = walk(general.type(general.props), node => node.props?.label === 'Classic Agent mode')
  assert.ok(row !== undefined)
  const [button] = walk(row, node => node.type === 'button' && textOf(node) === 'Switch')
  button.props.onClick()
  assert.deepEqual(calls, ['agent'])
})

// Settings in Agent mode carries DS Bot's own rules only: the DSH page around it keeps its look.
const styles = load(await bundle("export { botOwnCss, SHELL_CSS } from './src/client/styles.js'"))

test('the Agent-mode sheet keeps DS Bot\'s own rules and drops the shell overrides', () => {
  const css = `body{--bt-ink:#111;-webkit-tap-highlight-color:transparent}
[class*="_footArea"]{display:grid}
.bt-row,[class*="_trigger"] span{color:red}
@media (max-width:600px){.bt-a{gap:2px}[class*="_x"]{gap:0}}
@keyframes bt-spin{to{rotate:1turn}}
body[data-bt-motion=lively] .bt-mark{animation:none}`
  const own = styles.botOwnCss(css)
  assert.match(own, /^body\{--bt-ink:#111\}$/m)
  assert.doesNotMatch(own, /class\*=|tap-highlight/)
  assert.match(own, /^\.bt-row\{color:red\}$/m)
  assert.match(own, /@media \(max-width:600px\)\{\.bt-a\{gap:2px\}\n\}/)
  assert.match(own, /@keyframes bt-spin/)
  assert.match(own, /body\[data-bt-motion=lively\] \.bt-mark\{animation:none\}/)
  const shellOwn = styles.botOwnCss(styles.SHELL_CSS)
  assert.doesNotMatch(shellOwn, /class\*=/)
  assert.match(shellOwn, /\.bt-settings-nav\{/)
  assert.match(shellOwn, /body\[data-ds-dark-theme\]\{--bt-im-telegram:/)
})

test('in Agent mode, General offers the way back to Bot mode', () => {
  const calls = []
  const tree = SettingsDialog({
    page: 'general', id: null, roster, useUpdate: pick => pick({}),
    actions: { closeSettings() {}, openSettings() {}, surfaceMode: () => 'agent', setSurface: mode => calls.push(mode) },
  })
  const [general] = walk(tree, node => typeof node.type === 'function' && node.type.name === 'GeneralPage')
  const [row] = walk(general.type(general.props), node => node.props?.label === 'Bot mode')
  walk(row, node => node.type === 'button' && textOf(node) === 'Switch')[0].props.onClick()
  assert.deepEqual(calls, ['bot'])
})
