// The Agent: a team's one plain session entry, listed beside the Bots but not one of
// them. Its Sessions are ordinary root Sessions in the Cue workspace, so they get
// the whole Cue conversation surface and none of the team tools.
import { randomUUID } from 'node:crypto'
import { AGENT_NAME, AGENT_SESSION_TITLE_MAX } from './constants.js'
import { AGENT_PRESETS } from '../shared/agent-presets.js'

export function install(rt) {
  const { ctx, state } = rt
  const builtIns = new Map(AGENT_PRESETS.map(row => [row.id, row]))
  const builtInPresets = {
    list: async () => AGENT_PRESETS.map(row => ({ ...row })),
    resolve: id => {
      const row = builtIns.get(String(id ?? ''))
      if (row === undefined) throw new Error(`Unknown Agent preset ${JSON.stringify(String(id ?? ''))}`)
      return { ...row }
    },
    save: async () => { throw new Error('Custom Agent presets are not available') },
    remove: async () => { throw new Error('Custom Agent presets are not available') },
  }
  const presets = () => ctx.get('agentPresets') ?? builtInPresets

  /** @type {Map<string, string>} Session id -> Agent record id. */
  const sessionIndex = new Map()
  // store.js calls this from indexSessions after every adopt and save.
  rt.indexAgents = () => {
    sessionIndex.clear()
    for (const agent of Object.values(state.agents)) {
      for (const sessionId of agent.sessions ?? []) sessionIndex.set(sessionId, agent.id)
    }
  }
  // The Agent a Session belongs to; Bot and group Sessions get undefined.
  const agentOf = sessionId => state.agents[sessionIndex.get(sessionId)]

  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const record = (agentId) => {
    const agent = rt.own(state.agents, agentId)
    if (agent === undefined) throw new Error('Unknown Agent')
    return agent
  }
  const defaultAgentPreset = () => {
    const selected = state.prefs.agentPreset ?? 'standard'
    try { return presets().resolve(selected).id } catch { return 'standard' }
  }
  const agentPresetOf = (sessionId) => {
    const agent = agentOf(String(sessionId))
    return agent?.presets?.[sessionId] ?? 'standard'
  }
  const agentPresetView = async () => ({
    defaultPreset: defaultAgentPreset(),
    rows: (await presets().list()).map(row => {
      const builtIn = builtIns.get(row.id)
      return builtIn === undefined ? { ...row, group: 'custom' } : { ...builtIn, ...row, group: 'built-in' }
    }),
  })
  const setDefaultAgentPreset = async (id) => {
    const preset = presets().resolve(id).id
    if (preset === 'standard') delete state.prefs.agentPreset
    else state.prefs.agentPreset = preset
    await rt.save()
    return agentPresetView()
  }

  const saveAgentPreset = async input => {
    await presets().save(input)
    return agentPresetView()
  }

  const deleteAgentPreset = async id => {
    const preset = String(id ?? '')
    await presets().remove(preset)
    if (state.prefs.agentPreset === preset) {
      delete state.prefs.agentPreset
      await rt.save()
    }
    return agentPresetView()
  }

  async function createAgentSession(agentId, workspaceId, presetId) {
    writeCheck()
    const agent = record(agentId)
    // A known workspace id wins (the Agent's latest Session may live outside the
    // team workspace after a workspace switch); anything else gets the team's own.
    const target = typeof workspaceId === 'string' && ctx.workspaceRegistry.get(workspaceId)
      ? workspaceId
      : await rt.ensureWorkspace()
    const preset = presets().resolve(presetId === undefined ? defaultAgentPreset() : presetId).id
    const { sessionId } = await ctx.sessionController.create({ workspaceId: target, agentPreset: preset })
    try {
      const modelRef = await rt.defaultModel()
      if (modelRef !== undefined) {
        const slash = modelRef.indexOf('/')
        if (slash < 1 || slash === modelRef.length - 1) throw new Error(`Invalid default model ${modelRef}`)
        await ctx.sessionController.selectModel({
          sessionId,
          provider: modelRef.slice(0, slash),
          model: modelRef.slice(slash + 1),
        })
      }
      agent.sessions.push(sessionId)
      agent.presets ??= {}
      agent.presets[sessionId] = preset
      await rt.save()
      return sessionId
    } catch (error) {
      agent.sessions = agent.sessions.filter(id => id !== sessionId)
      if (agent.presets) delete agent.presets[sessionId]
      await ctx.workspaceRegistry.archiveSession(sessionId).catch(() => {})
      throw error
    }
  }

  // A root Session the user opened from an Agent page (the hero's workspace
  // picker or a fork) is adopted into the same Agent: it keeps Cue's surface and
  // the team tools stay hidden.
  async function adoptAgentSession(agentId, sessionId) {
    writeCheck()
    const agent = record(agentId)
    if (agent.sessions.includes(sessionId)) return sessionId
    await rt.resolveAgent(sessionId)
    const owned = rt.selfOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined
      || rt.roomOf(sessionId) !== undefined || agentOf(sessionId) !== undefined
    if (owned) throw new Error('Session already belongs to the team')
    agent.sessions.push(sessionId)
    agent.presets ??= {}
    agent.presets[sessionId] = 'standard'
    await rt.save()
    return sessionId
  }

  async function addAgent(presetId) {
    writeCheck()
    if (Object.keys(state.agents).length > 0) throw new Error('The team already has an Agent')
    const agent = { id: randomUUID(), name: AGENT_NAME, sessions: [], presets: {}, createdAt: Date.now() }
    state.agents[agent.id] = agent
    try {
      await createAgentSession(agent.id, undefined, presetId)
    } catch (error) {
      // The first Session may already be created and saved: archive it and
      // persist the rollback, or the Agent returns on restart with its team
      // tools never denied.
      const createdSessions = [...agent.sessions]
      delete state.agents[agent.id]
      for (const sessionId of createdSessions) await ctx.workspaceRegistry.archiveSession(sessionId).catch(() => {})
      await rt.save().catch(() => {})
      throw error
    }
    return agent
  }

  async function startAgentPreset(presetId) {
    const preset = presets().resolve(presetId).id
    const existing = Object.values(state.agents)[0]
    if (existing !== undefined) {
      return { agentId: existing.id, sessionId: await createAgentSession(existing.id, undefined, preset) }
    }
    const agent = await addAgent(preset)
    return { agentId: agent.id, sessionId: agent.sessions[0] }
  }

  async function archiveAgentSession(agentId, sessionId) {
    writeCheck()
    const agent = record(agentId)
    if (!agent.sessions.includes(sessionId)) throw new Error('Session does not belong to the Agent')
    // Archive first: the Session leaves the Agent only once it is actually gone,
    // so a failed archive stays retryable and keeps its tool restriction.
    await ctx.workspaceRegistry.archiveSession(sessionId)
    agent.sessions = agent.sessions.filter(id => id !== sessionId)
    if (agent.presets) delete agent.presets[sessionId]
    await rt.save()
  }

  async function renameAgentSession(agentId, sessionId, title) {
    writeCheck()
    const agent = record(agentId)
    if (!agent.sessions.includes(sessionId)) throw new Error('Session does not belong to the Agent')
    const clean = String(title ?? '').trim()
    if (clean === '') throw new Error('A session needs a title')
    const agent_ = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent_.session, clean.slice(0, AGENT_SESSION_TITLE_MAX))
  }

  async function removeAgent(agentId) {
    writeCheck()
    const agent = record(agentId)
    const sessions = [...agent.sessions]
    const kept = []
    let failure
    for (const sessionId of sessions) {
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId)
      } catch (error) {
        failure ??= error
        kept.push(sessionId)
      }
    }
    // What could not be archived stays with the Agent, so it keeps its tool
    // restriction and the removal can be retried from the same place.
    if (kept.length > 0) {
      agent.sessions = kept
      await rt.save()
      throw failure
    }
    delete state.agents[agentId]
    await rt.save()
  }

  Object.assign(rt, {
    agentOf, agentPresetOf, agentPresetView, setDefaultAgentPreset, saveAgentPreset, deleteAgentPreset,
    addAgent, startAgentPreset, createAgentSession, adoptAgentSession, archiveAgentSession, renameAgentSession, removeAgent,
  })
}
