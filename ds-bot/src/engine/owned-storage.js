import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/
const METADATA_VERSION = 1

const bytesOf = data => {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  throw new TypeError('Attachment data must be bytes')
}

async function writeNew(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  try {
    await link(temporary, path)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export class OwnedAttachments {
  constructor(root) {
    this.root = root
  }

  #path(reference) {
    const match = ATTACHMENT_ID.exec(String(reference?.attachmentId ?? ''))
    if (match === null) throw new TypeError('Invalid attachment id')
    return join(this.root, 'v1', 'objects', match[1].slice(0, 2), match[1].slice(2))
  }

  async saveFile(input) {
    const data = bytesOf(input?.data)
    const digest = createHash('sha256').update(data).digest('hex')
    const reference = {
      attachmentId: `sha256:${digest}`,
      ...(typeof input?.name === 'string' && input.name !== '' ? { name: input.name } : {}),
      bytes: data.byteLength,
      ...(typeof input?.mediaType === 'string' && input.mediaType !== '' ? { mediaType: input.mediaType } : {}),
    }
    await writeNew(this.#path(reference), data)
    return reference
  }

  async saveImage(input) {
    const reference = await this.saveFile(input)
    return {
      ...reference,
      ...(Number.isFinite(input?.width) ? { width: Number(input.width) } : {}),
      ...(Number.isFinite(input?.height) ? { height: Number(input.height) } : {}),
    }
  }

  saveImages(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('Images must be an array')
    return Promise.all(inputs.map(input => this.saveImage(input)))
  }

  async *readFileStream(reference, signal) {
    signal?.throwIfAborted()
    const stream = createReadStream(this.#path(reference), { signal })
    for await (const chunk of stream) yield chunk
  }

  imageHostPath(reference) {
    return this.#path(reference)
  }
}

const emptyMetadata = () => ({ version: METADATA_VERSION, titles: {}, archived: [] })

function normalizeMetadata(value) {
  if (value?.version !== METADATA_VERSION || value.titles === null || typeof value.titles !== 'object' || !Array.isArray(value.archived)) {
    throw new Error('Owned session metadata is invalid')
  }
  const titles = {}
  for (const [id, title] of Object.entries(value.titles)) {
    if (typeof title === 'string') titles[String(id)] = title
  }
  return { version: METADATA_VERSION, titles, archived: [...new Set(value.archived.map(String))] }
}

async function loadMetadata(path) {
  try {
    return normalizeMetadata(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyMetadata()
    throw error
  }
}

async function saveMetadata(path, metadata) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function installOwnedStorage(context, { dataDir }) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a directory')
  const metadataPath = join(dataDir, 'owned-session-metadata.json')
  const metadata = await loadMetadata(metadataPath)
  const renameSession = context.sessionTitle.rename.bind(context.sessionTitle)
  const archiveSession = context.workspaceRegistry.archiveSession.bind(context.workspaceRegistry)
  const unarchiveSession = context.workspaceRegistry.unarchiveSession.bind(context.workspaceRegistry)

  for (const [sessionId, title] of Object.entries(metadata.titles)) await renameSession(sessionId, title)
  for (const sessionId of metadata.archived) await archiveSession(sessionId, { stopActivity: true })
  await saveMetadata(metadataPath, metadata)

  let mutations = Promise.resolve()
  const mutate = operation => {
    const run = mutations.then(operation, operation)
    mutations = run.catch(() => undefined)
    return run
  }
  context.sessionTitle.rename = (session, title) => mutate(async () => {
    await renameSession(session, title)
    metadata.titles[String(session?.id ?? session)] = String(title)
    await saveMetadata(metadataPath, metadata)
  })
  context.workspaceRegistry.archiveSession = (sessionId, options) => mutate(async () => {
    await archiveSession(sessionId, options)
    const id = String(sessionId)
    if (!metadata.archived.includes(id)) metadata.archived.push(id)
    await saveMetadata(metadataPath, metadata)
  })
  context.workspaceRegistry.unarchiveSession = sessionId => mutate(async () => {
    await unarchiveSession(sessionId)
    const id = String(sessionId)
    metadata.archived = metadata.archived.filter(value => value !== id)
    await saveMetadata(metadataPath, metadata)
  })

  context.provide('attachments', new OwnedAttachments(join(dataDir, 'attachments')))
}
