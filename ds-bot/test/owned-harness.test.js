import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { OwnedHarness } from '../src/engine/owned-harness.js'

test('owned harness keeps conversations and request ids across restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-pi-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const provider = fauxProvider()
  provider.setResponses([fauxAssistantMessage('durable answer')])
  const models = createModels()
  models.setProvider(provider.provider)

  const first = await OwnedHarness.open({ dataDir, models })
  const id = await first.createConversation({ model: { provider: 'faux', modelId: 'faux-1' } })
  const watch = await first.watch(id)
  let updates = 0
  watch.start(async call => { if (call.kind === 'value') updates += 1 })
  first.resume()

  const submission = await first.submit(id, { content: 'hello', requestId: 'message-1' })
  const settled = await submission.wait()
  assert.equal(settled.status, 'done')
  assert.equal(settled.type, 'input')
  assert.ok(updates > 0)
  await watch.stop()
  await first.close()

  const second = await OwnedHarness.open({ dataDir, models })
  second.resume()
  const replay = await second.submit(id, { content: 'hello', requestId: 'message-1' })
  assert.equal(replay.id, submission.id)
  const page = await second.entries(id)
  assert.deepEqual(page.items.map(entry => entry.kind), ['pi.user', 'pi.assistant'])
  await second.close()
})
