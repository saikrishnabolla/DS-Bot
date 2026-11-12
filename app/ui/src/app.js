import * as React from 'react'
import { Component, createElement as h, Fragment, useEffect, useMemo, useSyncExternalStore } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../../ds-bot/src/client/header.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { SETTINGS_PAGE_IDS } from '../../../ds-bot/src/client/settings.js'
import { BrandMark, TeamSidebar } from '../../../ds-bot/src/client/sidebar.js'
import { allThemes, registry, themeCss } from '../../../ds-bot/src/client/themes.js'
import { Chat } from './chat.js'
import { createClientPlugins } from './plugins.js'
import { installRegistrationHub } from './registration-hub.js'
import { createTeam } from './team.js'

// The team's theme and accent.
function useTheme(prefs) {
  const revision = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  useEffect(() => {
    const theme = allThemes()[prefs?.theme] ?? allThemes().deepseek
    const style = document.createElement('style')
    style.textContent = themeCss(theme, prefs?.accent)
    document.head.append(style)
    if (prefs?.motion) document.body.dataset.btMotion = prefs.motion
    else delete document.body.dataset.btMotion
    return () => { style.remove() }
  }, [prefs?.theme, prefs?.accent, prefs?.motion, revision])
}

// A dialog or panel that fails closes, and the failure shows as a toast; the window stays.
// One that fails again at once stays closed.
class Contain extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
    this.failedAt = 0
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) {
    this.props.onError(error)
    if (Date.now() - this.failedAt > 1000) this.setState({ failed: false })
    this.failedAt = Date.now()
  }

  render() { return this.state.failed ? null : this.props.children }
}

class PluginContain extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) { this.props.onError(error, `plugin:${this.props.registration.package.name}`) }

  render() { return this.state.failed ? null : this.props.children }
}

function PluginSlot({ state, slot, context, onError }) {
  return (state.slots[slot] ?? []).map(registration => h(PluginContain, {
    key: registration.key,
    registration,
    onError,
  }, h(registration.component, { ...context, package: registration.package })))
}

export function App() {
  const team = useMemo(createTeam, [])
  useEffect(() => team.start(), [team])
  const { hooks, actions } = team
  useEffect(() => installRegistrationHub(window, error => actions.reportError(error, 'registration')), [actions])
  const clientPlugins = useMemo(() => createClientPlugins({
    React,
    call,
    settingsPageIds: SETTINGS_PAGE_IDS,
    onError: (error, row) => actions.reportError(error, `plugin:${row.name}`),
  }), [actions])
  const pluginState = clientPlugins.use()
  useEffect(() => {
    const sync = () => clientPlugins.sync().catch(error => actions.reportError(error, 'plugins'))
    void sync()
    const off = team.chat.on(event => { if (event === 'hello' || event === 'plugins') void sync() })
    const timer = setInterval(sync, 5000)
    return () => { off(); clearInterval(timer); void clientPlugins.close() }
  }, [actions, clientPlugins, team])
  const renderClientPlugin = (registration, props) => h(PluginContain, {
    key: registration.key,
    registration,
    onError: actions.reportError,
  }, h(registration.component, { ...props, package: registration.package }))
  const views = {
    ...hooks,
    actions,
    clientPluginPages: pluginState.slots['settings.page'] ?? [],
    renderClientPlugin,
  }
  const slot = (name, context = {}) => h(PluginSlot, { state: pluginState, slot: name, context: { ...views, ...context }, onError: actions.reportError })
  const wide = hooks.useLayout(state => state.wide)
  const shown = hooks.useShown(id => id)
  useTheme(hooks.useRoster(value => value.prefs))
  const closeOverlays = (error) => {
    actions.closeSettings()
    actions.closeMemory()
    actions.closeMenu()
    actions.closePanel()
    actions.closePalette()
    actions.closeVoice()
    actions.closeOverlay()
    actions.reportError(error, 'overlay')
  }
  return h('div', { className: 'dsb-frame', 'data-rail': wide ? undefined : '' },
    h('aside', { className: 'dsb-side', 'data-cue-sidebar': '' },
      h('div', { className: 'dsb-band' }),
      h('div', { className: 'dsb-side-list' },
        wide ? null : h('button', { type: 'button', className: 'dsb-expand', 'aria-label': t('Expand sidebar'), title: t('Expand sidebar'), onClick: () => actions.toggleSidebar() }, h(BrandMark, { size: 22 })),
        h(TeamSidebar, { ...views, wide, embedded: true }),
        slot('sidebar.after', { wide }))),
    h('main', { className: 'dsb-main', 'data-cue-main': '' },
      h('div', { className: 'dsb-band' }),
      shown ? h(Fragment, { key: shown },
        h('div', { className: 'dsb-head', 'data-cue-header': '' },
          h(HeaderPill, { ...views, sessionId: shown, useSession: team.sessionHook(shown) }),
          slot('conversation.header.after', { sessionId: shown })),
        h(Chat, { sessionId: shown, team, pluginSlot: slot })) : null),
    slot('app.overlay'),
    h(Contain, { onError: closeOverlays }, h(Overlays, views)),
    h(ErrorToast, views))
}
