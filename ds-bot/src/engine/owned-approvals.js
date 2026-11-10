import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const VERSION = 1

function entryOf(value) {
  if (typeof value?.id !== 'string' || value.id === '' || typeof value.sessionId !== 'string' || value.sessionId === '' || typeof value.botId !== 'string' || value.botId === '') {
    throw new Error('Owned approval journal is invalid')
  }
  if (typeof value.tool !== 'string' || typeof value.reason !== 'string' || !Number.isFinite(value.at)) throw new Error('Owned approval journal is invalid')
  const detail = value.detail ?? {}
  if (detail === null || typeof detail !== 'object') throw new Error('Owned approval journal is invalid')
  return {
    id: value.id,
    sessionId: value.sessionId,
    botId: value.botId,
    ...(typeof value.roomId === 'string' ? { roomId: value.roomId } : {}),
    tool: value.tool,
    reason: value.reason,
    detail: {
      ...(typeof detail.text === 'string' ? { text: detail.text } : {}),
      ...(typeof detail.code === 'string' ? { code: detail.code } : {}),
    },
    at: value.at,
  }
}

function recordOf(value) {
  if (typeof value?.key !== 'string' || !['pending', 'settled'].includes(value.state)) throw new Error('Owned approval journal is invalid')
  const record = { key: value.key, state: value.state, entry: entryOf(value.entry) }
  if (value.state === 'settled') {
    if (typeof value.outcome !== 'string' || !Number.isFinite(value.settledAt)) throw new Error('Owned approval journal is invalid')
    record.outcome = value.outcome
    record.settledAt = value.settledAt
  }
  return record
}

function load(path) {
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  if (parsed?.version !== VERSION || !Array.isArray(parsed.records)) throw new Error('Owned approval journal is invalid')
  return parsed.records.map(recordOf)
}

function syncDirectory(path) {
  let descriptor
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM'].includes(error?.code)) throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function save(path, records) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify({ version: VERSION, records })}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    syncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') throw cleanupError }
    throw error
  }
}

const keyOf = ({ sessionId, callId, tool }) => sessionId === undefined || callId === undefined
  ? undefined
  : JSON.stringify([String(sessionId), String(callId), String(tool ?? '')])

export function installOwnedApprovals(context, { dataDir }) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a directory')
  const path = join(dataDir, 'owned-approvals.json')
  const records = load(path)
  const byKey = new Map(records.map(record => [record.key, record]))
  const byId = new Map(records.map(record => [record.entry.id, record]))

  const persist = () => save(path, [...byKey.values()])
  const copy = record => record === undefined ? undefined : structuredClone(record)
  const service = {
    pending: () => [...byKey.values()].filter(record => record.state === 'pending').map(copy),
    open(identity, entry) {
      const key = keyOf(identity)
      if (key === undefined) return undefined
      const found = byKey.get(key)
      if (found !== undefined) return copy(found)
      if (entry === undefined) return undefined
      const record = { key, state: 'pending', entry: entryOf(entry) }
      byKey.set(key, record)
      byId.set(record.entry.id, record)
      try { persist() } catch (error) {
        byKey.delete(key)
        byId.delete(record.entry.id)
        throw error
      }
      return copy(record)
    },
    settle(id, outcome) {
      const record = byId.get(String(id))
      if (record?.state !== 'pending') return false
      const previous = { ...record }
      record.state = 'settled'
      record.outcome = String(outcome)
      record.settledAt = Date.now()
      try { persist() } catch (error) {
        Object.assign(record, previous)
        delete record.outcome
        delete record.settledAt
        throw error
      }
      return true
    },
  }
  context.provide('approvalDurability', service)
  return service
}
