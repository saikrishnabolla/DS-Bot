import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { ComposerVoice, useRemoteDictation } from './src/client/composer.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: 'fragment',
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (_sub, get) => get(),
  createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value,
}
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  AbortController, Error, Map, Set, URL, btoa, console, setTimeout, clearTimeout,
})
const { ComposerVoice, useRemoteDictation } = module.exports

const nodes = value => {
  if (value === null || value === undefined || typeof value !== 'object') return []
  return [value, ...(value.props?.children ?? []).flatMap(nodes)]
}

const render = speech => ComposerVoice({
  sessionId: 'bot-1',
  inputActions: { insertText() {}, captureInsertion: () => ({}) },
  actions: { speech: () => speech, clearQuote() {}, openVoice() {} },
  useUi: selector => selector({ quote: null }),
  useRoster: selector => selector({ prefs: {} }),
})

test('the composer keeps its dictation button with local speech or browser speech', () => {
  const local = nodes(render({})).filter(node => node.props?.className === 'bt-mic')
  const browser = nodes(render(undefined)).filter(node => node.props?.className === 'bt-mic')
  assert.equal(local.length, 1)
  assert.equal(browser.length, 1)
})

const catalog = phase => ({
  providers: [{ id: 'local', preparation: { phase } }],
  selection: { providerId: 'local', language: 'en' },
  maxDurationSeconds: 30,
  maxAudioBytes: 1024,
})

test('owned composer dictation prepares when needed and inserts a local transcript', async () => {
  const prepared = []
  const inserted = []
  let phase = 'unprepared'
  const speech = {
    catalog: async () => ({ ok: true, value: catalog(phase) }),
    prepare: async providerId => { prepared.push(providerId); return { ok: true } },
    transcribe: async request => {
      assert.equal(request.providerId, 'local')
      assert.match(request.audioBase64, /^UklGR/u)
      return { ok: true, value: { text: 'written locally' } }
    },
  }
  const capture = async () => ({
    cancel() {},
    finish: async () => new Uint8Array([82, 73, 70, 70]),
  })
  const dictation = useRemoteDictation(speech, (text, final) => inserted.push([text, final]), { capture })

  assert.equal(await dictation.start(), false)
  assert.deepEqual(prepared, ['local'])
  phase = 'ready'
  assert.equal(await dictation.start(), true)
  await dictation.stop()
  assert.deepEqual(inserted, [['written locally', true]])
})

test('owned composer dictation aborts an in-flight local transcription', async () => {
  let cancelled = false
  let started
  const began = new Promise(resolve => { started = resolve })
  const speech = {
    catalog: async () => ({ ok: true, value: catalog('ready') }),
    transcribe: async (_request, signal) => await new Promise((resolve, reject) => {
      started()
      signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
    }),
  }
  const capture = async () => ({ cancel() {}, finish: async () => new Uint8Array([82, 73, 70, 70]) })
  const dictation = useRemoteDictation(speech, () => assert.fail('cancelled dictation inserted text'), { capture })

  assert.equal(await dictation.start(), true)
  const stopping = dictation.stop()
  await began
  dictation.cancel()
  await stopping
  assert.equal(cancelled, true)
})
