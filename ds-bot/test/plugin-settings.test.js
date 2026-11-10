import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/client/built-in-plugins.js'; export * from './src/client/agent-presets.js'",
    resolveDir: ROOT,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})

const slots = []
let index = 0
let tree
let renderRoot
const rerender = () => { index = 0; tree = expand(renderRoot()) }
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useEffect: effect => {
    const own = index++
    if (!(own in slots)) { slots[own] = true; effect() }
  },
  useMemo: make => make(),
  useRef: current => ({ current }),
  useState: initial => {
    const own = index++
    if (!(own in slots)) slots[own] = typeof initial === 'function' ? initial() : initial
    return [slots[own], value => { slots[own] = typeof value === 'function' ? value(slots[own]) : value; rerender() }]
  },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => name === 'react' ? react : {},
  console,
})
const { AgentPresetsPage, BuiltInPluginsPage } = module.exports

function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
}

function collect(match, node = tree, out = [], seen = new Set()) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(child => collect(match, child, out, seen)); return out }
  if (typeof node !== 'object') return out
  if (seen.has(node)) return out
  seen.add(node)
  if (match(node)) out.push(node)
  collect(match, node.props?.children, out, seen)
  return out
}

function text(node, seen = new Set()) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(child => text(child, seen)).join('')
  if (typeof node !== 'object') return String(node)
  if (seen.has(node)) return ''
  seen.add(node)
  return text(node.props?.children, seen)
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('Built-in plugins loads the owned inventory and filters its real session cards', async () => {
  slots.length = 0
  const opened = []
  const actions = {
    pluginInventory: async () => ({
      defaultPreset: 'standard',
      presets: [{ id: 'standard', name: 'Standard mode', broken: null }],
      session: [
        { id: 'read', title: 'Read', description: 'Read a file.', module: 'cue-tool:read', scope: 'session', state: 'active' },
        { id: 'web_search', title: 'Web search', description: 'Search the web.', module: 'cue-tool:web_search', scope: 'session', state: 'active' },
      ],
      global: [{ id: 'pi-durable', title: 'Pi Durable', description: 'Durable runtime.', module: '@earendil-works/pi-durable', scope: 'global', state: 'active' }],
    }),
    selectPanel: id => opened.push(id),
  }
  renderRoot = () => BuiltInPluginsPage({ actions })
  rerender()
  assert.match(text(tree), /Inspect the plugins this deployment ships/)
  await flush()

  assert.equal(collect(node => node.props?.className === 'bt-plugin-card').length, 2)
  assert.match(text(tree), /Standard mode \(default\)/)
  const preset = collect(node => node.type === 'button' && node.props?.className === 'bt-plugin-preset')[0]
  preset.props.onClick()
  assert.deepEqual(opened, ['agent-presets'])
  const search = collect(node => node.type === 'input' && node.props?.type === 'search')[0]
  assert.ok(search)
  search.props.onChange({ target: { value: 'web' } })
  assert.equal(collect(node => node.props?.className === 'bt-plugin-card').length, 1)
  assert.match(text(tree), /Web search/)
  assert.doesNotMatch(text(tree), /Read a file/)
})

test('Agent presets shows the owned modes and changes the durable new-session default', async () => {
  slots.length = 0
  const rows = [
    { id: 'standard', name: 'Standard mode', group: 'built-in', description: 'Everyday work.' },
    { id: 'ptc', name: 'PTC mode', group: 'built-in', description: 'Batch tool work.' },
    { id: 'minimal', name: 'Minimal mode', group: 'built-in', description: 'Focused tools.' },
    { id: 'creator', name: 'Creator mode', group: 'built-in', description: 'Customize Cue.' },
    { id: 'review', name: 'Review mode', group: 'custom', description: 'Review without editing.', tools: ['read'], instructions: 'Cite evidence.' },
  ]
  const calls = []
  const actions = {
    agentPresets: async () => ({ defaultPreset: 'standard', rows }),
    setAgentPresetDefault: async id => {
      calls.push(id)
      return { defaultPreset: id, rows }
    },
  }
  renderRoot = () => AgentPresetsPage({ actions })
  rerender()
  await flush()

  assert.equal(collect(node => node.props?.className === 'bt-preset-card').length, 5)
  assert.match(text(tree), /Review modeCustom/)
  assert.match(text(tree), /Standard modeNew task default/)
  const minimal = collect(node => node.type === 'button' && node.props?.className === 'bt-preset-card-main' && text(node).includes('Minimal mode'))[0]
  assert.ok(minimal)
  minimal.props.onClick()
  await flush()
  assert.deepEqual(calls, ['minimal'])
  assert.match(text(tree), /Minimal modeNew task default/)
})

test('Agent presets starts a Creator session from its custom preset action', async () => {
  slots.length = 0
  const calls = []
  const actions = {
    agentPresets: async () => ({
      defaultPreset: 'standard',
      rows: [{ id: 'creator', name: 'Creator mode', group: 'built-in', description: 'Customize Cue.' }],
    }),
    setAgentPresetDefault: async () => {},
    startAgentPresetCreator: async () => { calls.push('creator') },
  }
  renderRoot = () => AgentPresetsPage({ actions })
  rerender()
  await flush()

  const create = collect(node => node.type === 'button' && node.props?.className === 'bt-preset-create')[0]
  assert.ok(create)
  create.props.onClick()
  await flush()
  assert.deepEqual(calls, ['creator'])
})
