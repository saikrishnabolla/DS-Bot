import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerDriverHost } from '../src/computer-driver.mjs'
import { ComputerRemote, sendComputerResponse } from '../src/computer-remote.mjs'

test('a computer response is dropped when its Host IPC channel has closed', () => {
  const error = new Error('The DS Bot Host IPC channel is closed')
  assert.equal(sendComputerResponse({ send: () => { throw error } }, { type: 'ds-bot:computer-response', id: 'closed' }), false)
  assert.equal(sendComputerResponse({ send: () => {} }, { type: 'ds-bot:computer-response', id: 'open' }), true)
})

test('host IPC cancellation aborts an in-flight native computer action', async () => {
  const controllers = new Map()
  let remote
  let nativeAborted = false
  const driver = {
    listToolsJson: async () => '{}',
    callTool: async (_name, _raw, { signal }) => await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { nativeAborted = true; reject(signal.reason) }, { once: true })
    }),
    shutdown: async () => {},
    uniffiDestroy() {},
  }
  const host = new ComputerDriverHost({ platform: 'linux', loadDriver: async () => ({ CuaDriver: { create: () => driver } }) })
  const send = async message => {
    if (message.type === 'ds-bot:computer-cancel') {
      controllers.get(message.id)?.abort(new Error('stopped'))
      return
    }
    if (message.type !== 'ds-bot:computer-request') return
    const controller = new AbortController()
    controllers.set(message.id, controller)
    void host.handle(message.action, message.payload, { signal: controller.signal }).then(value => {
      remote.accept({ type: 'ds-bot:computer-response', id: message.id, value })
    }).catch(error => {
      remote.accept({ type: 'ds-bot:computer-response', id: message.id, error: { message: error.message } })
    }).finally(() => controllers.delete(message.id))
  }
  remote = new ComputerRemote(send)
  const controller = new AbortController()
  const pending = remote.request('call-tool', { name: 'click', raw: '{}' }, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('stopped'))
  await assert.rejects(pending, /stopped/u)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nativeAborted, true)
  assert.equal(controllers.size, 0)
  await host.stop()
})
