import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib'

const RECORD_VERSION = 1
const SESSION_FILE = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.(zstd|zst|gz|br))?$/u
const NUMERIC_ID = /^[1-9]\d*$/u
const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted'])
const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

async function replaceJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function contentOf(content, role) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (role === 'assistant' && (block?.type === 'thinking' || block?.type === 'reasoning')) {
      const thinking = typeof block.thinking === 'string' ? block.thinking : block.text
      return typeof thinking === 'string' ? [{ type: 'thinking', thinking, ...(block.redacted === true ? { redacted: true } : {}) }] : []
    }
    if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
    }
    return []
  })
}

function usageOf(value) {
  const number = (key, parent = value) => Number.isFinite(parent?.[key]) ? parent[key] : 0
  const cost = value?.cost
  return {
    input: number('input'),
    output: number('output'),
    cacheRead: number('cacheRead'),
    cacheWrite: number('cacheWrite'),
    totalTokens: number('totalTokens'),
    cost: {
      input: number('input', cost),
      output: number('output', cost),
      cacheRead: number('cacheRead', cost),
      cacheWrite: number('cacheWrite', cost),
      total: number('total', cost),
    },
    ...(Number.isFinite(value?.cacheWrite1h) ? { cacheWrite1h: value.cacheWrite1h } : {}),
    ...(Number.isFinite(value?.reasoning) ? { reasoning: value.reasoning } : {}),
  }
}

function userMessage(value, time) {
  if (value?.role !== 'user') return undefined
  return {
    role: 'user',
    content: contentOf(value.content, 'user'),
    timestamp: Number.isFinite(value.timestamp) ? value.timestamp : time,
  }
}

function assistantMessage(value, time) {
  if (value?.role !== 'assistant') return undefined
  return {
    role: 'assistant',
    content: contentOf(value.content, 'assistant'),
    api: typeof value.api === 'string' && value.api !== '' ? value.api : 'legacy',
    provider: typeof value.provider === 'string' && value.provider !== '' ? value.provider : 'legacy',
    model: typeof value.model === 'string' && value.model !== '' ? value.model : 'legacy',
    usage: value.usage && typeof value.usage === 'object' ? usageOf(value.usage) : ZERO_USAGE,
    stopReason: STOP_REASONS.has(value.stopReason) ? value.stopReason : 'stop',
    timestamp: Number.isFinite(value.timestamp) ? value.timestamp : time,
    ...(typeof value.errorMessage === 'string' ? { errorMessage: value.errorMessage } : {}),
  }
}

function decoded(file, bytes) {
  if (file.endsWith('.zstd') || file.endsWith('.zst')) return zstdDecompressSync(bytes)
  if (file.endsWith('.gz')) return gunzipSync(bytes)
  if (file.endsWith('.br')) return brotliDecompressSync(bytes)
  return bytes
}

async function sessionDirectory(dataDir, id) {
  const root = join(dataDir, 'sessions')
  for (const group of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!group.isDirectory()) continue
    const candidate = join(root, group.name, id)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function readLegacyConversation(dataDir, id) {
  const directory = await sessionDirectory(dataDir, id)
  if (directory === undefined) return { messages: [] }
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && SESSION_FILE.test(entry.name))
    .map(entry => ({ name: entry.name, version: Number(SESSION_FILE.exec(entry.name)?.[1] ?? 0) }))
    .sort((left, right) => right.version - left.version || right.name.localeCompare(left.name))
  const file = files[0]?.name
  if (file === undefined) return { messages: [] }
  const lines = decoded(file, await readFile(join(directory, file))).toString('utf8').split('\n').filter(line => line.trim() !== '')
  const rows = lines.map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`Cannot read ${basename(directory)}/${file} row ${String(index + 1)}: ${error.message}`) }
  })
  const header = rows.shift()
  if (header?.id !== id || !Number.isSafeInteger(header?.version) || header.version < 0 || header.version > 4) {
    throw new Error(`Cannot import unsupported Session ${id}`)
  }
  const messages = []
  for (const event of rows) {
    const message = event?.type === 'user/message'
      ? userMessage(event.data, event.time)
      : event?.type === 'assistant/message'
        ? assistantMessage(event.data?.message, event.time)
        : undefined
    if (message !== undefined) messages.push(message)
  }
  return { cwd: typeof header.cwd === 'string' ? header.cwd : undefined, messages }
}

function legacySessionIds(state) {
  const ids = []
  const add = value => { if (typeof value === 'string' && value !== '' && !NUMERIC_ID.test(value) && !ids.includes(value)) ids.push(value) }
  for (const bot of Object.values(state.bots ?? {})) {
    add(bot.sessionId ?? bot.id)
    for (const segment of bot.segments ?? []) add(segment?.sessionId)
  }
  for (const room of Object.values(state.rooms ?? {})) {
    add(room.sessionId ?? room.id)
    for (const value of Object.values(room.sessions ?? {})) add(value)
    for (const segment of Object.values(room.segments ?? {}).flat()) add(segment?.sessionId)
  }
  return ids
}

function rewriteState(state, sessions) {
  const mapped = value => sessions[value] ?? value
  for (const bot of Object.values(state.bots ?? {})) {
    bot.sessionId = mapped(bot.sessionId ?? bot.id)
    for (const segment of bot.segments ?? []) segment.sessionId = mapped(segment.sessionId)
  }
  for (const room of Object.values(state.rooms ?? {})) {
    room.sessionId = mapped(room.sessionId ?? room.id)
    for (const botId of Object.keys(room.sessions ?? {})) room.sessions[botId] = mapped(room.sessions[botId])
    for (const segment of Object.values(room.segments ?? {}).flat()) segment.sessionId = mapped(segment.sessionId)
  }
  if (state.switching && typeof state.switching === 'object' && !Array.isArray(state.switching)) {
    state.switching = Object.fromEntries(Object.entries(state.switching).map(([id, value]) => [mapped(id), value]))
  }
  const walk = (value, key) => {
    if (typeof value === 'string') return /sessionId$/iu.test(key) ? mapped(value) : value
    if (Array.isArray(value)) return value.map(entry => walk(entry, key))
    if (value === null || typeof value !== 'object') return value
    for (const [childKey, child] of Object.entries(value)) value[childKey] = walk(child, childKey)
    return value
  }
  return walk(state, '')
}

export async function migrateLegacyTeam({ dataDir, harness }) {
  const statePath = join(dataDir, 'bot', 'state.json')
  if (!existsSync(statePath)) return { imported: 0 }
  const state = await readJson(statePath)
  const ids = legacySessionIds(state)
  if (ids.length === 0) return { imported: 0 }
  const recordPath = join(dataDir, 'bot', 'pi-import.json')
  const record = existsSync(recordPath) ? await readJson(recordPath) : { version: RECORD_VERSION, complete: false, sessions: {} }
  if (record.version !== RECORD_VERSION || record.sessions === null || typeof record.sessions !== 'object') {
    throw new Error('Unsupported Pi import record')
  }
  for (const id of ids) {
    if (NUMERIC_ID.test(record.sessions[id] ?? '')) continue
    const conversation = await readLegacyConversation(dataDir, id)
    record.sessions[id] = await harness.importConversation(conversation)
    await replaceJson(recordPath, record)
  }
  rewriteState(state, record.sessions)
  await replaceJson(statePath, state)
  record.complete = true
  await replaceJson(recordPath, record)
  return { imported: ids.length, sessions: { ...record.sessions } }
}
