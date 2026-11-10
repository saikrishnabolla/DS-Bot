import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRuntime } from '../index.js'
import { OwnedComputerUse, installOwnedComputerUse } from '../src/engine/owned-computer.js'
import { OwnedContext } from '../src/engine/owned-context.js'

const inventory = tools => JSON.stringify({ capability_version: '1', enforcement_adapters: [], schema_version: '1', tools })

function fakeDriver(tools, images = []) {
  const calls = []
  const state = { shutdowns: 0, destroys: 0 }
  return {
    calls,
    state,
    listToolsJson: async () => inventory(tools),
    callTool: async (name, args, options) => {
      calls.push({ name, args: JSON.parse(args), signal: options?.signal })
      return {
        text: 'Found one window.',
        images,
        structuredJson: JSON.stringify({ windows: [{ pid: 42, app_name: 'Notes' }] }),
        isError: false,
        degraded: false,
        rawJson: '{}',
      }
    },
    shutdown: async () => { state.shutdowns += 1 },
    uniffiDestroy: () => { state.destroys += 1 },
  }
}

const listWindows = {
  name: 'list_windows',
  description: 'List windows',
  inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { windows: { type: 'array' } }, required: ['windows'], additionalProperties: true },
}

test('owned computer use derives tools from the live Cua Driver inventory', async () => {
  const driver = fakeDriver([listWindows], [{ dataBase64: 'aW1hZ2U=', mimeType: 'image/png' }])
  const saved = []
  const attachments = { saveImage: async input => {
    saved.push(input)
    return { attachmentId: 'sha256:image', mediaType: input.mediaType, bytes: input.data.length }
  } }
  const service = new OwnedComputerUse({ driverFactory: async () => driver, attachments })
  const [definition] = await service.start()

  assert.equal(definition.name, 'cua_driver_native__list_windows')
  assert.deepEqual(definition.parameters, listWindows.inputSchema)
  assert.deepEqual(definition.structuredOutputSchema, listWindows.outputSchema)
  const abort = new AbortController()
  const result = await definition.execute({ session: 'writer' }, { signal: abort.signal })
  assert.deepEqual(driver.calls, [{ name: 'list_windows', args: { session: 'writer' }, signal: abort.signal }])
  assert.equal(result.output[0].text, 'Found one window.')
  assert.deepEqual(result.output[1], { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' })
  assert.deepEqual(result.content, [{ type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 5 } }])
  assert.deepEqual(saved, [{ data: Buffer.from('image'), mediaType: 'image/png' }])
  assert.deepEqual(result.structuredOutput, { windows: [{ pid: 42, app_name: 'Notes' }] })
  assert.deepEqual(result.structuredContent, result.structuredOutput)

  assert.strictEqual(await service.start(), await service.start())
  await service.stop()
  await service.stop()
  assert.deepEqual(driver.state, { shutdowns: 1, destroys: 1 })
})

test('owned computer use rejects malformed capability documents and closes the driver', async () => {
  const driver = fakeDriver([])
  driver.listToolsJson = async () => JSON.stringify({ capability_version: '2', tools: [] })
  const service = new OwnedComputerUse({ driverFactory: async () => driver })
  await assert.rejects(service.start(), /unsupported tool inventory/)
  assert.deepEqual(driver.state, { shutdowns: 1, destroys: 1 })
})

test('owned runtime scopes Cua Driver tools to Bots only while computer use is on', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-computer-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()
  models.setProvider(fakeProvider())
  const context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  t.after(() => context.close())
  const driver = fakeDriver([listWindows])
  installOwnedComputerUse(context, { driverFactory: async () => driver })
  const runtime = createRuntime(context, { home: join(dataDir, 'bot'), github: false, diagnosticsFile: false, browser: false })
  await runtime.bootstrap()
  const bot = Object.values(runtime.state.bots)[0]
  const sessionId = runtime.chatOf(bot.id)
  const plainId = (await context.sessionController.create()).sessionId
  const plain = (await context.sessionController.resolveAgent(plainId)).agent
  const agent = (await context.sessionController.resolveAgent(sessionId)).agent

  assert.equal(context.tools.schemas(agent).some(tool => tool.name === 'cua_driver_native__list_windows'), false)
  await runtime.computerEndpoint('set-enabled', { enabled: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.computerStatus().state, 'ready')
  assert.equal(context.tools.schemas(agent).some(tool => tool.name === 'cua_driver_native__list_windows'), true)
  assert.equal(context.tools.schemas(plain).some(tool => tool.name === 'cua_driver_native__list_windows'), false)

  await runtime.computerEndpoint('set-enabled', { enabled: false })
  assert.equal(context.tools.schemas(agent).some(tool => tool.name === 'cua_driver_native__list_windows'), false)
  assert.equal(driver.state.shutdowns, 1)
})

function fakeProvider() {
  return fauxProvider().provider
}
