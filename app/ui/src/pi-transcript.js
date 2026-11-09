export function transcriptSegments(items) {
  const rows = []
  const tools = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item.kind === 'reasoning') {
      rows.push({ kind: 'reasoning', entryId: item.entryId, block: item.block, text: item.text, redacted: item.redacted === true })
      continue
    }
    if (item.kind === 'tool-call') {
      const row = { kind: 'tool', entryId: item.entryId, block: item.block, callId: item.callId, name: item.name, arguments: item.arguments, error: item.error }
      rows.push(row)
      if (item.callId) tools.set(item.callId, row)
      continue
    }
    if (item.kind === 'tool-result') {
      const call = tools.get(item.callId)
      if (call !== undefined) Object.assign(call, { result: item.text, isError: item.isError === true, details: item.details })
      else rows.push({ kind: 'tool', entryId: item.entryId, block: item.block, callId: item.callId, name: item.name, result: item.text, isError: item.isError === true, details: item.details })
      continue
    }
    if (item.kind === 'failure') {
      rows.push({ kind: 'failure', entryId: item.entryId, block: item.block, reason: item.reason, detail: item.detail })
      continue
    }
    rows.push({ kind: 'chat', item })
  }

  const segments = []
  for (const row of rows) {
    if (row.kind === 'chat' && segments.at(-1)?.kind === 'chat') segments.at(-1).items.push(row.item)
    else if (row.kind === 'chat') segments.push({ kind: 'chat', items: [row.item] })
    else segments.push(row)
  }
  return segments
}
