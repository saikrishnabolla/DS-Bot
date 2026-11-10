const image = value => typeof value === 'string'
  && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[a-zA-Z0-9+/=]+$/.test(value)
  && value.length <= 160000

function cursorEventOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const clean = {}
  for (const key of ['x', 'y']) {
    const number = Number(value[key])
    if (!Number.isFinite(number)) return undefined
    clean[key] = number
  }
  clean.mode = value.mode === 'point' ? 'point' : 'window'
  clean.ripple = value.ripple === true
  clean.botId = String(value.botId ?? '').slice(0, 80)
  if (clean.botId === '') return undefined
  if (typeof value.windowId === 'number' && Number.isFinite(value.windowId)) clean.windowId = value.windowId
  if (Number.isInteger(value.pid)) clean.pid = value.pid
  if (Number.isFinite(value.seq)) clean.seq = value.seq
  if (Number.isFinite(value.t)) clean.t = value.t
  if (typeof value.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.color)) clean.color = value.color
  if (image(value.avatar)) clean.avatar = value.avatar
  return clean
}

function computerEntriesOf(value) {
  const rows = Array.isArray(value?.rows) ? value.rows : []
  const labels = value?.labels ?? {}
  return {
    rows: rows.map(entry => {
      if (entry === null || typeof entry !== 'object' || typeof entry.label !== 'string') return undefined
      const clean = {
        label: String(entry.label).slice(0, 80),
        botId: typeof entry.botId === 'string' ? entry.botId.slice(0, 80) : null,
        waiting: entry.waiting === true,
      }
      if (typeof entry.name === 'string') clean.name = entry.name.slice(0, 80)
      if (typeof entry.app === 'string') clean.app = entry.app.slice(0, 120)
      if (typeof entry.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(entry.color)) clean.color = entry.color
      if (image(entry.avatar)) clean.avatar = entry.avatar
      return clean
    }).filter(entry => entry !== undefined),
    labels: {
      stop: typeof labels.stop === 'string' ? String(labels.stop).slice(0, 30) : undefined,
      stopAll: typeof labels.stopAll === 'string' ? String(labels.stopAll).slice(0, 30) : undefined,
      letGo: typeof labels.letGo === 'string' ? String(labels.letGo).slice(0, 30) : undefined,
    },
  }
}

module.exports = { computerEntriesOf, cursorEventOf }
