export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

const DEFAULTS = Object.freeze({
  thresholdChars: 8_192,
  headChars: 4_096,
  tailChars: 1_024,
})

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))
const codePoints = value => Array.from(value)

function checkedConfig(config = {}) {
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`ToolResultPruneConfig: unknown key "${unknown[0]}"`)
  const value = { ...DEFAULTS, ...config }
  if (!Number.isInteger(value.thresholdChars) || value.thresholdChars <= 0) throw new Error('ToolResultPruneConfig: thresholdChars must be a positive integer')
  for (const key of ['headChars', 'tailChars']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) throw new Error(`ToolResultPruneConfig: ${key} must be a non-negative integer`)
  }
  const emitted = value.headChars + codePoints(PRUNE_MARKER).length + value.tailChars
  if (emitted > value.thresholdChars) throw new Error('ToolResultPruneConfig: headChars + marker + tailChars must fit within thresholdChars')
  return Object.freeze(value)
}

export function createToolResultPruner(config) {
  const resolved = checkedConfig(config)
  const measureContent = blocks => (blocks ?? []).reduce(
    (total, block) => total + (block?.type === 'text' && typeof block.text === 'string' ? codePoints(block.text).length : 0),
    0,
  )
  const pruneContent = blocks => {
    const total = measureContent(blocks)
    if (total <= resolved.thresholdChars) return null
    const removedStart = resolved.headChars
    const removedEnd = total - resolved.tailChars
    const output = []
    let consumed = 0
    let inserted = false
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        output.push(block)
        continue
      }
      const points = codePoints(block.text)
      const start = consumed
      const end = start + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - start))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - start))
      const marker = !inserted && start < removedEnd && end > removedStart ? PRUNE_MARKER : ''
      if (marker !== '') inserted = true
      const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
      if (text !== '') output.push({ ...block, text })
      consumed = end
    }
    if (!inserted) throw new Error('tool-result prune: failed to locate the removed text span')
    return output
  }
  const pruneMessages = messages => {
    let changed = false
    const output = messages.map(message => {
      if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return message
      const content = pruneContent(message.content)
      if (content === null) return message
      changed = true
      return { ...message, content }
    })
    return { messages: changed ? output : messages, changed }
  }
  return { config: resolved, measureContent, pruneContent, pruneMessages }
}
