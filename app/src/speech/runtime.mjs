import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const defaultAssets = JSON.parse(readFileSync(new URL('./assets.json', import.meta.url), 'utf8'))
const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])

export class SpeechDownloadError extends Error {
  constructor(download, options) {
    super(`Unable to prepare ${download.resource} from ${download.source}: ${download.reason}${download.code ? ` (${download.code})` : ''}${download.status === undefined ? '' : ` (HTTP ${String(download.status)})`}`, options)
    this.download = download
  }
}

const codes = [
  ['dns', /^(ENOTFOUND|EAI_AGAIN)$/u],
  ['timeout', /^(ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/u],
  ['certificate', /^(CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/u],
  ['storage', /^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/u],
  ['network', /^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/u],
]

export function classifyDownloadFailure(failure) {
  const pending = [failure]
  const visited = new Set()
  let reason = 'unknown'
  while (pending.length > 0) {
    const error = pending.shift()
    if (!(error instanceof Error) || visited.has(error)) continue
    visited.add(error)
    if (error.name === 'TimeoutError') return { reason: 'timeout' }
    if (typeof error.code === 'string') for (const [kind, pattern] of codes) if (pattern.test(error.code)) return { reason: kind, code: error.code }
    if (error instanceof TypeError && error.message === 'fetch failed') reason = 'network'
    pending.push(error.cause)
    if (error instanceof AggregateError) pending.push(...error.errors)
  }
  return { reason }
}

export function runtimePaths(config, assets = defaultAssets) {
  if (!supported.has(`${process.platform}-${process.arch}`)) throw new Error(`Local speech is unavailable for ${process.platform}-${process.arch}`)
  const modelRoot = config.modelDirectory ?? join(config.dataRoot, 'models', 'sensevoice-onnx')
  return {
    assets,
    modelRoot,
    paths: {
      model: join(modelRoot, assets.models[config.precision].name),
      tokens: join(modelRoot, assets.tokens.name),
      vad: config.vadModelPath ?? join(config.dataRoot, 'models', 'silero', assets.vad.name),
      worker: config.workerPath,
    },
  }
}

export async function matchesAsset(path, asset, signal) {
  signal.throwIfAborted()
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Speech asset is not a regular file: ${path}`)
    if (info.size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return false
  }
}

async function verified(config, paths, assets, signal) {
  signal.throwIfAborted()
  try { await Promise.all([paths.model, paths.tokens, paths.vad].map(path => access(path))) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return false
  }
  const checks = [
    ...(config.modelDirectory === undefined ? [[paths.model, assets.models[config.precision]], [paths.tokens, assets.tokens]] : []),
    ...(config.vadModelPath === undefined ? [[paths.vad, assets.vad]] : []),
  ]
  for (const [path, asset] of checks) if (!await matchesAsset(path, asset, signal)) return false
  return true
}

export async function inspectRuntime(config, signal, assets = defaultAssets) {
  const resolved = runtimePaths(config, assets)
  return await verified(config, resolved.paths, assets, signal) ? resolved.paths : undefined
}

export async function orderModelSources(assetUrl, origins, timeoutMs, signal, fetchImpl = fetch) {
  signal.throwIfAborted()
  const path = new URL(assetUrl).pathname
  const urls = [...new Set(origins.map(item => new URL(path, item).href))]
  if (urls.length === 1) return urls
  const timeout = AbortSignal.timeout(timeoutMs)
  const finished = new AbortController()
  const probing = AbortSignal.any([signal, timeout, finished.signal])
  const requests = urls.map(async url => ({ url, response: await fetchImpl(url, { method: 'HEAD', signal: probing }) }))
  let preferred
  try {
    preferred = await Promise.any(requests.map(async request => {
      const value = await request
      if (!value.response.ok) throw new Error(`Model source probe returned HTTP ${String(value.response.status)}`)
      return value.url
    }))
  } catch {}
  finally {
    finished.abort()
    const settled = await Promise.allSettled(requests)
    await Promise.allSettled(settled.map(async result => { if (result.status === 'fulfilled') await result.value.response.body?.cancel() }))
  }
  signal.throwIfAborted()
  return preferred === undefined ? urls : [preferred, ...urls.filter(url => url !== preferred)]
}

export async function downloadAsset(asset, root, signal, report = () => {}, fetchImpl = fetch) {
  signal.throwIfAborted()
  const destination = join(root, asset.name)
  const partial = `${destination}.${randomUUID()}.part`
  let source = new URL(asset.url).origin
  try {
    await mkdir(root, { recursive: true })
    if (await matchesAsset(destination, asset, signal)) return destination
    await rm(destination, { force: true })
    try {
      const response = await fetchImpl(asset.url, { signal })
      source = new URL(response.url || asset.url).origin
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'http', status: response.status })
      }
      const digest = createHash('sha256')
      let completedBytes = 0
      const publish = () => report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes })
      publish()
      const hashing = new Transform({ transform(chunk, _encoding, callback) {
        completedBytes += chunk.length
        if (completedBytes > asset.bytes) { callback(new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' })); return }
        digest.update(chunk)
        publish()
        callback(null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
      if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) throw new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' })
      signal.throwIfAborted()
      await rename(partial, destination)
      return destination
    } finally { await rm(partial, { force: true }) }
  } catch (error) {
    if (signal.aborted || error instanceof SpeechDownloadError) throw error
    throw new SpeechDownloadError({ resource: asset.name, source, ...classifyDownloadFailure(error) }, { cause: error })
  }
}

export async function prepareRuntime(config, signal, report = () => {}, { assets = defaultAssets, fetchImpl = fetch } = {}) {
  const resolved = runtimePaths(config, assets)
  const download = async (asset, root, step) => {
    if (await matchesAsset(join(root, asset.name), asset, signal)) return
    const origins = config.modelOrigin === undefined ? config.modelOrigins : [config.modelOrigin]
    const urls = await orderModelSources(asset.url, origins, config.modelProbeTimeoutMs, signal, fetchImpl)
    for (const [index, url] of urls.entries()) {
      try {
        await downloadAsset({ ...asset, url }, root, signal, state => report({ ...state, step }), fetchImpl)
        return
      } catch (error) {
        if (signal.aborted || !(error instanceof SpeechDownloadError) || ['storage', 'unknown'].includes(error.download.reason) || index === urls.length - 1) throw error
      }
    }
  }
  if (config.modelDirectory === undefined) {
    report({ phase: 'checking', step: 'model', startedAt: Date.now() })
    await download(assets.models[config.precision], resolved.modelRoot, 'model')
    await download(assets.tokens, resolved.modelRoot, 'model')
  }
  if (config.vadModelPath === undefined) {
    report({ phase: 'checking', step: 'vad', startedAt: Date.now() })
    await download(assets.vad, join(config.dataRoot, 'models', 'silero'), 'vad')
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() })
  if (!await verified(config, resolved.paths, assets, signal)) throw new Error('Speech model verification failed: missing or corrupted model files')
  return resolved.paths
}
