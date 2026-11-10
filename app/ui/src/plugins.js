const UI_SLOTS = new Set([
  'settings.page',
  'app.overlay',
  'sidebar.after',
  'conversation.header.after',
  'conversation.before',
  'conversation.after',
])

const modulePath = (fingerprint, path) => `/api/bot/plugin/${fingerprint}/${path.split('/').map(encodeURIComponent).join('/')}`
const said = error => error?.message ?? String(error)

export function createClientPlugins({ React, call, importModule = url => import(/* @vite-ignore */ url), document: page = globalThis.document, settingsPageIds = [], onError = () => {} } = {}) {
  if (React === undefined || typeof call !== 'function') throw new TypeError('React and call are required')
  const listeners = new Set()
  const loaded = new Map()
  const registrations = new Map()
  const styles = new Map()
  const settingsPages = new Map([...settingsPageIds].map(id => [String(id), 'Cue']))
  let state = { packages: [], slots: {} }
  let closed = false
  let pending = Promise.resolve()

  const publish = () => {
    const slots = {}
    for (const registration of registrations.values()) {
      ;(slots[registration.slot] ??= []).push(registration)
    }
    state = {
      packages: [...loaded.values()].map(record => ({
        source: record.row.source,
        name: record.row.name,
        version: record.row.version,
        fingerprint: record.row.fingerprint,
        ...(record.error ? { error: record.error } : {}),
      })).sort((left, right) => left.name.localeCompare(right.name)),
      slots,
    }
    for (const listener of listeners) listener()
  }

  const remove = async record => {
    record.removed = true
    loaded.delete(record.row.source)
    for (const dispose of record.disposers.reverse()) await Promise.resolve().then(dispose).catch(() => undefined)
    for (const [key, registration] of registrations) if (registration.packageKey === record.key) {
      if (registration.slot === 'settings.page') settingsPages.delete(registration.definition.id)
      registrations.delete(key)
    }
    for (const [key, style] of styles) if (style.packageKey === record.key) {
      style.element.remove()
      styles.delete(key)
    }
  }

  const load = async (row, retried = false) => {
    const record = { key: `${row.source}:${row.fingerprint}`, row, disposers: [], error: '', removed: false, retried }
    loaded.set(row.source, record)
    const ui = {
      register(slot, definition, component) {
        if (closed || record.removed) throw new Error('This Cue client plugin is no longer active')
        if (!UI_SLOTS.has(slot)) throw new Error(`Unknown Cue UI slot ${JSON.stringify(slot)}`)
        if (definition === null || typeof definition !== 'object' || typeof definition.id !== 'string' || definition.id.trim() === '') {
          throw new Error('Cue UI registrations need a non-empty id')
        }
        if (typeof component !== 'function') throw new Error('Cue UI registrations need a component')
        const id = definition.id.trim()
        if (slot === 'settings.page' && (typeof definition.label !== 'string' || definition.label.trim() === '')) {
          throw new Error('Cue settings pages need a label')
        }
        if (slot === 'settings.page' && settingsPages.has(id)) {
          throw new Error(`Cue settings page ${JSON.stringify(id)} is already registered by ${settingsPages.get(id)}`)
        }
        const key = `${record.key}:${slot}:${id}`
        if (registrations.has(key)) throw new Error(`Cue UI slot ${slot} already has ${JSON.stringify(id)} in this package`)
        const registration = {
          key,
          packageKey: record.key,
          package: { source: row.source, name: row.name, version: row.version, fingerprint: row.fingerprint },
          slot,
          definition: { ...definition, id, ...(slot === 'settings.page' ? { label: definition.label.trim() } : {}) },
          component,
        }
        registrations.set(key, registration)
        if (slot === 'settings.page') settingsPages.set(id, row.name)
        publish()
        return () => {
          if (!registrations.delete(key)) return
          if (slot === 'settings.page') settingsPages.delete(id)
          publish()
        }
      },
      style(text, id = 'styles') {
        if (closed || record.removed) throw new Error('This Cue client plugin is no longer active')
        if (typeof text !== 'string') throw new TypeError('Cue plugin styles must be text')
        if (page?.head === undefined) throw new Error('Cue plugin styles are not available here')
        const key = `${record.key}:style:${String(id)}`
        if (styles.has(key)) throw new Error(`Cue plugin style ${JSON.stringify(String(id))} is already registered`)
        const style = page.createElement('style')
        style.dataset.cuePlugin = record.row.name
        style.textContent = text
        page.head.append(style)
        styles.set(key, { packageKey: record.key, element: style })
        return () => { style.remove(); styles.delete(key) }
      },
    }
    try {
      for (const entry of row.entries) {
        const module = await importModule(modulePath(row.fingerprint, entry))
        if (closed || record.removed) return
        if (typeof module.default !== 'function') throw new Error(`Cue client entry ${JSON.stringify(entry)} must export a default setup function`)
        const dispose = await module.default({
          React,
          call,
          ui,
          package: { source: row.source, name: row.name, version: row.version, fingerprint: row.fingerprint },
        })
        if (typeof dispose === 'function') record.disposers.push(dispose)
        else if (typeof dispose?.dispose === 'function') record.disposers.push(() => dispose.dispose())
      }
    } catch (error) {
      record.error = said(error)
      try { onError(error, row) } catch {}
      for (const dispose of record.disposers.reverse()) await Promise.resolve().then(dispose).catch(() => undefined)
      record.disposers = []
      for (const [key, registration] of registrations) if (registration.packageKey === record.key) {
        if (registration.slot === 'settings.page') settingsPages.delete(registration.definition.id)
        registrations.delete(key)
      }
      for (const [key, style] of styles) if (style.packageKey === record.key) {
        style.element.remove()
        styles.delete(key)
      }
    }
  }

  const update = async () => {
    if (closed) return
    const rows = await call('plugin-client-entries')
    if (!Array.isArray(rows)) throw new Error('Cue client plugin inventory is invalid')
    const wanted = new Map(rows.map(row => [String(row.source), row]))
    for (const record of [...loaded.values()]) {
      if (wanted.get(record.row.source)?.fingerprint !== record.row.fingerprint) await remove(record)
    }
    for (const row of rows) {
      if (closed) return
      if (typeof row?.source !== 'string' || typeof row?.name !== 'string' || !/^[a-f0-9]{64}$/u.test(row?.fingerprint) || !Array.isArray(row?.entries)) continue
      const current = loaded.get(row.source)
      if (current?.error && !current.retried) {
        await remove(current)
        await load(row, true)
      } else if (current === undefined) await load(row)
    }
    if (!closed) publish()
  }

  return {
    sync() {
      const next = pending.then(update, update)
      pending = next.catch(() => undefined)
      return next
    },
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    use(selector = value => value) {
      return React.useSyncExternalStore(
        listener => { listeners.add(listener); return () => listeners.delete(listener) },
        () => selector(state),
      )
    },
    async close() {
      if (closed) return
      closed = true
      await pending.catch(() => undefined)
      for (const record of [...loaded.values()]) await remove(record)
      loaded.clear()
      registrations.clear()
      for (const style of styles.values()) style.element.remove()
      styles.clear()
      publish()
    },
  }
}
