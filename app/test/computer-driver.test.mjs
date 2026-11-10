import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerDriverHost, packagedComputerModule } from '../src/computer-driver.mjs'

test('packaged computer modules resolve from the unpacked dependency', () => {
  assert.match(packagedComputerModule('/Applications/Cue.app/Contents/Resources', 'index.js'),
    /^file:\/\/\/Applications\/Cue\.app\/Contents\/Resources\/app\.asar\.unpacked\/node_modules\/@trycua\/cua-driver\/dist\/index\.js$/u)
  assert.match(packagedComputerModule('/opt/Cue/resources', 'index.js', 'linux'),
    /^file:\/\/\/opt\/Cue\/resources\/app\/node_modules\/@trycua\/cua-driver\/dist\/index\.js$/u)
})

test('Electron owns macOS permission checks and the embedded computer driver lifecycle', async () => {
  let status = { accessibility: false, screenRecording: false }
  let created = 0
  let shutdown = 0
  let destroyed = 0
  let openedScreen = 0
  const external = []
  const driver = {
    listToolsJson: async () => '{"capability_version":"1","tools":[]}',
    callTool: async (name, raw) => ({ text: `${name}:${raw}` }),
    shutdown: async () => { shutdown += 1 },
    uniffiDestroy: () => { destroyed += 1 },
  }
  const host = new ComputerDriverHost({
    platform: 'darwin',
    loadDriver: async () => ({
      currentMacOsPermissionStatus: () => status,
      CuaDriver: { create: options => { assert.deepEqual(options, { embedded: true }); created += 1; return driver } },
    }),
    loadPermissions: async () => ({
      requestMacOSPermissions: () => status,
      openMacOSScreenRecordingSettings: async () => { openedScreen += 1 },
    }),
    openExternal: async url => { external.push(url) },
  })

  assert.deepEqual(await host.systemStatus(), status)
  await assert.rejects(host.handle('list-tools'), error => error.code === 'computer/permissions' && error.status === status)
  assert.equal(created, 0)
  assert.deepEqual(await host.handle('request-permission', { permission: 'screenRecording' }), status)
  assert.equal(openedScreen, 1)
  assert.equal(await host.handle('open-settings', { permission: 'accessibility' }), true)
  assert.match(external[0], /Privacy_Accessibility/u)

  status = { accessibility: true, screenRecording: true }
  assert.equal(await host.handle('list-tools'), '{"capability_version":"1","tools":[]}')
  assert.deepEqual(await host.handle('call-tool', { name: 'click', raw: '{"x":1}' }), { text: 'click:{"x":1}' })
  assert.equal(created, 1)
  await host.stop()
  assert.equal(shutdown, 1)
  assert.equal(destroyed, 1)
  await host.stop()
  assert.equal(shutdown, 1)
})

test('non-macOS computer permissions are already available without native permission calls', async () => {
  const host = new ComputerDriverHost({
    platform: 'linux',
    loadPermissions: async () => { throw new Error('must not load') },
    loadDriver: async () => ({ CuaDriver: { create: () => ({
      listToolsJson: async () => '{}', shutdown: async () => {}, uniffiDestroy() {},
    }) } }),
  })
  assert.deepEqual(await host.systemStatus(), { accessibility: true, screenRecording: true })
  assert.deepEqual(await host.requestPermission('accessibility'), { accessibility: true, screenRecording: true })
  assert.equal(await host.openSettings('accessibility'), false)
  await host.stop()
})

test('a restart waits for the previous embedded driver to finish stopping', async () => {
  let releaseShutdown
  const shuttingDown = new Promise(resolve => { releaseShutdown = resolve })
  let created = 0
  const drivers = []
  const host = new ComputerDriverHost({
    platform: 'linux',
    loadDriver: async () => ({ CuaDriver: { create: () => {
      const id = ++created
      const driver = {
        listToolsJson: async () => String(id),
        shutdown: async () => { if (id === 1) await shuttingDown },
        uniffiDestroy() {},
      }
      drivers.push(driver)
      return driver
    } } }),
  })
  assert.equal(await host.handle('list-tools'), '1')
  const stopping = host.stop()
  const restarting = host.handle('list-tools')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created, 1)
  releaseShutdown()
  await stopping
  assert.equal(await restarting, '2')
  assert.equal(created, 2)
  await host.stop()
})
