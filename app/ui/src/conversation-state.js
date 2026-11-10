import { requestPreparation } from '../../../ds-bot/src/client/speech.js'

const EMPTY_FACTS = { turns: undefined, openTurn: undefined }
const finite = value => (Number.isFinite(Number(value)) ? Number(value) : undefined)
const turnOf = item => (Number.isInteger(item?.turn) ? item.turn : undefined)
const itemKey = item => item?.entryId !== undefined
  ? `${item.entryId}:${item.block ?? ''}`
  : JSON.stringify([item?.kind, item?.seq, item?.time, item?.text, item?.botId])
const itemSignature = item => JSON.stringify([itemKey(item), item?.turn, item?.seq, item?.time, item?.text])
const messageKey = item => item?.entryId !== undefined ? `entry:${item.entryId}`
  : finite(item?.seq) !== undefined ? `seq:${finite(item.seq)}`
    : finite(item?.time) !== undefined ? `time:${finite(item.time)}` : item

function unique(items) {
  const keys = new Set()
  return (Array.isArray(items) ? items : []).filter((item) => {
    const key = itemKey(item)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

function snapshot(items, running, since) {
  const grouped = new Map()
  for (const item of items) {
    const turn = turnOf(item)
    if (turn === undefined) continue
    const rows = grouped.get(turn) ?? []
    rows.push(item)
    grouped.set(turn, rows)
  }
  const ordered = [...grouped.keys()].sort((a, b) => a - b)
  const latest = ordered.at(-1)
  const latestRows = latest === undefined ? [] : grouped.get(latest)
  const latestTime = Math.max(-Infinity, ...latestRows.map(item => finite(item?.time) ?? -Infinity))
  // A fresh run can begin before its first projected row arrives. In that gap the
  // previous turn stays closed; the host's start time distinguishes the two runs.
  const open = running && latest !== undefined && (since === undefined || latestTime >= since) ? latest : undefined
  const turns = new Map()
  const replies = new Map()
  for (const turn of ordered) {
    const rows = grouped.get(turn)
    const times = rows.map(item => finite(item?.time)).filter(value => value !== undefined)
    const seqs = rows.map(item => finite(item?.seq ?? item?.atSeq)).filter(value => value !== undefined)
    const firstTime = times.length > 0 ? Math.min(...times) : undefined
    const lastTime = times.length > 0 ? Math.max(...times) : undefined
    const lastSeq = seqs.length > 0 ? Math.max(...seqs) : turn
    const location = {
      kind: 'turn',
      turn,
      start: { seq: turn, ...(firstTime === undefined ? {} : { time: firstTime }) },
      ...(turn === open ? { status: 'open' } : {
        end: { seq: lastSeq, ...(lastTime === undefined ? {} : { time: lastTime }) },
        status: 'closed',
      }),
    }
    turns.set(turn, location)
    if (turn !== open) {
      const bots = rows.filter(item => item?.kind === 'bot')
      const closing = bots.length === 0 ? undefined : messageKey(bots.at(-1))
      const texts = bots
        .filter(item => messageKey(item) === closing && typeof item.text === 'string' && item.text.trim() !== '')
        .map(item => item.text)
      replies.set(turn, texts.join('\n\n'))
    }
  }
  return {
    facts: { turns, openTurn: open === undefined ? undefined : { seq: open } },
    replies,
  }
}

export function createConversationState() {
  const conversations = new Map()
  const listeners = new Map()
  const watchers = sessionId => {
    let own = listeners.get(sessionId)
    if (own === undefined) {
      own = new Set()
      listeners.set(sessionId, own)
    }
    return own
  }
  const publish = (sessionId, entry) => {
    const projected = snapshot(entry.items, entry.running, entry.since)
    conversations.set(sessionId, { ...entry, ...projected })
    for (const listener of [...(listeners.get(sessionId) ?? [])]) listener()
  }
  const current = sessionId => conversations.get(sessionId)
  return {
    noteChat(sessionId, items, running = false, since) {
      if (!sessionId) return
      const next = unique(items)
      const before = current(sessionId)
      const sameItems = before?.items.length === next.length
        && before.items.every((item, index) => itemSignature(item) === itemSignature(next[index]))
      if (sameItems && before.running === running && before.since === since) return
      publish(sessionId, { items: next, running, since })
    },
    noteMessage(sessionId, item) {
      if (!sessionId || !item) return
      const before = current(sessionId) ?? { items: [], running: false, since: undefined }
      const key = itemKey(item)
      const at = before.items.findIndex(entry => itemKey(entry) === key)
      if (at < 0) {
        publish(sessionId, { ...before, items: [...before.items, item] })
        return
      }
      if (itemSignature(before.items[at]) === itemSignature(item)) return
      publish(sessionId, {
        ...before,
        items: [...before.items.slice(0, at), item, ...before.items.slice(at + 1)],
      })
    },
    setRunning(sessionId, running, since) {
      if (!sessionId) return
      const before = current(sessionId) ?? { items: [], running: false, since: undefined }
      if (before.running === running && before.since === since) return
      publish(sessionId, { ...before, running, since })
    },
    turnFacts(sessionId) {
      return current(sessionId)?.facts ?? EMPTY_FACTS
    },
    watchTurns(sessionId, listener) {
      if (!sessionId || typeof listener !== 'function') return () => {}
      const own = watchers(sessionId)
      own.add(listener)
      return () => {
        own.delete(listener)
        if (own.size === 0) listeners.delete(sessionId)
      }
    },
    closingReply(sessionId, turn) {
      const entry = current(sessionId)
      if (entry === undefined) return null
      return entry.replies.get(turn)
    },
  }
}

export function createVoiceAdapter(speech) {
  const remote = speech && typeof speech === 'object' ? speech : undefined
  return {
    speech: () => remote,
    voiceSetup: providerId => remote === undefined || providerId === undefined
      ? null
      : { prepare: () => requestPreparation(remote, providerId) },
  }
}
