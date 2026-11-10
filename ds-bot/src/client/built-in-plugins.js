import { createElement as h, useEffect, useMemo, useState } from 'react'
import { ChevronDownIcon, SearchIcon } from './icons.js'
import { t } from './i18n.js'

const matches = (row, query) => query === '' || [row.id, row.title, row.description, row.module]
  .some(value => String(value ?? '').toLocaleLowerCase().includes(query))

function PluginCard({ row }) {
  const [open, setOpen] = useState(false)
  return h('li', { className: 'bt-plugin-card', 'data-open': open || undefined },
    h('button', {
      type: 'button', className: 'bt-plugin-card-main', 'aria-expanded': open,
      onClick: () => setOpen(value => !value),
    },
    h('span', { className: 'bt-plugin-card-row' },
      h('span', { className: 'bt-plugin-card-title' }, row.title),
      row.state === 'active' ? null : h('span', { className: 'bt-plugin-state' }, row.state),
      h(ChevronDownIcon)),
    row.description ? h('span', { className: 'bt-plugin-card-description' }, row.description) : null,
    row.id !== row.title ? h('code', { className: 'bt-plugin-id' }, row.id) : null),
    open ? h('dl', { className: 'bt-plugin-details' },
      h('div', null, h('dt', null, t('Entry')), h('dd', null, row.id)),
      h('div', null, h('dt', null, t('Module')), h('dd', null, row.module)),
      h('div', null, h('dt', null, t('Status')), h('dd', null, row.state))) : null)
}

function PluginGroup({ title, hint, rows, open, setOpen, end }) {
  return h('section', { className: 'bt-plugin-group' },
    h('div', { className: 'bt-plugin-group-head' },
      h('button', { type: 'button', className: 'bt-plugin-group-toggle', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
        h(ChevronDownIcon), h('span', null, title)),
      end),
    hint ? h('p', { className: 'bt-plugin-group-hint' }, hint) : null,
    open ? (rows.length === 0
      ? h('p', { className: 'bt-plugin-empty' }, t('No plugins match your search.'))
      : h('ul', { className: 'bt-plugin-cards' }, rows.map(row => h(PluginCard, { key: `${row.scope}:${row.id}`, row })))) : null)
}

export function BuiltInPluginsPage({ actions }) {
  const [state, setState] = useState({ status: 'loading', inventory: null, error: '' })
  const [query, setQuery] = useState('')
  const [sessionOpen, setSessionOpen] = useState(true)
  const [globalOpen, setGlobalOpen] = useState(false)
  const load = () => {
    setState(previous => ({ ...previous, status: 'loading', error: '' }))
    return Promise.resolve(actions.pluginInventory()).then(
      inventory => setState({ status: 'ready', inventory, error: '' }),
      error => setState({ status: 'error', inventory: null, error: error?.message ?? String(error) }),
    )
  }
  useEffect(() => { void load() }, [])
  const normalized = query.trim().toLocaleLowerCase()
  const session = useMemo(() => (state.inventory?.session ?? []).filter(row => matches(row, normalized)), [state.inventory, normalized])
  const global = useMemo(() => (state.inventory?.global ?? []).filter(row => matches(row, normalized)), [state.inventory, normalized])
  const presets = state.inventory?.presets ?? []
  const chosen = presets.find(row => row.id === state.inventory?.defaultPreset) ?? presets[0]
  if (state.status === 'loading') return h('div', { className: 'bt-plugin-page' },
    h('p', { className: 'bt-plugin-lead' }, t('Inspect the plugins this deployment ships.')),
    h('div', { className: 'bt-plugin-cards', role: 'status', 'aria-label': t('Loading plugins') },
      [0, 1, 2, 3].map(key => h('div', { key, className: 'bt-plugin-skeleton' }, h('span'), h('span')))))
  if (state.status === 'error') return h('div', { className: 'bt-plugin-page' },
    h('p', { className: 'bt-plugin-lead' }, t('Inspect the plugins this deployment ships.')),
    h('div', { className: 'bt-plugin-failure', role: 'alert' }, state.error || t('The plugin list could not be loaded.')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: load }, t('Retry')))
  return h('div', { className: 'bt-plugin-page' },
    h('p', { className: 'bt-plugin-lead' }, t('Inspect the plugins this deployment ships.')),
    h('label', { className: 'bt-plugin-search' },
      h(SearchIcon),
      h('input', { type: 'search', value: query, placeholder: t('Search plugins'), 'aria-label': t('Search plugins'), onChange: event => setQuery(event.target.value) })),
    h(PluginGroup, {
      title: t('Session plugins'), hint: t('Composed per session by agent presets'), rows: session,
      open: sessionOpen, setOpen: setSessionOpen,
      end: chosen ? h('button', { type: 'button', className: 'bt-plugin-preset', disabled: presets.length < 2, onClick: () => actions.selectPanel?.('agent-presets') },
        t('{name} (default)', { name: chosen.name }), h(ChevronDownIcon)) : null,
    }),
    h(PluginGroup, {
      title: t('Global plugins'), hint: t('Available to the Cue host'), rows: global,
      open: globalOpen || normalized !== '', setOpen: setGlobalOpen,
    }))
}
