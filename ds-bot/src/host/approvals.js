// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card, but DS Bot can answer those too
// (IM chats, the phone app): the request is raced — whichever side answers first wins,
// and the other card withdraws.
import { randomUUID } from 'node:crypto'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }

export function install(rt) {
  const { ctx } = rt
  const durability = ctx.get?.('approvalDurability')
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, answer?:(outcome:string)=>void}>} */
  const pending = new Map()
  const durable = new Set()
  const live = new Set()
  for (const record of durability?.pending?.() ?? []) {
    pending.set(record.entry.id, record.entry)
    durable.add(record.entry.id)
  }
  const approvalListeners = new Set()
  const onApproval = (listener) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  }
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }
  const settle = (entry, outcome) => {
    if (!pending.has(entry.id)) return false
    if (durable.has(entry.id) && !durability.settle(entry.id, outcome)) return false
    pending.delete(entry.id)
    live.delete(entry.id)
    rt.noteApproval?.(entry.sessionId, undefined)
    emit('settled', { id: entry.id, outcome })
    return true
  }
  for (const entry of pending.values()) entry.answer = () => settle(entry, 'cancelled')

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const botId = owner?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    const tool = String(request.toolName ?? '')
    const candidate = botId === undefined ? undefined : {
      id: randomUUID(), sessionId, botId, ...(owner ? { roomId: owner.roomId } : {}), tool,
      reason: String(request.reason ?? '').slice(0, 500), detail: rt.callDetail?.(sessionId, request.callId) ?? {}, at: Date.now(),
    }
    const record = durability?.open?.({ sessionId, callId: request.callId, tool }, candidate)
    if (botId === undefined && record === undefined) return next()
    if (record?.state === 'settled') {
      rt.noteApproval?.(sessionId, undefined)
      return 'cancelled'
    }
    const entry = record?.entry ?? candidate
    if (entry === undefined) return next()
    const id = entry.id
    const current = pending.get(id)
    if (current !== undefined && live.has(id)) return 'cancelled'
    pending.set(id, entry)
    live.add(id)
    if (record !== undefined) durable.add(id)
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    emit('open', { ...entry, answerable: true })
    if (entry.roomId === undefined) {
      // An own-chat approval races DSH's card. The card sees `linked`, our own
      // AbortSignal: answering here resolves the request, then withdraws the card;
      // an answer there settles `next()` first and is adopted. An abort of the
      // original signal cancels either way.
      const original = request.signal
      const linked = new AbortController()
      request.signal = linked.signal
      return new Promise((resolve, reject) => {
        const complete = (outcome) => {
          if (!settle(entry, outcome)) return
          resolve(outcome)
          linked.abort()
          if (request.signal === linked.signal) request.signal = original
        }
        entry.answer = complete
        const cancel = () => {
          try { entry.answer('cancelled') } catch (error) { rt.warn('ds-bot: approval cancellation was not saved: %s', error) }
        }
        if (original?.aborted) cancel()
        else original?.addEventListener('abort', cancel, { once: true })
        Promise.resolve(next()).then(
          (outcome) => {
            if (!pending.has(id)) return
            complete(outcome)
          },
          // DSH's answerer threw: close the entry and give the caller the error
          // the way the pre-race code did, instead of hanging forever.
          (error) => {
            if (!settle(entry, 'cancelled')) return
            reject(error)
            linked.abort()
            if (request.signal === linked.signal) request.signal = original
          },
        )
      })
    }
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!settle(entry, outcome)) return
        resolve(outcome)
      }
      const cancel = () => {
        try { entry.answer('cancelled') } catch (error) { rt.warn('ds-bot: approval cancellation was not saved: %s', error) }
      }
      if (request.signal?.aborted) cancel()
      request.signal?.addEventListener('abort', cancel, { once: true })
    })
  }, { prepend: true })

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    entry.answer(outcome)
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals, onApproval })
}
