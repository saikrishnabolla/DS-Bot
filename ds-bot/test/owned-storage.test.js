import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { OwnedContext } from '../src/engine/owned-context.js'
import { installOwnedStorage } from '../src/engine/owned-storage.js'

const readAll = async (attachments, reference) => {
  const chunks = []
  for await (const chunk of attachments.readFileStream(reference)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('owned attachments persist files and images by content without trusting names', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-storage-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()

  let context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  await installOwnedStorage(context, { dataDir })
  const attachments = context.get('attachments')
  const secret = Buffer.from('private attachment body')
  const file = await attachments.saveFile({ data: secret, name: '../../private.txt' })
  const [image] = await attachments.saveImages([{
    data: Buffer.from('image bytes'),
    mediaType: 'image/png',
    name: '../screenshot.png',
    width: 320,
    height: 200,
  }])

  assert.match(file.attachmentId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(file.name, 'private.txt')
  assert.equal(file.bytes, secret.length)
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.width, 320)
  assert.equal(image.height, 200)
  assert.deepEqual(await readAll(attachments, file), secret)
  assert.deepEqual(await readAll(attachments, { attachmentId: file.attachmentId }), secret)
  const imagePath = attachments.imageHostPath(image)
  assert.equal(relative(join(dataDir, 'attachments'), imagePath).startsWith('..'), false)
  assert.deepEqual(await readFile(imagePath), Buffer.from('image bytes'))
  await assert.rejects(readAll(attachments, { attachmentId: '../../etc/passwd' }), /attachment/i)
  assert.throws(() => attachments.imageHostPath({ attachmentId: 'sha256:bad' }), /attachment/i)
  await context.close()

  context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  await installOwnedStorage(context, { dataDir })
  t.after(() => context.close())
  assert.deepEqual(await readAll(context.get('attachments'), file), secret)
  const metadata = await readFile(join(dataDir, 'owned-session-metadata.json'), 'utf8')
  assert.doesNotMatch(metadata, /private attachment body/)
})

test('owned session titles and archives survive a full context restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-bot-owned-metadata-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const models = createModels()

  let context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  await installOwnedStorage(context, { dataDir })
  const { sessionId } = await context.sessionController.create()
  await context.sessionTitle.rename(sessionId, 'Research Bot')
  await context.workspaceRegistry.archiveSession(sessionId)
  assert.equal((await context.sessionController.list({})).items.some(item => item.sessionId === sessionId), false)
  await context.close()

  context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  await installOwnedStorage(context, { dataDir })
  assert.equal((await context.sessionController.list({})).items.some(item => item.sessionId === sessionId), false)
  await context.workspaceRegistry.unarchiveSession(sessionId)
  assert.deepEqual(
    (await context.sessionController.list({})).items.find(item => item.sessionId === sessionId),
    { sessionId, title: 'Research Bot', origin: 'session', projections: { kind: 'sequenced', asOfSeq: -1, values: {} } },
  )
  await context.close()

  context = await OwnedContext.open({ dataDir, models, workspacePath: dataDir })
  await installOwnedStorage(context, { dataDir })
  t.after(() => context.close())
  assert.equal((await context.sessionController.list({})).items.find(item => item.sessionId === sessionId)?.title, 'Research Bot')
})
