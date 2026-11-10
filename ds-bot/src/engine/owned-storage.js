import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i
const METADATA_VERSION = 1
const MAX_NAME_LENGTH = 255

const bytesOf = data => {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  throw new TypeError('Attachment data must be bytes')
}

const nameOf = value => {
  if (typeof value !== 'string') return undefined
  const clean = [...basename(value.replaceAll('\\', '/'))].filter(character => character >= ' ' && character !== '\u007f').join('').trim().slice(0, MAX_NAME_LENGTH)
  return clean === '' ? undefined : clean
}

const mediaTypeOf = value => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !MEDIA_TYPE.test(value)) throw new TypeError('Invalid attachment media type')
  return value.toLowerCase()
}

const imageTypeOf = data => {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

async function writeNew(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  try {
    await link(temporary, path)
    await chmod(path, 0o400)
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
    const name = nameOf(input?.name)
    const mediaType = mediaTypeOf(input?.mediaType)
    const reference = {
      attachmentId: `sha256:${digest}`,
      ...(name === undefined ? {} : { name }),
      bytes: data.byteLength,
      ...(mediaType === undefined ? {} : { mediaType }),
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
    const checked = await this.reference(reference)
    const stream = createReadStream(this.#path(checked), { signal })
    for await (const chunk of stream) yield chunk
  }

  imageHostPath(reference) {
    return this.#path(reference)
  }

  hostPath(reference) {
    return this.#path(reference)
  }

  async reference(reference) {
    const path = this.#path(reference)
    const info = await stat(path)
    if (!info.isFile()) throw new TypeError('Attachment is not a file')
    const declaredBytes = reference?.bytes
    if (declaredBytes !== undefined && (!Number.isSafeInteger(Number(declaredBytes)) || Number(declaredBytes) < 0 || Number(declaredBytes) !== info.size)) {
      throw new TypeError('Invalid attachment byte count')
    }
    const bytes = info.size
    const name = nameOf(reference?.name)
    if (reference?.name !== undefined && name !== reference.name) throw new TypeError('Invalid attachment name')
    const mediaType = mediaTypeOf(reference?.mediaType)
    return {
      attachmentId: reference.attachmentId,
      ...(name === undefined ? {} : { name }),
      bytes,
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(Number.isFinite(reference?.width) && Number(reference.width) > 0 ? { width: Number(reference.width) } : {}),
      ...(Number.isFinite(reference?.height) && Number(reference.height) > 0 ? { height: Number(reference.height) } : {}),
    }
  }

  async imageReference(reference) {
    const checked = await this.reference(reference)
    const mediaType = imageTypeOf(await readFile(this.#path(checked)))
    if (mediaType === undefined || mediaType !== checked.mediaType) throw new TypeError('Attachment is not a supported image')
    return checked
  }

  async load(reference) {
    const checked = await this.reference(reference)
    const data = await readFile(this.#path(checked))
    return { data, mediaType: imageTypeOf(data) ?? 'application/octet-stream' }
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

  const attachments = new OwnedAttachments(join(dataDir, 'attachments'))
  context.provide('attachments', attachments)
  context.provide('fileUploads', {
    async uploadStream({ data, name, mediaType }, signal) {
      const chunks = []
      let bytes = 0
      for await (const chunk of data) {
        signal?.throwIfAborted()
        const value = bytesOf(chunk)
        bytes += value.byteLength
        if (bytes > 32 * 1024 * 1024) throw new Error('Attachment exceeds the 32 MB limit')
        chunks.push(value)
      }
      return { receiptId: await attachments.saveFile({ data: Buffer.concat(chunks), name, mediaType }) }
    },
  })
}
