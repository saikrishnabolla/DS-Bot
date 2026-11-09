import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// The style helpers and the CSS they ship, bundled once with a minimal React for
// motion.js; they run in each test's jsdom document through the vm context.
const { outputFiles } = await build({
  stdin: {
    contents: "export { installStyles, installCompiledStyles } from './src/client/styles.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}

const tick = () => new Promise(resolve => setImmediate(resolve))
// DS Bot's style tags in a document, all of them or those of one group.
const tagged = (document, tag) => [...document.head.querySelectorAll('style')]
  .filter(style => style.dataset.dshBot !== undefined && (tag === undefined || style.dataset.dshBot === tag))

const bench = () => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: window.document,
    MutationObserver: window.MutationObserver,
    HTMLLinkElement: window.HTMLLinkElement,
    setTimeout, clearTimeout,
    require: name => (name === 'react' ? react : {}),
  })
  return { window, module }
}

// #228: our style tags carry the client module id, so another module's materialization
// cannot claim them and its teardown cannot delete them.
test('every DS Bot style is tagged for the ds-bot client module', () => {
  const { window, module } = bench()
  const { installStyles, installCompiledStyles } = module.exports
  const { document } = window

  const plain = installStyles('a{color:red}', 'mentions')
  installCompiledStyles('.b{position:fixed}', 'shell')
  const [compiled] = tagged(document, 'shell')
  for (const style of [plain, compiled]) {
    assert.equal(style.dataset.dshBot !== undefined, true)
    assert.equal(style.dataset.plugin, 'ds-bot')
    assert.equal(style.matches('style:not([data-plugin])'), false)
  }
})

test('a compiled style removed from outside comes back, until its cleanup runs', async () => {
  const { window, module } = bench()
  const { installCompiledStyles } = module.exports
  const { document } = window
  const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
  const [style] = tagged(document, 'shell')
  assert.ok(style.isConnected)

  style.remove()
  await tick()
  assert.equal(style.isConnected, true, 'the observer puts a removed node back')

  dispose()
  await tick()
  assert.equal(style.isConnected, false)
  // Later page changes cannot resurrect it.
  const late = document.createElement('style')
  document.head.appendChild(late)
  await tick()
  assert.equal(style.isConnected, false)
})

test('mounting and unmounting compiled styles twice leaves no extra nodes', async () => {
  const { window, module } = bench()
  const { installCompiledStyles } = module.exports
  const { document } = window
  for (let round = 0; round < 2; round += 1) {
    const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
    await tick()
    dispose()
  }
  await tick()
  assert.equal(tagged(document).length, 0)
})

test('the chat-room rule is installed through installStyles, so it is owned too', () => {
  const pane = readFileSync(new URL('../src/client/frame-watch.js', import.meta.url), 'utf8')
  assert.match(pane, /installStyles\(.*'chat-room'/)
  assert.equal(pane.includes("dataset.dshBot = 'chat-room'"), false)
})

test('message tools anchor to the bottom of a long reply in both layouts', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.bt-tools\{position:absolute;bottom:0;/)
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-tools\{bottom:-14px;/)
  assert.doesNotMatch(css, /\.bt-tools\{position:absolute;top:50%;/)
})

test('the tools toolbar keeps its own stacking context for the hover bridge', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  // Without a stacking context on .bt-tools, the ::after bridge's z-index:-1
  // sinks behind the full-width .bt-astack and the toolbar flickers when the
  // pointer crosses the gap.
  assert.match(css, /\.bt-tools\{position:absolute;bottom:0;z-index:0;/)
  assert.match(css, /\.bt-tools::after\{[^}]*z-index:-1/)
})

test('the flat toolbar does not cover reactions below the message', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-msg:has\(>\.bt-reacts\) \.bt-tools\{bottom:0\}/)
})
