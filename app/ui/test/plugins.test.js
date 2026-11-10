import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientPlugins } from '../src/plugins.js'

test('client plugins load approved same-origin modules, register slots, reload, and dispose', async () => {
  let rows = [{ source: '/plugin', name: 'Example', version: '1.0.0', fingerprint: 'a'.repeat(64), entries: ['client/index.mjs'] }]
  const imported = []
  const disposed = []
  const plugins = createClientPlugins({
    React: { createElement() {} },
    call: async endpoint => {
      assert.equal(endpoint, 'plugin-client-entries')
      return rows
    },
    importModule: async url => {
      imported.push(url)
      const fingerprint = new URL(url, 'http://cue.test').pathname.split('/')[4]
      return { default: api => {
        assert.equal(api.package.name, 'Example')
        const off = api.ui.register('settings.page', { id: 'example', label: 'Example' }, function ExamplePage() {})
        api.ui.register('app.overlay', { id: 'example-overlay' }, function ExampleOverlay() {})
        return () => { off(); disposed.push(fingerprint) }
      } }
    },
  })

  await plugins.sync()
  assert.deepEqual(imported, [`/api/bot/plugin/${'a'.repeat(64)}/client/index.mjs`])
  assert.equal(plugins.snapshot().slots['settings.page'][0].definition.label, 'Example')
  assert.equal(plugins.snapshot().slots['app.overlay'].length, 1)
  await plugins.sync()
  assert.equal(imported.length, 1)

  rows = [{ ...rows[0], version: '2.0.0', fingerprint: 'b'.repeat(64) }]
  await plugins.sync()
  assert.deepEqual(disposed, ['a'.repeat(64)])
  assert.equal(imported.length, 2)
  assert.equal(plugins.snapshot().packages[0].version, '2.0.0')

  await plugins.close()
  assert.deepEqual(disposed, ['a'.repeat(64), 'b'.repeat(64)])
  assert.deepEqual(plugins.snapshot().slots, {})
})

test('client plugins reject unknown slots without preventing other packages from loading', async () => {
  const rows = [
    { source: 'bad', name: 'Bad', version: '1', fingerprint: 'a'.repeat(64), entries: ['bad.mjs'] },
    { source: 'good', name: 'Good', version: '1', fingerprint: 'b'.repeat(64), entries: ['good.mjs'] },
  ]
  const plugins = createClientPlugins({
    React: {},
    call: async () => rows,
    importModule: async url => ({ default: api => {
      if (url.endsWith('/bad.mjs')) api.ui.register('window.everything', { id: 'bad' }, () => null)
      else api.ui.register('conversation.before', { id: 'good' }, () => null)
    } }),
  })
  await plugins.sync()
  assert.equal(plugins.snapshot().slots['conversation.before'].length, 1)
  assert.match(plugins.snapshot().packages.find(row => row.name === 'Bad').error, /Unknown Cue UI slot/)
  await plugins.close()
})

test('client plugin styles stay out of UI slots and are removed on close', async () => {
  const elements = []
  const page = {
    head: { append: element => elements.push(element) },
    createElement: () => ({ dataset: {}, textContent: '', remove() { this.removed = true } }),
  }
  const plugins = createClientPlugins({
    React: {},
    document: page,
    call: async () => [{ source: 'styled', name: 'Styled', version: '1', fingerprint: 'c'.repeat(64), entries: ['client.mjs'] }],
    importModule: async () => ({ default: api => api.ui.style('.example {}') }),
  })
  await plugins.sync()
  assert.deepEqual(plugins.snapshot().slots, {})
  assert.equal(elements.length, 1)
  assert.equal(elements[0].dataset.cuePlugin, 'Styled')
  await plugins.close()
  assert.equal(elements[0].removed, true)
})

test('client plugins reject core and duplicate settings page ids', async () => {
  const rows = [
    { source: 'core', name: 'Core collision', version: '1', fingerprint: 'd'.repeat(64), entries: ['core.mjs'] },
    { source: 'first', name: 'First', version: '1', fingerprint: 'e'.repeat(64), entries: ['first.mjs'] },
    { source: 'second', name: 'Second', version: '1', fingerprint: 'f'.repeat(64), entries: ['second.mjs'] },
  ]
  const plugins = createClientPlugins({
    React: {},
    settingsPageIds: ['general'],
    call: async () => rows,
    importModule: async url => ({ default: api => {
      const id = url.endsWith('/core.mjs') ? 'general' : 'shared'
      api.ui.register('settings.page', { id, label: id }, () => null)
    } }),
  })
  await plugins.sync()
  assert.equal(plugins.snapshot().slots['settings.page'].length, 1)
  assert.equal(plugins.snapshot().slots['settings.page'][0].package.name, 'First')
  assert.match(plugins.snapshot().packages.find(row => row.name === 'Core collision').error, /already registered by Cue/)
  assert.match(plugins.snapshot().packages.find(row => row.name === 'Second').error, /already registered by First/)
  await plugins.close()
})

test('closing during a client module import cannot register UI afterward', async () => {
  let release
  const imported = new Promise(resolve => { release = resolve })
  const plugins = createClientPlugins({
    React: {},
    call: async () => [{ source: 'slow', name: 'Slow', version: '1', fingerprint: '1'.repeat(64), entries: ['slow.mjs'] }],
    importModule: () => imported,
  })
  const syncing = plugins.sync()
  await Promise.resolve()
  const closing = plugins.close()
  release({ default: api => api.ui.register('app.overlay', { id: 'late' }, () => null) })
  await Promise.all([syncing, closing])
  assert.deepEqual(plugins.snapshot(), { packages: [], slots: {} })
})
