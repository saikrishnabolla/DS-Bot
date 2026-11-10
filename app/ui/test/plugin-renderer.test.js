import assert from 'node:assert/strict'
import { register } from 'node:module'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createElement as h } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const peerModules = {
  react: new URL('../../node_modules/react/index.js', import.meta.url).href,
  'react-dom': new URL('../../node_modules/react-dom/index.js', import.meta.url).href,
  'qrcode-generator': new URL('../../node_modules/qrcode-generator/dist/qrcode.mjs', import.meta.url).href,
}
const loader = `const peers = ${JSON.stringify(peerModules)}
export async function resolve(specifier, context, nextResolve) {
  if (peers[specifier]) return { url: peers[specifier], shortCircuit: true }
  return nextResolve(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
await waitImmediate()
const { SettingsDialog } = await import('../../../ds-bot/src/client/settings.js')

test('Settings renders a registered client plugin page without replacing core pages', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://owned.test/' })
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    requestAnimationFrame: callback => dom.window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: id => dom.window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let root
  t.after(() => {
    if (root) act(() => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })

  const opened = []
  const actions = {
    closeSettings() {},
    openSettings: page => opened.push(page),
  }
  const roster = { byId: {}, roomsById: {}, bots: [], rooms: [], prefs: {} }
  const registration = {
    key: 'sample:1',
    package: { name: 'Sample', version: '1.0.0' },
    definition: { id: 'sample', label: 'Sample plugin' },
    component: ({ package: pkg }) => h('div', { 'data-plugin-page': '' }, `${pkg.name} ${pkg.version}`),
  }
  root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => {
    root.render(h(SettingsDialog, {
      page: 'sample',
      roster,
      actions,
      useUpdate: select => select({}),
      pluginPages: [registration],
    }))
  })

  assert.equal(dom.window.document.querySelector('[data-plugin-page]')?.textContent, 'Sample 1.0.0')
  assert.equal(dom.window.document.querySelector('h2')?.textContent, 'Sample plugin')
  const labels = [...dom.window.document.querySelectorAll('.bt-settings-item')].map(node => node.textContent)
  assert.ok(labels.includes('General'))
  assert.ok(labels.includes('Sample plugin'))

  dom.window.document.querySelector('.bt-settings-item')?.click()
  assert.deepEqual(opened, ['general'])
})
