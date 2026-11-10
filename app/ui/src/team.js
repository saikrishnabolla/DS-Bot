// The team as the window keeps it: the Bot views' sources and actions, fed by the
// engine's `state` endpoint and live feed. The window also keeps the Session facts
// those views read.
import { useRef, useSyncExternalStore } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { chatRows } from '../../../ds-bot/src/client/at-menu.js'
import { createBotBrowsers, serveBrowserReads } from '../../../ds-bot/src/client/bot-browsers.js'
import { workPhrase } from '../../../ds-bot/src/client/cells.js'
import { language } from '../../../ds-bot/src/client/i18n.js'
import { toolState } from '../../../ds-bot/src/client/mark.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from '../../../ds-bot/src/client/shared-map.js'
import { createSource, EMPTY_ROSTER, indexRoster } from '../../../ds-bot/src/client/sources.js'
import { STORAGE, migrateStorage } from '../../../ds-bot/src/client/storage.js'
import { teamActions } from '../../../ds-bot/src/client/team-actions.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { registry } from '../../../ds-bot/src/client/themes.js'
import { openFeed } from './api.js'
import { desktopComputerAction, desktopComputerCursor, desktopComputerEntries } from './computer-bridge.js'
import { createConversationState, createVoiceAdapter } from './conversation-state.js'

// Memory news and connector states change without a notice on the feed.
const CATCH_UP_MS = 15_000
const READ_AGAIN = new Set(['hello', 'revision', 'live'])
const NO_WORK = { bots: {}, approvals: [] }

// A selection from a source. The value is kept per snapshot and selector, so React reads
// one value until the source changes.
function useSelect(source, selector) {
  const kept = useRef(null)
  const read = () => {
    const snapshot = source.getSnapshot()
    const last = kept.current
    if (last?.snapshot === snapshot && last.selector === selector) return last.value
    const value = selector(snapshot)
    kept.current = { snapshot, selector, value: last && Object.is(last.value, value) ? last.value : value }
    return kept.current.value
  }
  return useSyncExternalStore(source.subscribe, read)
}

function createBus() {
  const listeners = new Set()
  return {
    on(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event, data) { for (const listener of listeners) listener(event, data) },
  }
}

const setChanged = (source, value) => { if (JSON.stringify(source.getSnapshot()) !== JSON.stringify(value)) source.set(value) }

const singleFlight = (running, key, start) => {
  const present = running.get(key)
  if (present !== undefined) return present
  const call = Promise.resolve().then(start)
  const tracked = call.finally(() => { if (running.get(key) === tracked) running.delete(key) })
  running.set(key, tracked)
  return tracked
}

export function createTeam() {
  migrateStorage()
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  // When each conversation was last left; a visit compares new entries against it.
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()
  const roster = createSource(EMPTY_ROSTER)
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, settings: null, memory: null, toast: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {} })
  const activity = createSource({})
  const work = createSource(NO_WORK)
  const memoryNews = createSource({})
  const live = createSource({})
  const computer = createSource({ bots: {}, leases: [], cursors: [], asks: {}, holds: {} })
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  const update = createSource({ available: false, phase: 'idle' })
  const ownAppUpdates = globalThis.dsBotApp?.updates ?? null
  let wakeUpdate = () => {}
  const browserBridge = globalThis.dsBotApp?.browser ?? null
  const browsers = browserBridge ? createBotBrowsers({ bridge: browserBridge, createSource }) : null
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})
  const browserHolds = browsers?.holds ?? createSource({})
  const layout = createSource({ wide: true })
  // The Session facts: the list (each one's latest entry and change, and which one fills
  // the main view), the status (running, a reply not yet seen) and what was just sent.
  const sessions = createSource({ ids: [], byId: {} })
  const status = createSource(new Map())
  const sent = createSource({})
  const shown = createSource(null)
  const pendingAgentSession = new Map()
  const agentNewInFlight = new Map()
  const chat = createBus()
  const conversations = createConversationState()
  const voice = createVoiceAdapter(globalThis.dsBotApp?.speech)

  const editRow = (id, edit) => sessions.set((list) => {
    const row = list.byId[id] ?? { id }
    return { ids: list.ids.includes(id) ? list.ids : [...list.ids, id], byId: { ...list.byId, [id]: edit(row) } }
  })
  const setStatus = (id, patch) => status.set((map) => {
    const entry = map.get(id) ?? {}
    if (Object.entries(patch).every(([key, value]) => (entry[key] ?? false) === value)) return map
    return new Map(map).set(id, { ...entry, ...patch })
  })
  const show = (id) => {
    if (shown.getSnapshot() === id) return
    const before = shown.getSnapshot()
    shown.set(id)
    if (before) editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
    editRow(id, row => ({ ...row, retainedBy: { mainView: 1 } }))
    setStatus(id, { completionUnread: false })
  }

  let newsKey
  const noteNews = (next) => {
    const key = JSON.stringify(next)
    if (key === newsKey) return
    const opening = newsKey === undefined
    newsKey = key
    memoryNews.set(state => Object.fromEntries(Object.entries(next).map(([id, entry]) => [id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() }])))
  }
  const seenKey = id => roster.getSnapshot().byId?.[id]?.id ?? id
  const leaveVisits = (ids) => {
    seenAt = seenStore.update(seen => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt)
  }
  const writeUnread = (id, value) => {
    const unread = unreadStore.update(marks => setUnread(marks, id, value), ui.getSnapshot().unread)
    ui.set(state => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }))
  }

  let agentSessionIds = new Set()
  const syncAgentSessions = async () => {
    const nextIds = new Set((roster.getSnapshot().agents ?? []).flatMap(agent => agent.sessions ?? []))
    if (nextIds.size === 0 && agentSessionIds.size === 0) return
    const listed = nextIds.size === 0 ? { ids: [], byId: {} } : await call('agent-sessions')
    if (!Array.isArray(listed?.ids) || listed?.byId === null || typeof listed?.byId !== 'object') return
    sessions.set(current => {
      const byId = { ...current.byId }
      for (const id of agentSessionIds) if (!nextIds.has(id)) delete byId[id]
      for (const id of listed.ids) byId[id] = { ...(byId[id] ?? { id }), ...listed.byId[id] }
      const ids = [...current.ids.filter(id => !agentSessionIds.has(id) || nextIds.has(id)), ...listed.ids.filter(id => !current.ids.includes(id))]
      return { ids, byId }
    })
    for (const id of listed.ids) setStatus(id, { running: listed.byId[id]?.running === true })
    status.set(current => {
      const next = new Map(current)
      for (const id of agentSessionIds) if (!nextIds.has(id)) next.delete(id)
      return next
    })
    agentSessionIds = nextIds
  }

  // Reads can overlap (the feed and a finished action); an older answer never wins.
  let pulls = 0
  let applied = 0
  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const value = await call('state', { since: known.revision, models: known.modelsKey ?? '', locale: language() })
    if (order < applied) return
    applied = order
    setChanged(activity, value.activity ?? {})
    setChanged(work, value.work ?? NO_WORK)
    setChanged(computer, value.computerLive ?? {})
    noteNews(value.memoryNews ?? {})
    const current = roster.getSnapshot()
    const changed = {}
    if (value.connectors !== undefined && JSON.stringify(value.connectors) !== JSON.stringify(current.connectors ?? [])) changed.connectors = value.connectors
    if (value.capabilityStatuses !== undefined && JSON.stringify(value.capabilityStatuses) !== JSON.stringify(current.capabilityStatuses ?? {})) changed.capabilityStatuses = value.capabilityStatuses
    if (Object.keys(changed).length > 0 && current.ready) roster.set({ ...current, ...changed })
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) {
      await syncAgentSessions()
      return
    }
    // In a window with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    roster.set(indexRoster(value))
    await syncAgentSessions()
  }
  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  const partFor = (id) => {
    const bot = roster.getSnapshot().byId[id]
    return bot ? currentPart(bot) : id
  }
  const agentSessions = agentId => [...(roster.getSnapshot().agentsById[agentId]?.sessions ?? [])]
  const latestAgentSession = agentId => agentSessions(agentId)
    .sort((a, b) => (sessions.getSnapshot().byId[b]?.updatedAt ?? 0) - (sessions.getSnapshot().byId[a]?.updatedAt ?? 0))[0]
  const openAgentSession = (sessionId) => {
    ui.set(state => ({
      ...state,
      newChat: null,
      exchange: null,
      menu: null,
      palette: null,
      settings: null,
      details: null,
      view: 'details',
      renaming: false,
      tab: null,
    }))
    show(sessionId)
    return sessionId
  }

  const actions = {
    ...teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock }),
    // The full-pane overlays sit above the conversation, so opening one dismisses them.
    openSession: (id) => {
      ui.set(state => (state.newChat || state.exchange || state.menu || state.palette ? { ...state, newChat: null, exchange: null, menu: null, palette: null } : state))
      show(partFor(id))
    },
    isAgentSession: id => roster.getSnapshot().agentOf[id] !== undefined,
    openAgentSession,
    addAgent: async () => {
      const agent = await after(call('add-agent'))
      if (agent?.sessions?.[0] !== undefined) openAgentSession(agent.sessions[0])
      return agent
    },
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return undefined
      const latest = latestAgentSession(agentId)
      return latest === undefined ? actions.newAgentSession(agentId) : openAgentSession(latest)
    },
    newAgentSession: agentId => singleFlight(agentNewInFlight, agentId, async () => {
      if (roster.getSnapshot().agentsById[agentId] === undefined) return undefined
      const list = sessions.getSnapshot()
      const latest = latestAgentSession(agentId)
      const pending = pendingAgentSession.get(agentId)
      if (pending !== undefined && list.byId[pending] !== undefined) pendingAgentSession.delete(agentId)
      const reuse = pending !== undefined && list.byId[pending] === undefined
        ? pending
        : latest !== undefined && list.byId[latest]?.blank === true ? latest : undefined
      if (reuse !== undefined) return openAgentSession(reuse)
      const { sessionId } = await after(call('agent-session', { agentId }))
      if (sessions.getSnapshot().byId[sessionId] === undefined) pendingAgentSession.set(agentId, sessionId)
      editRow(sessionId, row => ({ ...row, blank: true }))
      return openAgentSession(sessionId)
    }),
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      if (shown.getSnapshot() !== sessionId) return
      const rest = agentSessions(agentId)
      if (rest.length > 0) actions.openAgent(agentId)
      else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
    },
    renameAgentSession: (agentId, sessionId, title) => after(call('agent-rename', { agentId, sessionId, title })),
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    removeAgent: async (agentId) => {
      const owned = agentSessions(agentId)
      const result = await after(call('remove-agent', { agentId }))
      if (owned.includes(shown.getSnapshot()) && roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
      return result
    },
    landOn: id => show(partFor(id)),
    toggleSidebar: () => layout.set(state => ({ ...state, wide: !state.wide })),
    selectPanel: id => actions.openSettings(id),
    markUnread: id => writeUnread(id, true),
    clearUnread: id => writeUnread(id, false),
    beginVisit: (id) => {
      // A conversation a Bot started, never opened here, is unread from its start.
      const made = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id]
      const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
      ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
    },
    endVisit: (id) => {
      leaveVisits([id])
      ui.set((state) => {
        if (!(id in (state.visits ?? {}))) return state
        const visits = { ...state.visits }
        delete visits[id]
        return { ...state, visits }
      })
    },
    toggleReaction: (key, index, emoji) => {
      const reactions = reactionStore.update(saved => toggleReaction(saved, key, index, emoji), ui.getSnapshot().reactions)
      ui.set(state => ({ ...state, reactions }))
    },
    // The Bot's details show the run figures.
    runStats: botId => call('run-stats', { botId }),
    // Model providers and their keys use Cue's Models page.
    providers: () => call('providers'),
    pluginInventory: () => call('plugin-inventory'),
    agentPresets: () => call('agent-presets'),
    setAgentPresetDefault: id => after(call('agent-preset-default', { id })),
    startAgentPresetCreator: async () => {
      const { sessionId } = await after(call('agent-preset-start', { id: 'creator' }))
      return openAgentSession(sessionId)
    },
    setProviderKey: (provider, value) => after(call('provider-key', { provider, value })),
    addProvider: body => after(call('provider-add', body)),
    providerModels: body => call('provider-models', body),
    removeProvider: provider => after(call('provider-remove', { provider })),
    stopBotWork: botId => after(call('stop-bot-work', { botId })),
    stopAgentWork: sessionId => after(call('stop-agent-work', { sessionId })),
    learningAnswer: (id, approve) => after(call('learning-answer', { id, approve })),
    turnFacts: sessionId => conversations.turnFacts(sessionId),
    watchTurns: (sessionId, listener) => conversations.watchTurns(sessionId, listener),
    closingReply: (sessionId, turn) => conversations.closingReply(sessionId, turn),
    noteChat: (sessionId, items, running, since) => conversations.noteChat(sessionId, items, running, since),
    openModels: () => actions.openSettings('models'),
    hasRightSidebar: () => true,
    canReferenceChat: () => true,
    referenceChat: (sessionId, span) => ui.set(state => ({ ...state, referenceChat: { sessionId, span, token: Date.now() } })),
    closeReferenceChat: () => ui.set(state => (state.referenceChat ? { ...state, referenceChat: null } : state)),
    referenceChats: async (sessionId) => chatRows(roster.getSnapshot(), await call('reference-chats', { sessionId: partFor(sessionId) }), sessionId),
    speech: voice.speech,
    voiceSetup: voice.voiceSetup,
    installUpdate: async () => {
      const value = await call('update-install')
      update.set(previous => ({ ...previous, ...value }))
      wakeUpdate()
    },
    checkUpdate: async () => {
      const value = await call('update-check', { fresh: true })
      update.set(previous => ({ ...value, ownApp: previous.ownApp }))
      wakeUpdate()
      return value?.latest === true
    },
    checkOwnApp: async () => { await ownAppUpdates?.check?.() },
    installOwnApp: async () => { await ownAppUpdates?.install?.() },
    openOwnApp: async () => { await ownAppUpdates?.open?.() },
    noteSent: (sessionId) => {
      sent.set(state => ({ ...state, [sessionId]: [...(state[sessionId] ?? []), { placement: 'direct', time: Date.now() }] }))
    },
  }
  if (browsers) {
    Object.assign(actions, {
      openBrowser: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.ensureTabs(bot.id)
        if (browsers.tabs.getSnapshot()[bot.id]?.active == null) browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
      },
      browserNewTab: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return null
        browsers.ensureTabs(bot.id)
        const tabId = browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
        return tabId
      },
      browserPick: (id, tabId) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.activate(bot.id, tabId)
        ui.set(state => ({ ...state, details: id, view: 'browser' }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: (botId, tabId) => browsers.closeTab(botId, tabId),
      browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
      browserShow: (tabId, box) => browsers.show(tabId, box),
      browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
      browserCommand: (tabId, name) => browsers.command(tabId, name),
      browserFocus: tabId => browsers.focus(tabId),
      browserTakeover: browserBridge.views ? async botId => {
        const result = await call('browser-takeover', { botId })
        await browserBridge.views.hold(botId, true)
        return result
      } : undefined,
      browserStop: browserBridge.views ? async botId => {
        const result = await call('browser-stop', { botId })
        await browserBridge.views.hold(botId, true)
        return result
      } : undefined,
      browserGiveBack: browserBridge.views ? async (botId, answer = {}) => {
        const result = await call('browser-give-back', { botId, ...answer })
        await browserBridge.views.hold(botId, false)
        return result
      } : undefined,
      browserImport: typeof browserBridge.importSources === 'function' ? {
        sources: () => browserBridge.importSources(),
        pick: () => browserBridge.importPick(),
        live: (source, close) => browserBridge.importLive(source, close),
        apply: (botId, pending) => browserBridge.importApply(`bot:${botId}`, pending),
        cancel: pending => browserBridge.importCancel(pending),
      } : null,
    })
  }

  // Running and the tool at work come with the team's state.
  const followWork = () => {
    const bots = work.getSnapshot().bots ?? {}
    const turns = work.getSnapshot().turns ?? {}
    for (const bot of roster.getSnapshot().bots) {
      const part = currentPart(bot)
      const doing = bots[bot.id]?.roomId === undefined ? bots[bot.id] : undefined
      setStatus(part, { running: doing !== undefined })
      conversations.setRunning(part, doing !== undefined, turns[part])
      actions.noteLive(part, 'tool', doing?.tool ? { label: workPhrase(doing), state: toolState(doing.tool) } : null)
    }
  }
  roster.subscribe(followWork)
  work.subscribe(followWork)

  const onFeed = (event, data) => {
    if (event === 'message' && data?.sessionId && data.item) {
      const { sessionId, item } = data
      conversations.noteMessage(sessionId, item)
      const text = item.kind === 'bot' || item.kind === 'user' ? item.text : ''
      editRow(sessionId, row => ({
        ...row,
        blank: false,
        updatedAt: Math.max(row.updatedAt ?? 0, item.time ?? 0),
        // The sidebar's preview line; turn -1 is never a hidden exchange turn.
        projectionValues: text ? { turnOutline: [{ turn: -1, [item.kind === 'bot' ? 'response' : 'prompt']: text }] } : row.projectionValues,
      }))
      if (item.kind === 'bot' && shown.getSnapshot() !== sessionId) setStatus(sessionId, { completionUnread: true })
      if (item.kind === 'user') sent.set(state => (state[sessionId]?.length ? { ...state, [sessionId]: state[sessionId].slice(1) } : state))
    }
    if (event === 'status' && data?.sessionId && (data.status === 'running' || data.status === 'idle')) {
      setStatus(data.sessionId, { running: data.status === 'running' })
    }
    // While a reply streams in, it stands in for the activity row.
    if (event === 'stream' && data?.sessionId) {
      actions.noteLive(data.sessionId, 'reply', data.phase === undefined && data.text ? { text: true } : null)
      if (roster.getSnapshot().agentOf[data.sessionId] !== undefined) {
        if (data.phase === 'start') setStatus(data.sessionId, { running: true })
        else if (data.phase === 'end') setStatus(data.sessionId, { running: false })
      }
    }
    chat.emit(event, data)
  }

  const start = () => {
    let stopped = false
    let stopReads = null
    const appComputer = globalThis.dsBotApp
    const syncBrowsers = () => {
      if (!browsers) return
      const snapshot = roster.getSnapshot()
      if (!snapshot.ready) return
      const enabled = snapshot.browser === true
      if (enabled && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
      if (!enabled && stopReads) { stopReads(); stopReads = null }
      void browsers.retain(snapshot.bots.map(bot => bot.id))
      ui.set(state => (state.details && state.view === 'browser' && (!enabled || !snapshot.byId[state.details])
        ? { ...state, view: 'details' }
        : state))
    }
    const read = () => {
      void pull().catch((error) => {
        if (stopped) return
        console.warn('[ds-bot] state', error)
        if (!roster.getSnapshot().ready) actions.reportError(error, 'state')
      })
    }
    read()
    syncBrowsers()
    const offBrowsers = roster.subscribe(syncBrowsers)
    const closeFeed = openFeed((event, data) => {
      if (READ_AGAIN.has(event)) read()
      onFeed(event, data)
    })
    const timer = setInterval(read, CATCH_UP_MS)
    let updateStopped = false
    let updateTimer
    const updateLoop = async () => {
      clearTimeout(updateTimer)
      if (updateStopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (updateStopped) return
      if (value) update.set(previous => ({ ...value, ownApp: previous.ownApp }))
      updateTimer = setTimeout(updateLoop, value?.phase === 'installing' ? 2000 : 60 * 60_000)
    }
    wakeUpdate = updateLoop
    void updateLoop()
    let ownAppStopped = false
    const takeOwnApp = ownApp => { if (!ownAppStopped && ownApp) update.set(previous => ({ ...previous, ownApp })) }
    void ownAppUpdates?.state?.().then(takeOwnApp, () => {})
    const offOwnApp = ownAppUpdates?.subscribe?.(takeOwnApp)
    const syncComputer = () => { appComputer?.computer?.(desktopComputerEntries(roster.getSnapshot(), computer.getSnapshot())) }
    const offComputer = typeof appComputer?.computer === 'function' ? computer.subscribe(syncComputer) : () => {}
    const offComputerRoster = typeof appComputer?.computer === 'function' ? roster.subscribe(syncComputer) : () => {}
    if (typeof appComputer?.computer === 'function') syncComputer()
    let computerLoopStopped = false
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    if (typeof appComputer?.computerCursor === 'function') {
      void (async () => {
        let after = 0
        while (!computerLoopStopped) {
          if (roster.getSnapshot().computer?.enabled !== true) { await pause(2000); continue }
          try {
            const reply = await call('computer-cursor-wait', { after })
            if (computerLoopStopped) break
            for (const event of reply?.events ?? []) {
              if (Number.isFinite(event.seq) && event.seq > after) after = event.seq
              if (Number.isFinite(event.t) && Number.isFinite(reply?.now) && reply.now - event.t > 3000) continue
              appComputer.computerCursor(desktopComputerCursor(roster.getSnapshot(), event))
            }
          } catch {
            if (computerLoopStopped) break
            await pause(2000)
          }
        }
      })()
    }
    const idleTimer = typeof appComputer?.idleSeconds === 'function' ? setInterval(() => {
      if (roster.getSnapshot().computer?.enabled !== true) return
      void Promise.resolve(appComputer.idleSeconds()).then((idle) => {
        if (!computerLoopStopped && Number.isFinite(idle)) call('computer-user-active', { idleSeconds: idle }).catch(() => {})
      }).catch(() => {})
    }, 2000) : undefined
    let computerActionsStopped = false
    const offComputerAction = typeof appComputer?.onComputerAction === 'function'
      ? appComputer.onComputerAction(action => {
        if (!computerActionsStopped) void desktopComputerAction(actions, action)
      })
      : null
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => {
      stopped = true
      closeFeed()
      clearInterval(timer)
      updateStopped = true
      clearTimeout(updateTimer)
      wakeUpdate = () => {}
      ownAppStopped = true
      offOwnApp?.()
      if (idleTimer !== undefined) clearInterval(idleTimer)
      computerLoopStopped = true
      computerActionsStopped = true
      if (typeof offComputerAction === 'function') offComputerAction()
      offComputer()
      offComputerRoster()
      offBrowsers()
      stopReads?.()
      browsers?.dispose()
      window.removeEventListener('pagehide', onPageHide)
    }
  }

  const use = source => selector => useSelect(source, selector)
  const hooks = {
    useRoster: use(roster),
    useUi: use(ui),
    useActivity: use(activity),
    useWork: use(work),
    useMemoryNews: use(memoryNews),
    useLive: use(live),
    useComputer: use(computer),
    useCards: use(cards),
    useHeldCards: use(heldCards),
    useTurnClock: use(turnClock),
    useUpdate: use(update),
    useRegistry: use(registry),
    useBrowserPages: use(browserPages),
    useBrowserTabs: use(browserTabs),
    useBrowserHolds: use(browserHolds),
    useSessions: use(sessions),
    useSessionStatus: use(status),
    useSessionRetainInfo: (id, selector) => useSelect(sessions, list => selector(list.byId[id])),
    useLayout: use(layout),
    useShown: use(shown),
  }
  // The Session view shows what was just sent there.
  const sessionHook = sessionId => selector => {
    const pendingSubmissions = useSelect(sent, state => state[sessionId] ?? [])
    const running = useSelect(status, state => state.get(sessionId)?.running === true)
    return selector({ pendingSubmissions, running, subagent: null })
  }
  return { actions, hooks, sessionHook, chat, start }
}
