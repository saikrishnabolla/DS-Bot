import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib'

const RECORD_VERSION = 1
const SESSION_FILE = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.(zstd|zst|gz|br))?$/u
const NUMERIC_ID = /^[1-9]\d*$/u
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/u
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

async function attachmentImage(dataDir, reference) {
  const match = ATTACHMENT_ID.exec(String(reference?.attachmentId ?? ''))
  if (match === null || typeof reference?.mediaType !== 'string' || !reference.mediaType.startsWith('image/')) {
    throw new Error('Cannot import malformed image attachment')
  }
  const digest = match[1]
  const paths = [
    join(dataDir, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest),
    join(dataDir, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest.slice(2)),
  ]
  const path = paths.find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error(`Cannot import missing image attachment ${reference.attachmentId}`)
  const data = await readFile(path)
  if (Number.isSafeInteger(reference.bytes) && reference.bytes !== data.byteLength) throw new Error(`Cannot import damaged image attachment ${reference.attachmentId}`)
  return { type: 'image', data: data.toString('base64'), mimeType: reference.mediaType }
}

async function contentOf(content, role, dataDir) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return []
  const result = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      result.push({ type: 'text', text: block.text })
      continue
    }
    if (role === 'assistant' && (block?.type === 'thinking' || block?.type === 'reasoning')) {
      const thinking = typeof block.thinking === 'string' ? block.thinking : block.text
      if (typeof thinking === 'string') result.push({ type: 'thinking', thinking, ...(block.redacted === true ? { redacted: true } : {}) })
      continue
    }
    if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      result.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      continue
    }
    if (block?.type === 'image' && block.attachment && typeof block.attachment === 'object') {
      result.push(await attachmentImage(dataDir, block.attachment))
      continue
    }
    if (role === 'assistant' && (block?.type === 'toolCall' || block?.type === 'tool-call') && typeof block.name === 'string') {
      let argumentsValue = block.arguments ?? {}
      if (typeof argumentsValue === 'string') {
        try { argumentsValue = JSON.parse(argumentsValue) } catch { throw new Error('Cannot import malformed tool-call arguments') }
      }
      if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) throw new Error('Cannot import malformed tool-call arguments')
      result.push({
        type: 'toolCall',
        id: String(block.id ?? ''),
        name: block.name,
        arguments: argumentsValue,
        ...(typeof block.namespace === 'string' ? { namespace: block.namespace } : {}),
      })
    }
  }
  return result
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

async function userMessage(value, time, dataDir) {
  if (value?.role !== 'user') return undefined
  const message = {
    role: 'user',
    content: await contentOf(value.content, 'user', dataDir),
    timestamp: Number.isFinite(value.timestamp) ? value.timestamp : time,
    ...(value.source && typeof value.source === 'object' ? { source: structuredClone(value.source) } : {}),
  }
  return {
    message,
    data: {
      ...(value.source && typeof value.source === 'object' ? { source: structuredClone(value.source) } : {}),
      ...(value.requestId === undefined ? {} : { requestId: String(value.requestId) }),
      ...(Array.isArray(value.references) ? { references: structuredClone(value.references) } : {}),
    },
  }
}

async function assistantMessage(value, time, dataDir) {
  if (value?.role !== 'assistant') return undefined
  return { message: {
    role: 'assistant',
    content: await contentOf(value.content, 'assistant', dataDir),
    api: typeof value.api === 'string' && value.api !== '' ? value.api : 'legacy',
    provider: typeof value.provider === 'string' && value.provider !== '' ? value.provider : 'legacy',
    model: typeof value.model === 'string' && value.model !== '' ? value.model : 'legacy',
    usage: value.usage && typeof value.usage === 'object' ? usageOf(value.usage) : ZERO_USAGE,
    stopReason: STOP_REASONS.has(value.stopReason) ? value.stopReason : 'stop',
    timestamp: Number.isFinite(value.timestamp) ? value.timestamp : time,
    ...(typeof value.errorMessage === 'string' ? { errorMessage: value.errorMessage } : {}),
  } }
}

async function toolResultMessage(value, time, dataDir) {
  if (value?.role === 'user' && value.source?.kind === 'tool' && Array.isArray(value.content) && value.content.length === 1 && value.content[0]?.type === 'tool-result') {
    const wrapper = value.content[0]
    value = {
      role: 'tool',
      source: value.source,
      toolCallId: wrapper.toolCallId,
      content: wrapper.content,
      isError: wrapper.isError,
      timestamp: value.timestamp,
    }
  }
  if (value?.role !== 'tool' && value?.role !== 'toolResult') return undefined
  return {
    message: {
      role: 'toolResult',
      toolCallId: String(value.toolCallId ?? value.source?.callId ?? value.callId ?? ''),
      toolName: typeof value.toolName === 'string' ? value.toolName : typeof value.name === 'string' ? value.name : '',
      content: await contentOf(value.content, 'toolResult', dataDir),
      isError: value.isError === true,
      timestamp: Number.isFinite(value.timestamp) ? value.timestamp : time,
      ...(value.details === undefined ? {} : { details: structuredClone(value.details) }),
    },
    data: { diagnostics: Array.isArray(value.diagnostics) ? structuredClone(value.diagnostics) : [] },
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
  const entries = []
  const pendingToolCalls = new Map()
  for (const event of rows) {
    const entry = event?.type === 'user/message'
      ? await userMessage(event.data, event.time, dataDir)
      : event?.type === 'assistant/message'
        ? await assistantMessage(event.data?.message, event.time, dataDir)
        : event?.type === 'tool/result'
          ? await toolResultMessage(event.data?.message, event.time, dataDir)
          : undefined
    if (entry === undefined) continue
    if (entry.message.role === 'assistant') {
      const messageCalls = new Set()
      for (const block of entry.message.content) {
        if (block?.type !== 'toolCall') continue
        if (block.id === '' || block.name === '' || messageCalls.has(block.id) || pendingToolCalls.has(block.id)) throw new Error(`Cannot import malformed tool call in Session ${id}`)
        messageCalls.add(block.id)
        pendingToolCalls.set(block.id, block.name)
      }
    } else if (entry.message.role === 'toolResult') {
      const callId = entry.message.toolCallId
      const toolName = pendingToolCalls.get(callId)
      if (callId === '' || toolName === undefined) throw new Error(`Cannot import malformed tool result in Session ${id}`)
      entry.message.toolName = toolName
      pendingToolCalls.delete(callId)
    }
    entries.push(entry)
  }
  return {
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    entries,
    messages: entries.map(entry => entry.message),
  }
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
    for (const part of room.parts ?? []) add(part?.sessionId)
    for (const value of Object.values(room.sessions ?? {})) add(value)
    for (const segment of Object.values(room.segments ?? {}).flat()) add(segment?.sessionId)
  }
  return ids
}

function rewriteState(state, sessions) {
  const mapped = value => sessions[value] ?? value
  const mappedModel = value => typeof value === 'string' && value.startsWith('deepseek-official/') ? `deepseek/${value.slice('deepseek-official/'.length)}` : value
  for (const bot of Object.values(state.bots ?? {})) {
    bot.sessionId = mapped(bot.sessionId ?? bot.id)
    for (const key of ['model', 'appliedModel']) if (bot[key] !== undefined) bot[key] = mappedModel(bot[key])
    for (const segment of bot.segments ?? []) segment.sessionId = mapped(segment.sessionId)
  }
  for (const room of Object.values(state.rooms ?? {})) {
    room.sessionId = mapped(room.sessionId ?? room.id)
    for (const part of room.parts ?? []) part.sessionId = mapped(part.sessionId)
    for (const botId of Object.keys(room.sessions ?? {})) room.sessions[botId] = mapped(room.sessions[botId])
    for (const segment of Object.values(room.segments ?? {}).flat()) segment.sessionId = mapped(segment.sessionId)
  }
  if (state.switching && typeof state.switching === 'object' && !Array.isArray(state.switching)) {
    state.switching = Object.fromEntries(Object.entries(state.switching).map(([id, value]) => [mapped(id), value]))
  }
  if (state.prefs?.defaultBotModel !== undefined) state.prefs.defaultBotModel = mappedModel(state.prefs.defaultBotModel)
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
  const conversations = []
  for (const id of ids) {
    if (record.sessions[id] !== undefined && !NUMERIC_ID.test(record.sessions[id])) throw new Error(`Invalid Pi import mapping for ${id}`)
    conversations.push({ ...(await readLegacyConversation(dataDir, id)), legacyId: id, existingId: record.sessions[id] })
  }
  const imported = await harness.importConversations(conversations)
  for (const id of ids) record.sessions[id] = imported[id]
  record.complete = false
  await replaceJson(recordPath, record)
  rewriteState(state, record.sessions)
  await replaceJson(statePath, state)
  record.complete = true
  await replaceJson(recordPath, record)
  return { imported: ids.length, sessions: { ...record.sessions } }
}
