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
    contents: "export { installStyles } from './src/client/styles.js'",
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

// Cue's style tags in a document, all of them or those of one group.
const tagged = (document, tag) => [...document.head.querySelectorAll('style')]
  .filter(style => style.dataset.cue !== undefined && (tag === undefined || style.dataset.cue === tag))

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

test('every Cue style is tagged by its group', () => {
  const { window, module } = bench()
  const { installStyles } = module.exports
  const { document } = window

  const plain = installStyles('a{color:red}', 'mentions')
  assert.equal(plain.dataset.cue, 'mentions')
  assert.deepEqual(tagged(document, 'mentions'), [plain])
})

test('the chat-room rule is installed through installStyles, so it is owned too', () => {
  const pane = readFileSync(new URL('../src/client/frame-watch.js', import.meta.url), 'utf8')
  assert.match(pane, /installStyles\(.*'chat-room'/)
  assert.equal(pane.includes("dataset.cue = 'chat-room'"), false)
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
