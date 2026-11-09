const LIVE_DOC = 'pi.live'

const finite = value => (Number.isFinite(Number(value)) ? Number(value) : undefined)
const textBlocks = content => Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text)
  : []
const imageBlocks = content => Array.isArray(content)
  ? content.filter(block => block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')
  : []

function common(entry, message, block) {
  const item = { entryId: String(entry.id), seq: finite(entry.id) }
  const time = finite(message?.timestamp)
  const turn = finite(entry.byTaskId)
  if (time !== undefined) item.time = time
  if (turn !== undefined) item.turn = turn
  if (block !== undefined) item.block = block
  return item
}

function userItem(entry, message, block) {
  const content = message?.content
  const attachments = imageBlocks(content).map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
  const item = {
    kind: 'user',
    text: typeof content === 'string' ? content : textBlocks(content).join('\n'),
    ...common(entry, message, block),
  }
  if (attachments.length > 0) {
    item.images = attachments.length
    item.attachments = attachments
  }
  return item
}

function assistantItems(entry, message) {
  const items = []
  const content = Array.isArray(message?.content) ? message.content : []
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      items.push({ kind: 'bot', text: block.text, ...common(entry, message, index) })
    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      items.push({
        kind: 'reasoning',
        text: block.thinking,
        ...(block.redacted === true ? { redacted: true } : {}),
        ...common(entry, message, index),
      })
    } else if (block?.type === 'toolCall' && typeof block.name === 'string') {
      items.push({
        kind: 'tool-call',
        callId: String(block.id ?? ''),
        name: block.name,
        arguments: block.arguments ?? {},
        ...(typeof block.namespace === 'string' ? { namespace: block.namespace } : {}),
        ...(typeof block.argumentsError === 'string' ? { error: block.argumentsError } : {}),
        ...common(entry, message, index),
      })
    }
  }
  if (message?.stopReason === 'error' || message?.stopReason === 'aborted') {
    items.push({
      kind: 'failure',
      reason: message.stopReason,
      ...(typeof message.errorMessage === 'string' ? { detail: message.errorMessage } : {}),
      source: 'assistant',
      ...common(entry, message, content.length),
    })
  }
  return items
}

function toolResultItem(entry, message) {
  const attachments = imageBlocks(message?.content).map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
  const item = {
    kind: 'tool-result',
    callId: String(message?.toolCallId ?? ''),
    name: String(message?.toolName ?? ''),
    text: textBlocks(message?.content).join('\n'),
    isError: message?.isError === true,
    ...common(entry, message),
  }
  if (attachments.length > 0) item.attachments = attachments
  if (message?.details !== undefined) item.details = message.details
  if (Array.isArray(entry.data?.diagnostics) && entry.data.diagnostics.length > 0) item.diagnostics = entry.data.diagnostics
  return item
}

function entryItems(entry) {
  if (entry === null || typeof entry !== 'object') return []
  const message = Array.isArray(entry.model) ? entry.model[0] : undefined
  if (entry.kind === 'pi.user' && message?.role === 'user') return [userItem(entry, message)]
  if (entry.kind === 'pi.assistant' && message?.role === 'assistant') return assistantItems(entry, message)
  if (entry.kind === 'pi.tool-result' && message?.role === 'toolResult') return [toolResultItem(entry, message)]
  if (entry.kind === 'pi.reset') {
    const marker = { kind: 'divider', reason: 'reset', ...common(entry, message) }
    return message?.role === 'user' ? [marker, userItem(entry, message, 0)] : [marker]
  }
  if (entry.kind === 'pi.compaction') {
    return [{
      kind: 'divider',
      reason: 'compaction',
      ...(typeof entry.data?.reason === 'string' ? { trigger: entry.data.reason } : {}),
      ...common(entry, message),
    }]
  }
  return []
}

function liveState(value) {
  if (value?.docs && typeof value.docs === 'object') return value.docs[LIVE_DOC] ?? {}
  return value && typeof value === 'object' ? value : {}
}

function runFailureItem(live) {
  const failure = liveState(live).runFailure
  if (failure === null || typeof failure !== 'object') return undefined
  return {
    kind: 'failure',
    reason: String(failure.reason ?? 'faulted'),
    ...(typeof failure.detail === 'string' ? { detail: failure.detail } : {}),
    ...(failure.taskId === undefined ? {} : { taskId: String(failure.taskId) }),
    ...(Array.isArray(failure.inputs) ? { inputs: failure.inputs.map(String) } : {}),
    source: 'run',
  }
}

export function projectEntries(entries, { live } = {}) {
  const items = []
  for (const entry of Array.isArray(entries) ? entries : []) items.push(...entryItems(entry))
  const failure = runFailureItem(live)
  if (failure !== undefined) items.push(failure)
  return items
}

function generationOf(value) {
  const live = liveState(value)
  const generation = live.generation
  if (generation === null || typeof generation !== 'object') return undefined
  const attempt = finite(generation.attempt)
  if (attempt === undefined) return undefined
  const task = live.run?.taskId === undefined ? 'generation' : String(live.run.taskId)
  return {
    attemptId: `${task}:${attempt}`,
    text: textBlocks(generation.message?.content).join(''),
  }
}

export function projectLive(previous, current) {
  const before = generationOf(previous)
  const after = generationOf(current)
  const events = []
  if (before !== undefined && (after === undefined || after.attemptId !== before.attemptId)) {
    events.push({ phase: 'end', attemptId: before.attemptId })
  }
  if (after === undefined) return events
  if (before === undefined || after.attemptId !== before.attemptId) {
    events.push({ phase: 'start', attemptId: after.attemptId })
    if (after.text !== '') events.push({ attemptId: after.attemptId, text: after.text })
    return events
  }
  if (after.text === before.text) return events
  if (after.text.startsWith(before.text)) {
    events.push({ attemptId: after.attemptId, text: after.text.slice(before.text.length) })
    return events
  }
  events.push({ phase: 'start', attemptId: after.attemptId })
  if (after.text !== '') events.push({ attemptId: after.attemptId, text: after.text })
  return events
}

const idOf = entry => finite(entry?.id) ?? Number.MAX_SAFE_INTEGER

export function pageFromEntries(source, { before, limit = 60, live, order } = {}) {
  if (Array.isArray(source)) {
    const ascending = [...source].sort((left, right) => idOf(left) - idOf(right))
    const eligible = before === undefined ? ascending : ascending.filter(entry => idOf(entry) < Number(before))
    const size = Number.isInteger(limit) && limit > 0 ? limit : 60
    const records = eligible.slice(Math.max(0, eligible.length - size))
    return {
      items: projectEntries(records, { live }),
      cursor: eligible.length > records.length && records.length > 0 ? { before: String(records[0].id) } : null,
    }
  }
  const page = source && typeof source === 'object' ? source : { items: [] }
  const direction = order ?? page.next?.order
  const records = Array.isArray(page.items) ? [...page.items] : []
  if (direction === 'descending') records.reverse()
  return { items: projectEntries(records, { live }), cursor: page.next ?? null }
}
