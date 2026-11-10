import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { OwnedHarness } from './owned-harness.js'
import { connectMcpTools } from './mcp-tools.js'
import { projectLive } from './projection.js'

const INPUT_KIND = 'ds-bot.user'
const textContent = value => Array.isArray(value) ? value : [{ type: 'text', text: String(value ?? '') }]
const timeOf = message => Number.isFinite(Number(message?.timestamp)) ? Number(message.timestamp) : Date.now()

function inputContent(message) {
  const content = textContent(message?.content ?? message)
  return content.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') return [block]
    const attachment = block?.attachment
    if (block?.type === 'image' && typeof attachment?.data === 'string' && typeof attachment?.mimeType === 'string') {
      return [{ type: 'image', data: attachment.data, mimeType: attachment.mimeType }]
    }
    if (block?.type === 'file') return [{ type: 'text', text: `[Attached file: ${attachment?.name ?? 'file'}]` }]
    return []
  })
}

function sourceOf(entry) {
  if (entry.kind === INPUT_KIND && entry.data?.source && typeof entry.data.source === 'object') return entry.data.source
  return { kind: 'user', ...(entry.data?.requestId === undefined ? {} : { requestId: entry.data.requestId }) }
}

function eventRecords(entries) {
  const records = []
  let seq = 0
  const push = (entry, type, data, time) => records.push({
    entryId: String(entry.id),
    event: { entryId: String(entry.id), seq: seq++, type, data, ...(time === undefined ? {} : { time }) },
  })
  for (const entry of entries) {
    const message = Array.isArray(entry?.model) ? entry.model[0] : undefined
    if ((entry.kind === 'pi.user' || entry.kind === INPUT_KIND) && message?.role === 'user') {
      const time = timeOf(message)
      push(entry, 'user/message', { content: textContent(message.content), source: sourceOf(entry) }, time)
      push(entry, 'turn/start', { turn: Number(entry.byTaskId ?? entry.id) }, time)
      continue
    }
    if (entry.kind === 'pi.assistant' && message?.role === 'assistant') {
      const turn = Number(entry.byTaskId ?? entry.id)
      const content = Array.isArray(message.content) ? message.content : []
      for (let index = 0; index < content.length; index += 1) {
        const block = content[index]
        if (block?.type !== 'toolCall') continue
        push(entry, 'tool/call', {
          turn,
          block: index,
          callId: String(block.id ?? ''),
          name: String(block.name ?? ''),
          arguments: block.arguments ?? {},
        }, timeOf(message))
      }
      const shown = content.filter(block => block?.type === 'text' || block?.type === 'thinking')
      if (shown.length > 0 || message.stopReason === 'error' || message.stopReason === 'aborted') {
        push(entry, 'assistant/message', { turn, message: { ...message, content } }, timeOf(message))
      }
      if (message.stopReason !== 'toolUse') push(entry, 'turn/end', { turn }, timeOf(message))
      continue
    }
    if (entry.kind === 'pi.tool-result' && message?.role === 'toolResult') {
      push(entry, 'tool/result', { callId: String(message.toolCallId ?? ''), message }, timeOf(message))
      continue
    }
    if (entry.kind === 'pi.reset' || entry.kind === 'pi.compaction') {
      push(entry, 'session/divider', { reason: entry.kind === 'pi.reset' ? 'reset' : 'compaction' }, timeOf(message))
    }
  }
  return records
}

function messageKey(message) {
  return JSON.stringify([message?.role, message?.timestamp, message?.content])
}

function messagesWithSources(messages, entries) {
  const sources = new Map()
  for (const entry of entries) {
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined
    if (entry.kind !== INPUT_KIND || message?.role !== 'user') continue
    const key = messageKey(message)
    const queue = sources.get(key) ?? []
    queue.push(sourceOf(entry))
    sources.set(key, queue)
  }
  return messages.map(message => {
    if (message?.role !== 'user') return message
    const source = sources.get(messageKey(message))?.shift()
    return source === undefined ? message : { ...message, source }
  })
}

function allMessages(entries) {
  const messages = entries.flatMap(entry => Array.isArray(entry.model) ? entry.model : [])
  return messagesWithSources(messages, entries)
}

function legacyParameters(parameters) {
  if (parameters?.type === 'object') return parameters
  const properties = {}
  const required = []
  for (const [name, original] of Object.entries(parameters ?? {})) {
    const property = original && typeof original === 'object' ? { ...original } : {}
    if (property.required === true) required.push(name)
    delete property.required
    properties[name] = property
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function outputOf(definition, args, value) {
  if (value && typeof value === 'object' && ['output', 'details', 'diagnostics', 'isError', 'control', 'structuredOutput'].some(key => Object.hasOwn(value, key))) return value
  let rendered
  try { rendered = definition.output?.render?.(args, value) } catch { rendered = undefined }
  if (Array.isArray(rendered)) return { output: rendered }
  if (Array.isArray(value)) return { output: value }
  return { output: [{ type: 'text', text: String(value ?? '') }] }
}

const modelInfo = model => ({
  ...model,
  id: model.id,
  inputModalities: model.input ?? model.inputModalities ?? ['text'],
  context: { contextWindow: model.contextWindow },
  defaultMaxTokens: model.maxTokens,
})

const waitForCancellation = signal => {
  if (signal?.aborted) return Promise.resolve('cancelled')
  return new Promise(resolve => signal?.addEventListener('abort', () => resolve('cancelled'), { once: true }))
}

export class OwnedContext {
  #listeners = new Map()
  #effects = []
  #feed = new Set()
  #agents = new Map()
  #watches = new Map()
  #pending = new Map()
  #configureChanges = new Map()
  #selectedExtensions = new Map()
  #tools = new Map()
  #toolExtensions = new Map()
  #promptSections = new Map()
  #promptExtension
  #removePromptExtension
  #externalMounts = new Set()
  #globalMcpMounts = new Set()
  #guards = []
  #routes = new Map()
  #services = new Map()
  #shellEnvironment = new Set()
  #workspaces = new Map()
  #archived = new Set()
  #titles = new Map()
  #closed = false
  #dispatch
  #hostRuntime
  #sessionStates = new Map()

  constructor(harness, { workspacePath, logger = console } = {}) {
    this.harness = harness
    this.logger = logger
    const path = resolve(workspacePath ?? process.cwd())
    const workspace = { id: 'default', name: 'DS Bot', path }
    this.#workspaces.set(workspace.id, workspace)
    this.workspaceRegistry = {
      get: id => this.#workspaces.get(String(id)),
      list: () => [...this.#workspaces.values()],
      resolveByPath: candidate => [...this.#workspaces.values()].find(item => item.path === resolve(candidate)),
      create: async (candidate, name = 'DS Bot') => {
        const found = this.workspaceRegistry.resolveByPath(candidate)
        if (found !== undefined) return found
        const value = { id: randomUUID(), name, path: resolve(candidate) }
        this.#workspaces.set(value.id, value)
        return value
      },
      archiveSession: async id => { this.#archived.add(String(id)); await this.harness.abort(id, { background: true }) },
      unarchiveSession: async id => { this.#archived.delete(String(id)) },
    }
    this.sessions = {
      messageProjections: [],
      flush: async session => this.#flush(session?.id ?? session),
    }
    this.sessionTitle = { rename: async (session, title) => { this.#titles.set(String(session?.id ?? session), String(title)) } }
    this.connection = { fetch: { register: route => {
      this.#routes.set(route.path, route)
      return () => this.#routes.delete(route.path)
    } } }
    this.tools = {
      register: definition => this.#registerDefinition(definition),
      guard: guard => { this.#guards.push(guard); return () => { const at = this.#guards.indexOf(guard); if (at >= 0) this.#guards.splice(at, 1) } },
      get: name => this.#tools.get(name)?.definition,
      schemas: () => [...this.#tools.values()].map(item => ({ name: item.definition.name, description: item.definition.description, parameters: legacyParameters(item.definition.parameters) })),
    }
    this.systemPrompt = { section: section => {
      this.#promptSections.set(section.name, section)
      this.#refreshPromptExtension()
      return () => { this.#promptSections.delete(section.name); this.#refreshPromptExtension() }
    } }
    this.#services.set('approval', {
      request: request => this.#middleware('approval/request', request, () => waitForCancellation(request.signal)),
    })
    this.#services.set('shellEnv', {
      register: contribution => {
        this.#shellEnvironment.add(contribution)
        return () => this.#shellEnvironment.delete(contribution)
      },
    })
    this.harness.setShellEnvironment?.(({ conversationId }) => {
      const agent = this.#agents.get(String(conversationId))
      if (agent === undefined) return undefined
      const values = {}
      for (const contribution of this.#shellEnvironment) {
        try { Object.assign(values, contribution.resolve?.({ agent, arguments: {} }) ?? {}) } catch (error) {
          this.logger.warn?.(`DS Bot shell environment could not be resolved: ${error?.message ?? error}`)
        }
      }
      return values
    })
    this.harness.beforeGeneration?.(async (messages, { conversationId }) => {
      const resolved = await this.#resolveAgent(conversationId)
      if ('error' in resolved) return messages
      const state = this.#sessionStates.get(String(conversationId))
      const sourced = state === undefined ? messages : messagesWithSources(messages, state.view.entries)
      const signal = new AbortController().signal
      const decision = await this.#middleware('agent/pre-step', {
        agent: resolved.agent,
        messages: sourced,
        signal,
      }, async () => ({ kind: 'enter', messages: sourced }))
      return Array.isArray(decision?.messages) ? decision.messages : sourced
    })
    this.llm = this.#llmService()
    this.harness.setStreamInterceptor?.((model, request, options, next, { conversationId } = {}) => this.#llmMiddleware({
      provider: model.provider,
      model: model.id,
      messages: request.messages ?? [],
      ...(request.systemPrompt === undefined ? {} : { system: request.systemPrompt }),
      ...(options?.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
      signal: options?.signal,
      sessionId: conversationId,
    }, next))
    this.sessionController = {
      create: options => this.#create(options),
      resolveAgent: id => this.#resolveAgent(String(id)),
      selectModel: request => this.#selectModel(request),
      prompt: request => this.#prompt(request),
      page: request => this.#page(request),
      projections: request => this.#projections(request),
      list: request => this.#list(request),
      inspect: () => this.harness.inspect(),
    }
  }

  static async open(options) {
    const harness = await OwnedHarness.open({
      ...options,
      settings: { ...options.settings, extensions: options.settings?.extensions ?? [] },
    })
    return new OwnedContext(harness, options)
  }

  static attach(harness, options) { return new OwnedContext(harness, options) }

  get(name) { return this.#services.get(name) }
  provide(name, value) { this.#services.set(name, value); return () => this.#services.delete(name) }

  on(name, listener, options) {
    const current = this.#listeners.get(name) ?? []
    if (options?.prepend) current.unshift(listener)
    else current.push(listener)
    this.#listeners.set(name, current)
    return () => { const at = current.indexOf(listener); if (at >= 0) current.splice(at, 1) }
  }

  emit(name, ...args) {
    for (const listener of this.#listeners.get(name) ?? []) if (args.length > 1 || listener.length < 2) listener(...args)
  }

  async emitAsync(name, ...args) {
    for (const listener of this.#listeners.get(name) ?? []) if (args.length > 1 || listener.length < 2) await listener(...args)
  }

  async #middleware(name, payload, terminal) {
    const listeners = (this.#listeners.get(name) ?? []).filter(listener => listener.length >= 2)
    const run = index => index < listeners.length ? listeners[index](payload, () => run(index + 1)) : terminal()
    return run(0)
  }

  #llmMiddleware(options, terminal) {
    const listeners = (this.#listeners.get('llm/stream') ?? []).filter(listener => listener.length >= 2)
    const run = index => index < listeners.length ? listeners[index](options, () => run(index + 1)) : terminal()
    return run(0)
  }

  effect(execute) {
    const dispose = execute()
    if (typeof dispose === 'function') this.#effects.push(dispose)
    return dispose
  }

  setDispatch(dispatch) { this.#dispatch = dispatch }

  async dispatch(endpoint, payload, signal) {
    if (this.#dispatch !== undefined) return this.#dispatch(endpoint, payload, signal)
    const route = [...this.#routes.values()].find(value => value.methods?.includes('POST') && value.path.endsWith('/api/bot'))
    if (route === undefined) throw new Error('DS Bot API route is not installed')
    const response = await route.fetch(new Request('http://owned.local/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
      signal,
      headers: { 'content-type': 'application/json' },
    }))
    return response.json()
  }

  subscribeFeed(listener) { this.#feed.add(listener); return () => this.#feed.delete(listener) }
  publishFeed(event, data) { for (const listener of this.#feed) listener(event, data) }

  installTools(definitions, runtime) {
    this.#hostRuntime = runtime
    for (const definition of definitions) this.#registerDefinition(definition)
  }

  async mountMcp(config, { agent, ...options } = {}) {
    const connection = await connectMcpTools(config, options)
    const record = { connection, registrations: new Map(), agent }
    let closed = false
    const attach = target => {
      if (record.registrations.has(target.id)) return
      record.registrations.set(target.id, connection.tools.map(tool => target.ctx.tools.register(tool)))
    }
    if (agent === undefined) {
      this.#globalMcpMounts.add(record)
      for (const target of this.#agents.values()) attach(target)
    } else {
      attach(agent)
    }
    const mount = {
      await: () => agent === undefined
        ? Promise.all([...record.registrations.keys()].map(id => this.#flush(id)))
        : this.#flush(agent.id),
      dispose: async () => {
        if (closed) return
        closed = true
        this.#externalMounts.delete(mount)
        this.#globalMcpMounts.delete(record)
        for (const disposers of record.registrations.values()) {
          for (const dispose of disposers.reverse()) dispose()
        }
        record.registrations.clear()
        await connection.close()
      },
    }
    record.attach = attach
    this.#externalMounts.add(mount)
    return mount
  }

  mountSkill(agent, config) {
    const section = {
      key: `capability-${String(config.name).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`,
      tag: false,
      render: () => String(config.content ?? ''),
    }
    const extension = defineExtension({ name: `ds-bot-skill-${section.key}`, sections: [section] })
    const uninstall = this.harness.install(extension)
    this.#selectExtensions(agent.id, { add: [extension] })
    let closed = false
    const mount = {
      await: () => this.#flush(agent.id),
      dispose: async () => {
        if (closed) return
        closed = true
        this.#externalMounts.delete(mount)
        await this.#selectExtensions(agent.id, { remove: [extension] }).catch(() => undefined)
        uninstall()
      },
    }
    this.#externalMounts.add(mount)
    return mount
  }

  resume() { this.harness.resume() }

  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const agent of this.#agents.values()) this.emit('agent/disposed', { agent })
    await Promise.allSettled([...this.#externalMounts].map(mount => mount.dispose()))
    for (const watch of this.#watches.values()) await watch.stop()
    this.#watches.clear()
    for (const state of this.#sessionStates.values()) {
      await Promise.allSettled(state.effects.splice(0).reverse().map(dispose => dispose()))
    }
    await Promise.allSettled(this.#effects.splice(0).reverse().map(dispose => dispose()))
    await this.harness.close()
  }

  async #create(options = {}) {
    const cwd = options.cwd ?? this.#workspaces.get(String(options.workspaceId ?? 'default'))?.path
    const id = await this.harness.createConversation({ ...(cwd === undefined ? {} : { cwd }) })
    return { sessionId: id }
  }

  #track(id, promise) {
    const pending = this.#pending.get(id) ?? new Set()
    this.#pending.set(id, pending)
    pending.add(promise)
    void promise.finally(() => pending.delete(promise)).catch(() => {})
    return promise
  }

  #configure(id, change) {
    if (this.#closed) return Promise.resolve()
    const key = String(id)
    const previous = this.#configureChanges.get(key) ?? Promise.resolve()
    const configure = () => this.#closed ? undefined : this.harness.configure(key, change)
    const run = previous.then(
      configure,
      configure,
    )
    const tail = run.catch(() => undefined)
    this.#configureChanges.set(key, tail)
    void tail.finally(() => {
      if (this.#configureChanges.get(key) === tail) this.#configureChanges.delete(key)
    })
    return this.#track(key, run)
  }

  #selectExtensions(id, { add = [], remove = [] }) {
    const key = String(id)
    const selected = this.#selectedExtensions.get(key) ?? new Map()
    for (const extension of remove) selected.delete(extension.name)
    for (const extension of add) selected.set(extension.name, extension)
    this.#selectedExtensions.set(key, selected)
    return this.#configure(key, { extensions: [...selected.values()] })
  }

  async #flush(id) {
    const key = String(id)
    while ((this.#pending.get(key)?.size ?? 0) > 0) await Promise.all([...this.#pending.get(key)])
  }

  async #resolveAgent(id) {
    let agent = this.#agents.get(id)
    if (agent !== undefined) return { agent }
    const conversation = await this.harness.conversation(id)
    if (conversation === undefined) return { error: { code: 'session/not-found', message: `Session ${id} does not exist` } }
    const configuredAgent = await this.harness.agent(id)
    this.#selectedExtensions.set(id, new Map((configuredAgent?.extensions ?? []).map(extension => [extension.name, extension])))
    const watch = await this.harness.watch(id, { min: 10_000, max: 10_000 })
    const state = { view: watch.value, events: eventRecords(watch.value.entries), status: 'idle', tools: new Map(), effects: [], eventWaiters: new Set() }
    this.#sessionStates.set(id, state)
    const session = {
      id,
      get seq() { return state.events.length },
      get header() { return { id, title: this.title, config: state.config } },
      eventAt: seq => state.events[seq]?.event,
      snapshotEvents: () => state.events.map(record => record.event),
      deriveMessages: () => allMessages(state.view.entries),
      requestHeader: () => ({ id, config: state.config }),
      setConfig: config => { state.config = config },
    }
    Object.defineProperty(session, 'title', { get: () => this.#titles.get(id) })
    const register = definition => {
      const previous = state.tools.get(definition.name)
      const record = this.#createDefinitionRecord(definition, `ds-bot-session-${id}-${randomUUID()}-${definition.name}`)
      state.tools.set(definition.name, record)
      const selected = this.#selectExtensions(id, {
        ...(previous === undefined ? {} : { remove: [previous.extension] }),
        add: [record.extension],
      })
      if (previous !== undefined) void selected.then(previous.uninstall, previous.uninstall)
      return () => {
        if (state.tools.get(definition.name) !== record) return
        state.tools.delete(definition.name)
        const removed = this.#selectExtensions(id, { remove: [record.extension] })
        void removed.then(record.uninstall, record.uninstall)
        return removed
      }
    }
    const toolScope = {
      register,
      restrict: () => () => {},
      get: name => state.tools.get(name)?.definition,
      schemas: () => [...state.tools.values()].map(item => ({ name: item.definition.name, description: item.definition.description, parameters: legacyParameters(item.definition.parameters) })),
    }
    const agentContext = {
      tools: toolScope,
      mountMcp: config => this.mountMcp(config, { agent }),
      mountSkill: config => this.mountSkill(agent, config),
      on: (name, listener, options) => {
        const dispose = this.on(name, listener, options)
        let active = true
        const wrapped = () => {
          if (!active) return
          active = false
          const at = state.effects.indexOf(wrapped)
          if (at >= 0) state.effects.splice(at, 1)
          return dispose()
        }
        state.effects.push(wrapped)
        return wrapped
      },
      effect: execute => {
        const dispose = execute()
        if (typeof dispose !== 'function') return dispose
        let active = true
        const wrapped = () => {
          if (!active) return
          active = false
          const at = state.effects.indexOf(wrapped)
          if (at >= 0) state.effects.splice(at, 1)
          return dispose()
        }
        state.effects.push(wrapped)
        return wrapped
      },
    }
    const inbox = {
      nextStep: [], nextTurn: [],
      remove(messageId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(message => message.id === messageId)
          if (at >= 0) { list.splice(at, 1); return true }
        }
        return false
      },
      prepend(target, message) { this[target === 'next-step' ? 'nextStep' : 'nextTurn'].unshift(message) },
    }
    agent = {
      id,
      session,
      get status() { return state.status },
      ctx: agentContext,
      inbox,
      followup: message => this.#enqueue(id, message, 'followUp'),
      steer: message => this.#enqueue(id, message, 'steer'),
      inject: message => this.#enqueue(id, message, 'steer'),
      cancel: cause => this.harness.abort(id, { background: true, cause }),
      whenIdle: async () => { await this.#flush(id); await this.harness.waitForIdle(id) },
      runMaintenance: async work => work(new AbortController().signal),
    }
    this.#agents.set(id, agent)
    for (const record of this.#globalMcpMounts) record.attach(agent)
    const update = async next => {
      const previous = state.view
      state.view = next
      const before = state.events.length
      state.events = eventRecords(next.entries)
      for (const record of state.events.slice(before)) {
        this.emit('session/event', session, record.event)
        const owner = this.#hostRuntime?.chatOwners?.get?.(id) ?? id
        for (const item of this.#displayEvent(record.event)) this.publishFeed('message', { botId: owner, sessionId: id, item })
      }
      for (const wake of state.eventWaiters) wake()
      for (const live of projectLive(previous, next)) {
        const frame = live.phase === 'start' ? { type: 'start', attemptId: live.attemptId }
          : live.phase === 'end' ? { type: 'end', attemptId: live.attemptId }
            : { type: 'chunk', attemptId: live.attemptId, chunk: { type: 'text-delta', text: live.text } }
        this.emit('agent/assistant-stream', { agent, frame })
        const owner = this.#hostRuntime?.chatOwners?.get?.(id) ?? id
        this.publishFeed('stream', { botId: owner, sessionId: id, attemptId: live.attemptId, ...(live.phase ? { phase: live.phase } : { text: live.text }) })
      }
      const status = next.docs?.['pi.live']?.run === undefined ? 'idle' : 'running'
      if (status !== state.status) {
        state.status = status
        this.emit('agent/status', { agent, status })
      }
    }
    watch.start(async call => { if (call.kind === 'value') await update(call.value) })
    this.#watches.set(id, watch)
    state.config = configuredAgent?.model === undefined ? undefined : { provider: configuredAgent.model.provider, model: configuredAgent.model.modelId, reasoningEffort: configuredAgent.thinkingLevel }
    if (this.#promptExtension !== undefined) await this.#selectExtensions(id, { add: [this.#promptExtension] })
    await this.emitAsync('agent/created', { agent })
    return { agent }
  }

  #enqueue(id, message, whenBusy) {
    if (this.#closed) return Promise.resolve()
    const source = message?.source ?? { kind: 'user' }
    const requestId = source.requestId ?? message?.id ?? randomUUID()
    const promise = this.harness.submit(id, {
      content: inputContent(message), requestId, whenBusy,
      entry: { kind: INPUT_KIND, data: { source, requestId } },
    })
    this.#track(id, promise)
    return promise
  }

  async #prompt({ sessionId, requestId = randomUUID(), mode, content }) {
    const whenBusy = mode === 'steer' ? 'steer' : 'followUp'
    const submission = await this.harness.submit(sessionId, {
      content: inputContent({ content }), requestId, whenBusy,
      entry: { kind: INPUT_KIND, data: { source: { kind: 'user', requestId }, requestId } },
    })
    return { submissionId: submission.id }
  }

  async #selectModel({ sessionId, provider, model, reasoningEffort }) {
    await this.#configure(sessionId, {
      model: { provider, modelId: model },
      ...(reasoningEffort === undefined ? {} : { thinkingLevel: reasoningEffort }),
    })
    const resolved = this.#agents.get(String(sessionId))
    if (resolved !== undefined) resolved.session.setConfig({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
    return { selected: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
  }

  async #allEntries(id) {
    const entries = []
    let cursor
    do {
      const page = await this.harness.entries(id, { limit: 256, cursor, order: 'ascending' })
      entries.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return entries
  }

  async #page({ address, sessionId, throughSeq, beforeSeq, maxMessages = 60 }) {
    const id = String(sessionId ?? (address?.kind === 'subagent' ? address.childSessionId : address?.sessionId))
    const records = eventRecords(await this.#allEntries(id))
    const through = Number.isSafeInteger(throughSeq) ? throughSeq : Number.MAX_SAFE_INTEGER
    const before = Number.isSafeInteger(beforeSeq) ? beforeSeq : Number.MAX_SAFE_INTEGER
    const eligible = records.filter(record => record.event.seq <= through && record.event.seq < before)
    const selected = eligible.slice(Math.max(0, eligible.length - maxMessages))
    return { records: selected, hasMore: eligible.length > selected.length }
  }

  async #projections({ sessionId }) {
    const records = eventRecords(await this.#allEntries(String(sessionId)))
    if (records.length === 0) return { asOfSeq: -1, values: {} }
    const messages = records.filter(record => record.event.type === 'user/message' || record.event.type === 'assistant/message')
    return {
      asOfSeq: records.at(-1).event.seq,
      values: {
        sessionStats: { messages: messages.length },
        tokenUsage: {},
        contextPressure: {},
        turnOutline: records.filter(record => record.event.type === 'turn/start').map(record => record.event.data.turn),
      },
    }
  }

  async #list() {
    const items = []
    let cursor
    do {
      const page = await this.harness.scanConversations({}, 256, cursor)
      for (const conversation of page.items) {
        const sessionId = String(conversation.id)
        if (this.#archived.has(sessionId)) continue
        const projections = await this.#projections({ sessionId })
        items.push({ sessionId, title: this.#titles.get(sessionId), origin: 'session', projections: { kind: 'sequenced', ...projections } })
      }
      cursor = page.next
    } while (cursor !== undefined)
    return { items }
  }

  #registerDefinition(definition) {
    const previous = this.#tools.get(definition.name)
    if (previous?.definition === definition) return () => {}
    const record = this.#createDefinitionRecord(definition, `ds-bot-${definition.name}`)
    this.#tools.set(definition.name, record)
    this.#toolExtensions.set(definition.name, record.extension)
    this.emit('tools/change')
    return () => {
      if (this.#tools.get(definition.name)?.definition !== definition) return
      this.#tools.delete(definition.name)
      this.#toolExtensions.delete(definition.name)
      record.uninstall()
      this.emit('tools/change')
    }
  }

  #createDefinitionRecord(definition, extensionName) {
    const tool = defineTool({
      name: definition.name,
      description: definition.description ?? definition.name,
      parameters: legacyParameters(definition.parameters),
      replay: 'unsafe',
      ...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
      ...(definition.structuredOutputSchema === undefined ? {} : { structuredOutputSchema: definition.structuredOutputSchema }),
      ...(definition.outputLimits === undefined ? {} : { outputLimits: definition.outputLimits }),
      execute: async (args, api, context) => {
        const resolved = await this.#resolveAgent(String(api.conversationId))
        if ('error' in resolved) throw new Error(resolved.error.message)
        await this.#waitForToolCall(String(api.conversationId), api.callId, context.abortSignal)
        let terminate = false
        const exec = {
          agent: resolved.agent,
          name: definition.name,
          ownedNative: definition.ownedNative === true,
          arguments: args,
          callId: api.callId,
          signal: context.abortSignal,
          concludeTurn: () => { terminate = true },
        }
        for (const guard of this.#guards) {
          const refusal = await guard(exec)
          if (typeof refusal === 'string' && refusal !== '') return { output: [{ type: 'text', text: refusal }], isError: true }
        }
        const decision = await this.#middleware('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
        if (decision?.kind === 'deny') return { output: [{ type: 'text', text: String(decision.reason ?? 'Tool use was denied') }], isError: true }
        const value = await this.#middleware('tools/execute', exec, () => definition.ownedNative === true
          ? definition.execute(args, api, context)
          : definition.execute(args, exec))
        this.emit('tools/result', exec, value)
        const result = definition.ownedNative === true ? value : outputOf(definition, args, value)
        return terminate ? { ...result, control: { ...result.control, terminate: true } } : result
      },
    })
    const extension = defineExtension({ name: extensionName, tools: [tool] })
    const uninstall = this.harness.install(extension)
    return { definition, tool, extension, uninstall }
  }

  async #waitForToolCall(id, callId, signal) {
    const state = this.#sessionStates.get(String(id))
    if (state === undefined) return
    const seen = () => state.events.some(record => record.event.type === 'tool/call' && record.event.data?.callId === callId)
    if (seen()) return
    await new Promise(resolve => {
      let timer
      const finish = () => {
        clearTimeout(timer)
        state.eventWaiters.delete(wake)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const wake = () => { if (seen()) finish() }
      timer = setTimeout(() => {
        this.logger.warn?.(`DS Bot tool ${String(callId)} ran before its transcript event arrived`)
        finish()
      }, 2_000)
      state.eventWaiters.add(wake)
      signal?.addEventListener('abort', finish, { once: true })
      wake()
    })
  }

  #refreshPromptExtension() {
    if (this.#promptSections.size === 0) {
      this.#removePromptExtension?.()
      this.#removePromptExtension = undefined
      this.#promptExtension = undefined
      return
    }
    const sections = [...this.#promptSections.values()]
      .sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0))
      .map(section => ({
        key: String(section.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, 's-'),
        tag: false,
        render: input => {
          const text = typeof section.text === 'function'
            ? section.text({ agent: this.#agents.get(String(input.conversationId)) })
            : section.text
          return typeof text === 'string' && text !== '' ? text : undefined
        },
      }))
    this.#promptExtension = defineExtension({ name: 'ds-bot-system-prompt', sections })
    this.#removePromptExtension = this.harness.install(this.#promptExtension)
  }

  #displayEvent(event) {
    if (event.type === 'user/message') return [{ kind: 'user', text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), time: event.time, seq: event.seq }]
    if (event.type === 'assistant/message') return event.data.message.content.filter(block => block.type === 'text').map(block => ({ kind: 'bot', text: block.text, time: event.time, seq: event.seq, turn: event.data.turn }))
    return []
  }

  #llmService() {
    const models = this.harness.models
    const rawStream = options => {
      const model = models.getModel?.(options.provider, options.model)
      if (model === undefined) throw new Error(`Unknown model ${options.provider}/${options.model}`)
      const {
        provider: _provider,
        model: _model,
        messages = [],
        tools,
        system,
        reasoningEffort,
        signal,
        sessionId,
        ...streamOptions
      } = options
      return models.streamSimple(model, { systemPrompt: system, messages, tools }, {
        ...streamOptions,
        ...(reasoningEffort === undefined ? {} : { reasoning: reasoningEffort }),
        signal,
        sessionId,
      })
    }
    return {
      listProviders: () => models.getProviders?.().map(provider => ({ id: provider.id, name: provider.name })) ?? [],
      listModels: async provider => (models.getModels?.(provider) ?? []).map(modelInfo),
      resolveModelInfo: async (provider, model) => {
        const found = models.getModel?.(provider, model)
        if (found === undefined) throw new Error(`Unknown model ${provider}/${model}`)
        return modelInfo(found)
      },
      listConfigurableProviders: () => models.getProviders?.().map(provider => ({ provider: provider.id, name: provider.name })) ?? [],
      discoverModels: async (_kind, request) => (models.getModels?.(request?.provider) ?? []).map(modelInfo),
      registerAdapter: () => { const handle = () => {}; handle.replace = () => {}; return handle },
      script: (id, respond) => this.harness.scriptModel(id, respond),
      beforeRequest: transform => this.harness.beforeRequest(transform),
      stream: options => this.#llmMiddleware(options, () => rawStream(options)),
    }
  }

}
