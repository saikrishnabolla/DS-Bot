import { createElement as h, useEffect, useState } from 'react'
import { PlusIcon } from './icons.js'
import { t } from './i18n.js'

function PresetCard({ row, selected, busy, choose, inspect }) {
  const badge = selected ? t('New task default') : row.group === 'custom' ? t('Custom') : t('Built-in')
  return h('article', { className: 'bt-preset-card', 'data-selected': selected || undefined },
    h('button', { type: 'button', className: 'bt-preset-card-main', disabled: busy, onClick: () => choose(row.id) },
      h('span', { className: 'bt-preset-card-head' },
        h('strong', null, row.name),
        h('span', { className: selected ? 'bt-preset-default' : 'bt-preset-built-in' }, badge),
        h('code', null, row.id)),
      h('span', { className: 'bt-preset-description' }, row.description)),
    h('div', { className: 'bt-preset-actions' },
      h('button', { type: 'button', onClick: () => inspect(row, 'details') }, t('Mode details')),
      h('button', { type: 'button', onClick: () => inspect(row, 'guide') }, t('How to use')),
      h('button', { type: 'button', className: 'bt-preset-config', 'aria-label': t('View configuration'), onClick: () => inspect(row, 'configuration') }, '▣')))
}

export function AgentPresetsPage({ actions }) {
  const [state, setState] = useState({ status: 'loading', view: null, error: '', busy: '' })
  const load = () => {
    setState(previous => ({ ...previous, status: 'loading', error: '' }))
    return Promise.resolve(actions.agentPresets()).then(
      view => setState({ status: 'ready', view, error: '', busy: '' }),
      error => setState({ status: 'error', view: null, error: error?.message ?? String(error), busy: '' }),
    )
  }
  useEffect(() => { void load() }, [])
  const choose = (id) => {
    if (state.busy) return
    setState(previous => ({ ...previous, busy: id, error: '' }))
    void Promise.resolve(actions.setAgentPresetDefault(id)).then(
      view => setState({ status: 'ready', view, error: '', busy: '' }),
      error => setState(previous => ({ ...previous, error: error?.message ?? String(error), busy: '' })),
    )
  }
  const inspect = (row, tab) => setState(previous => ({ ...previous, inspect: { row, tab } }))
  if (state.status === 'loading') return h('div', { className: 'bt-preset-page', role: 'status' }, t('Loading Agent presets…'))
  if (state.status === 'error') return h('div', { className: 'bt-preset-page' },
    h('div', { className: 'bt-plugin-failure', role: 'alert' }, state.error || t('Agent presets could not be loaded.')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: load }, t('Retry')))
  return h('div', { className: 'bt-preset-page' },
    h('p', { className: 'bt-preset-lead' }, t('Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to Cue.')),
    state.error ? h('div', { className: 'bt-plugin-failure', role: 'alert' }, state.error) : null,
    h('section', { className: 'bt-preset-section' },
      h('h3', null, t('Built-in')),
      h('div', { className: 'bt-preset-grid' }, (state.view?.rows ?? []).filter(row => row.group === 'built-in').map(row => h(PresetCard, {
        key: row.id, row, selected: state.view.defaultPreset === row.id, busy: Boolean(state.busy), choose, inspect,
      })))),
    h('section', { className: 'bt-preset-section' },
      h('h3', null, t('Custom')),
      h('div', { className: 'bt-preset-grid' }, (state.view?.rows ?? []).filter(row => row.group === 'custom').map(row => h(PresetCard, {
        key: row.id, row, selected: state.view.defaultPreset === row.id, busy: Boolean(state.busy), choose, inspect,
      }))),
      h('button', { type: 'button', className: 'bt-preset-create', onClick: () => actions.startAgentPresetCreator?.() },
        h(PlusIcon), t('Let the agent help me create a preset'))),
    state.inspect ? h('div', { className: 'bt-preset-inspect', role: 'dialog', 'aria-modal': true, 'aria-label': state.inspect.row.name },
      h('div', { className: 'bt-preset-inspect-card' },
        h('h3', null, state.inspect.row.name),
        state.inspect.tab === 'configuration'
          ? h('dl', null,
            h('div', null, h('dt', null, t('Tools')), h('dd', null, (state.inspect.row.tools ?? []).join(', ') || t('Default'))),
            state.inspect.row.instructions ? h('div', null, h('dt', null, t('Instructions')), h('dd', null, state.inspect.row.instructions)) : null)
          : h('p', null, state.inspect.tab === 'guide' ? (state.inspect.row.instructions || state.inspect.row.description) : state.inspect.row.description),
        h('code', null, state.inspect.row.id),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setState(previous => ({ ...previous, inspect: null })) }, t('Close')))) : null)
}
