import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { getDeclaredTools } from '@earendil-works/pi-ai/utils/transcript'
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { OwnedHarness } from './owned-harness.js'
import { connectMcpTools } from './mcp-tools.js'
import { createOwnedCompactionExtension } from './owned-range-compaction.js'
import { projectLive } from './projection.js'

const INPUT_KIND = 'ds-bot.user'
const textContent = value => Array.isArray(value) ? value : [{ type: 'text', text: String(value ?? '') }]
const timeOf = message => Number.isFinite(Number(message?.timestamp)) ? Number(message.timestamp) : Date.now()

async function inputContent(message, attachments, acceptsImages = true) {
  const content = textContent(message?.content ?? message)
  const converted = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') { converted.push({ type: 'text', text: block.text }); continue }
    if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      converted.push(acceptsImages ? block : { type: 'text', text: `[Image (${block.mimeType}) omitted because this model does not accept images.]` })
      continue
    }
    const attachment = block?.attachment
    if (block?.type === 'image' && typeof attachment?.data === 'string' && typeof attachment?.mimeType === 'string') {
      converted.push(acceptsImages
        ? { type: 'image', data: attachment.data, mimeType: attachment.mimeType }
        : { type: 'text', text: `[Image (${attachment.mimeType}) omitted because this model does not accept images.]` })
      continue
    }
    if ((block?.type === 'image' || block?.type === 'file') && attachments !== undefined) {
      const checked = block.type === 'image' && typeof attachments.imageReference === 'function'
        ? await attachments.imageReference(attachment)
        : await attachments.reference(attachment)
      const path = attachments.hostPath(checked)
      const label = `${JSON.stringify(checked.name ?? 'file')} (${checked.mediaType ?? 'application/octet-stream'}, ${checked.bytes} bytes)`
      if (block.type === 'image') {
        converted.push({ type: 'text', text: `[Image ${label}. Read-only copy saved at ${JSON.stringify(path)}.]` })
        if (acceptsImages) {
          const chunks = []
          for await (const chunk of attachments.readFileStream(checked)) chunks.push(chunk)
          converted.push({ type: 'image', data: Buffer.concat(chunks).toString('base64'), mimeType: checked.mediaType })
        }
      } else if (block.type === 'file') {
        converted.push({ type: 'text', text: `[Attached file ${label}. Read-only copy saved at ${JSON.stringify(path)}. Read it with your file tools before acting on it.]` })
      }
    }
  }
  return converted
}

function sourceOf(entry) {
  if (entry.kind === INPUT_KIND && entry.data?.source && typeof entry.data.source === 'object') return entry.data.source
  return { kind: 'user', ...(entry.data?.requestId === undefined ? {} : { requestId: entry.data.requestId }) }
}

function eventRecords(entries, startSeq = 0) {
  const records = []
  let seq = startSeq
  const push = (entry, type, data, time) => records.push({
    entryId: String(entry.id),
    event: { entryId: String(entry.id), seq: seq++, type, data, ...(time === undefined ? {} : { time }) },
  })
  for (const entry of entries) {
    const message = Array.isArray(entry?.model) ? entry.model[0] : undefined
    if ((entry.kind === 'pi.user' || entry.kind === INPUT_KIND) && message?.role === 'user') {
      const time = timeOf(message)
      const receipt = entry.kind === INPUT_KIND && Array.isArray(entry.data?.content) ? entry.data.content : textContent(message.content)
      const references = entry.kind === INPUT_KIND && Array.isArray(entry.data?.references) ? entry.data.references : []
      const referenceLabels = references.map(reference => reference?.label).filter(label => typeof label === 'string' && label !== '')
      push(entry, 'user/message', {
        content: receipt,
        source: sourceOf(entry),
        ...(referenceLabels.length === 0 ? {} : { referenceLabels }),
      }, time)
      if (references.length > 0) {
        const text = references.map(reference => reference?.text).filter(value => typeof value === 'string' && value !== '').join('\n\n')
        if (text !== '') push(entry, 'user/message', {
          content: [{ type: 'text', text }],
          source: {
            kind: 'session-reference',
            references: references.map(reference => ({ sessionId: String(reference.sessionId), label: String(reference.label) })),
          },
        }, time)
      }
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

const count = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0

function tokenUsageOf(usage) {
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  for (const value of Object.values(usage?.models ?? {})) {
    totals.uncachedInputTokens += count(value?.input)
    totals.cacheReadTokens += count(value?.cacheRead)
    totals.cacheWriteTokens += count(value?.cacheWrite)
    totals.outputTokens += count(value?.output)
  }
  return totals
}

function stepOf(messages) {
  let lastUser = -1
  for (let index = 0; index < messages.length; index += 1) if (messages[index]?.role === 'user') lastUser = index
  return 1 + messages.slice(lastUser + 1).filter(message => message?.role === 'assistant').length
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

const serviceError = (code, message) => Object.assign(new Error(message), { code })

const OWNED_PERMISSION_PRESETS = [
  { value: 'read-only', name: 'Read only' },
  { value: 'workspace-write', name: 'Workspace write' },
  { value: 'danger-full-access', name: 'Full access' },
]

function permissionPresets() {
  const selected = new Map()
  const values = new Set(OWNED_PERMISSION_PRESETS.map(option => option.value))
  return {
    catalog: () => ({ options: OWNED_PERMISSION_PRESETS.map(option => ({ ...option })), defaultOptions: [], defaultPreset: 'workspace-write' }),
    resolve(name) {
      if (!values.has(name)) throw new Error(`permission: unknown preset ${JSON.stringify(name)}`)
      return { id: name }
    },
    set(session, name) {
      this.resolve(name)
      selected.set(String(session?.id ?? session), name)
    },
    get: session => selected.get(String(session?.id ?? session)),
  }
}

function tokenMeter() {
  const estimateMessage = message => estimateContextTokens([message]).tokens
  return {
    estimateMessage,
    measure(session) {
      const messages = session?.deriveMessages?.() ?? []
      return { totalTokens: estimateContextTokens(messages).tokens }
    },
  }
}

function skillCatalog(onChange) {
  const providers = new Set()
  const list = async () => {
    const candidates = []
    for (const create of providers) candidates.push(...await create().list())
    return candidates.sort((left, right) => Number(right.rank ?? 0) - Number(left.rank ?? 0) || left.name.localeCompare(right.name))
  }
  return {
    registerProvider(create) {
      providers.add(create)
      onChange()
      return () => { providers.delete(create); onChange() }
    },
    list,
    async get(candidate) {
      for (const create of providers) {
        const provider = create()
        if (provider.name === candidate?.provider) return provider.get(candidate)
      }
      throw new Error(`Unknown skill provider ${String(candidate?.provider)}`)
    },
    async prompt() {
      const skills = (await list()).map(candidate => ({
        name: candidate.name,
        description: candidate.description,
        filePath: candidate.locator,
        baseDir: dirname(candidate.locator),
        sourceInfo: { source: candidate.source ?? 'bundled' },
        disableModelInvocation: candidate.invocation?.modelInvocable === false,
      }))
      return formatSkillsForPrompt(skills, 'read').trim()
    },
  }
}

function compactionSummary(value) {
  if (typeof value?.summary === 'string') return value.summary.trim()
  if (!Array.isArray(value?.summary)) return ''
  return value.summary
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function piUsage(value) {
  if (value === undefined) return undefined
  const input = count(value.inputTokens ?? value.input)
  const output = count(value.outputTokens ?? value.output)
  const cacheRead = count(value.cacheReadTokens ?? value.cacheRead)
  const cacheWrite = count(value.cacheWriteTokens ?? value.cacheWrite)
  const cost = value.cost ?? {}
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: count(value.totalTokens) || input + output + cacheRead + cacheWrite,
    cost: {
      input: count(cost.input),
      output: count(cost.output),
      cacheRead: count(cost.cacheRead),
      cacheWrite: count(cost.cacheWrite),
      total: count(cost.total),
    },
    ...(value.cacheWrite1h === undefined ? {} : { cacheWrite1h: count(value.cacheWrite1h) }),
    ...(value.reasoning === undefined && value.reasoningTokens === undefined ? {} : { reasoning: count(value.reasoning ?? value.reasoningTokens) }),
  }
}

export class OwnedContext {
  #listeners = new Map()
  #effects = []
  #feed = new Set()
  #agents = new Map()
  #watches = new Map()
  #pending = new Map()
  #inputQueues = new Map()
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
  #injections = new Set()
  #shellEnvironment = new Set()
  #workspaces = new Map()
  #archived = new Set()
  #titles = new Map()
  #closed = false
  #dispatch
  #hostRuntime
  #sessionStates = new Map()
  #projectionDefinitions = new Map()
  #compactionExtension

  constructor(harness, { workspacePath, logger = console, transcriptWindow } = {}, compactionExtension) {
    this.harness = harness
    this.logger = logger
    this.transcriptWindow = transcriptWindow ?? { min: 10_000, max: 10_000 }
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
      schemas: agent => this.#toolSchemas(agent),
    }
    this.systemPrompt = { section: section => {
      this.#promptSections.set(section.name, section)
      this.#refreshPromptExtension()
      return () => { this.#promptSections.delete(section.name); this.#refreshPromptExtension() }
    } }
    const skills = skillCatalog(() => this.#refreshPromptExtension())
    this.#promptSections.set('skills', { name: 'skills', order: 900, text: () => skills.prompt() })
    this.#services.set('skills', skills)
    this.#services.set('tokenMeter', tokenMeter())
    this.#services.set('permissionPresets', permissionPresets())
    this.#services.set('agentPresets', {
      list: async () => [{ id: 'standard', name: 'Standard' }],
      serviceFor: (_agent, name) => name === 'compaction' ? this.#services.get('compaction') : undefined,
    })
    const jobs = new Map()
    this.#services.set('jobs', {
      register: ({ id = randomUUID(), sessionId, chunks = [], ...job }) => {
        const record = { ...job, id, sessionId: String(sessionId), status: job.status ?? 'running', chunks: [...chunks] }
        jobs.set(id, record)
        const session = this.#agents.get(record.sessionId)?.session
        if (session !== undefined) this.emit('session/event', session, { type: 'job/registered', data: { jobId: id, toolCall: job.toolCall } })
        return id
      },
      append: (id, chunk) => { const job = jobs.get(id); if (job === undefined) throw serviceError('job/not-found', `Unknown job ${id}`); job.chunks.push(chunk) },
      read: (id, sessionId) => {
        const job = jobs.get(id)
        if (job === undefined || job.sessionId !== String(sessionId)) throw serviceError('job/not-found', `Unknown job ${id}`)
        return { job: { ...job, chunks: undefined }, chunks: [...job.chunks], lossy: false }
      },
      settle: (id, status = 'completed') => {
        const job = jobs.get(id)
        if (job === undefined) throw serviceError('job/not-found', `Unknown job ${id}`)
        job.status = status
        const session = this.#agents.get(job.sessionId)?.session
        if (session !== undefined) this.emit('session/event', session, { type: 'job/settled', data: { jobId: id, toolCall: job.toolCall, status } })
      },
      kill: id => { const job = jobs.get(id); if (job === undefined) return false; job.status = 'killed'; return true },
    })
    const goals = new Map()
    const goalKey = agent => String(agent?.id ?? agent?.session?.id ?? agent)
    const publishGoal = (agent, goal) => {
      const session = agent?.session
      if (session !== undefined) this.emit('session/event', session, { type: 'goal/change', data: { goal: structuredClone(goal) } })
      return goal
    }
    this.#services.set('goals', {
      get: agent => goals.get(goalKey(agent)),
      start: (agent, input = {}) => {
        const goal = { id: input.id ?? randomUUID(), revision: 1, phase: 'active', ...input }
        goals.set(goalKey(agent), goal)
        return publishGoal(agent, goal)
      },
      block: (agent, expected, error) => {
        const goal = goals.get(goalKey(agent))
        if (goal === undefined || goal.id !== expected?.id || goal.revision !== expected?.revision) return undefined
        const next = { ...goal, revision: goal.revision + 1, phase: 'blocked', error }
        goals.set(goalKey(agent), next)
        return publishGoal(agent, next)
      },
      complete: (agent, expected) => {
        const goal = goals.get(goalKey(agent))
        if (goal === undefined || goal.id !== expected?.id || goal.revision !== expected?.revision) return undefined
        const next = { ...goal, revision: goal.revision + 1, phase: 'complete' }
        goals.set(goalKey(agent), next)
        return publishGoal(agent, next)
      },
    })
    this.#services.set('approval', {
      request: request => this.#middleware('approval/request', request, () => waitForCancellation(request.signal)),
    })
    this.#services.set('shellEnv', {
      register: contribution => {
        this.#shellEnvironment.add(contribution)
        return () => this.#shellEnvironment.delete(contribution)
      },
    })
    this.#services.set('agents', { list: () => [...this.#agents.values()], get: id => this.#agents.get(String(id)) })
    this.#services.set('sessionProjections', {
      register: definition => {
        this.#projectionDefinitions.set(definition.key, definition)
        return () => {
          if (this.#projectionDefinitions.get(definition.key) === definition) this.#projectionDefinitions.delete(definition.key)
        }
      },
      stateOf: (session, key) => this.#projectionState(session, key),
      snapshot: (session, keys) => this.#projectionSnapshot(session, keys),
    })
    const compaction = {
      ownedTriggers: true,
      summarize: async () => undefined,
      beforeCompact: (input, agent, signal) => compaction.summarize(input, agent, signal),
      compactIfNeeded: (target, _trigger, signal) => compaction.compactNow(target, signal),
      compactNow: (target, signal) => this.#compact(target, signal),
      compactRegion: (start, end, target, signal) => this.#compactRegion(start, end, target, signal),
    }
    this.#services.set('compaction', compaction)
    this.#refreshPromptExtension()
    this.#compactionExtension = compactionExtension
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
        step: stepOf(sourced),
        modelSelection: state?.config,
        signal,
      }, async () => ({ kind: 'enter', messages: sourced }))
      if (decision?.kind === 'reject') return { kind: 'reject', ...(decision.reason === undefined ? {} : { reason: String(decision.reason) }) }
      if (Array.isArray(decision?.messages) && decision.messages.length === 0) return { kind: 'complete' }
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
    let context
    const compactionExtension = createOwnedCompactionExtension({
      beforeCompact: (input, api, hookContext) => context.#beforeCompact(input, api, hookContext),
      summarizeRange: (input, api, hookContext) => context.#summarizeRange(input, api, hookContext),
    })
    const harness = await OwnedHarness.open({
      ...options,
      settings: { ...options.settings, extensions: [...(options.settings?.extensions ?? []), compactionExtension] },
    })
    context = new OwnedContext(harness, options, compactionExtension)
    return context
  }

  static attach(harness, options) {
    let context
    const compactionExtension = createOwnedCompactionExtension({
      beforeCompact: (input, api, hookContext) => context.#beforeCompact(input, api, hookContext),
      summarizeRange: (input, api, hookContext) => context.#summarizeRange(input, api, hookContext),
    })
    harness.install(compactionExtension)
    context = new OwnedContext(harness, options, compactionExtension)
    return context
  }

  get(name) { return this.#services.get(name) }
  provide(name, value) {
    this.#services.set(name, value)
    this.#refreshInjections()
    return () => {
      if (this.#services.get(name) !== value) return
      this.#services.delete(name)
      this.#refreshInjections()
    }
  }

  inject(requirements, attach) {
    const keys = Array.isArray(requirements) ? requirements : Object.keys(requirements ?? {})
    const record = { keys, attach, cleanup: undefined, closed: false }
    this.#injections.add(record)
    this.#refreshInjection(record)
    return () => {
      if (record.closed) return
      record.closed = true
      this.#injections.delete(record)
      record.cleanup?.()
      record.cleanup = undefined
    }
  }

  #refreshInjections() {
    for (const record of this.#injections) this.#refreshInjection(record)
  }

  #refreshInjection(record) {
    const available = record.keys.every(key => this.#services.has(key))
    if (!available || record.closed) {
      record.cleanup?.()
      record.cleanup = undefined
      return
    }
    if (record.cleanup !== undefined) return
    const disposers = []
    const scope = Object.fromEntries(record.keys.map(key => [key, this.#services.get(key)]))
    scope.effect = execute => {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    }
    const returned = record.attach(scope)
    if (typeof returned === 'function') disposers.push(returned)
    record.cleanup = () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    }
  }

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
    for (const injection of this.#injections) {
      injection.closed = true
      injection.cleanup?.()
    }
    this.#injections.clear()
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
    await this.#selectExtensions(id, { add: [this.#compactionExtension] })
    const watch = await this.harness.watch(id, this.transcriptWindow)
    const entries = await this.#allEntries(id)
    const state = {
      view: watch.value,
      entries,
      entryIds: new Set(entries.map(entry => String(entry.id))),
      events: eventRecords(entries),
      status: 'idle',
      tools: new Map(),
      restrictions: new Map(),
      effects: [],
      eventWaiters: new Set(),
    }
    this.#sessionStates.set(id, state)
    const session = {
      id,
      get seq() { return state.events.length },
      get header() { return { id, title: this.title, config: state.config } },
      eventAt: seq => state.events[seq]?.event,
      snapshotEvents: () => state.events.map(record => record.event),
      deriveMessages: () => allMessages(state.entries),
      toolHistory: () => getDeclaredTools(allMessages(state.entries)),
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
      restrict: filter => this.#restrictTools(id, state, filter),
      get: name => state.tools.get(name)?.definition,
      schemas: () => this.#toolSchemas(agent),
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
      whenIdle: async () => { await this.#inputQueues.get(id); await this.#flush(id); await this.harness.waitForIdle(id) },
      runMaintenance: async work => work(new AbortController().signal),
    }
    this.#agents.set(id, agent)
    for (const record of this.#globalMcpMounts) record.attach(agent)
    const update = async next => {
      const previous = state.view
      state.view = next
      const before = state.events.length
      let added = next.entries.filter(entry => !state.entryIds.has(String(entry.id)))
      if (added.length > 0 && state.entries.length > 0 && !next.entries.some(entry => state.entryIds.has(String(entry.id)))) {
        const refreshed = await this.#allEntries(id)
        added = refreshed.slice(state.entries.length)
        state.entries = refreshed
        state.entryIds = new Set(refreshed.map(entry => String(entry.id)))
      } else if (added.length > 0) {
        state.entries.push(...added)
        for (const entry of added) state.entryIds.add(String(entry.id))
      }
      if (added.length > 0) state.events.push(...eventRecords(added, before))
      const appended = state.events.slice(before)
      for (const record of appended) {
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
      if (appended.some(record => record.event.type === 'turn/end')) await this.#refreshProjectionState(id, state)
    }
    watch.start(async call => { if (call.kind === 'value') await update(call.value) })
    this.#watches.set(id, watch)
    state.config = configuredAgent?.model === undefined ? undefined : { provider: configuredAgent.model.provider, model: configuredAgent.model.modelId, reasoningEffort: configuredAgent.thinkingLevel }
    if (this.#promptExtension !== undefined) await this.#selectExtensions(id, { add: [this.#promptExtension] })
    await this.emitAsync('agent/created', { agent })
    await this.#applyToolRestrictions(id, state)
    await this.#flush(id)
    return { agent }
  }

  #enqueue(id, message, whenBusy) {
    if (this.#closed) return Promise.resolve()
    const key = String(id)
    const before = this.#inputQueues.get(key) ?? Promise.resolve()
    const prepared = before.catch(() => undefined).then(async () => {
      const source = message?.source ?? { kind: 'user' }
      const requestId = source.requestId ?? message?.id ?? randomUUID()
      const receipt = textContent(message?.content ?? message)
      const configured = this.#sessionStates.get(key)?.config
      const model = configured?.provider === undefined || configured?.model === undefined ? undefined : this.harness.models.getModel?.(configured.provider, configured.model)
      const content = await inputContent(message, this.get('attachments'), model === undefined || (model.input ?? []).includes('image'))
      const submission = this.harness.submit(id, {
        content, requestId, whenBusy,
        entry: { kind: INPUT_KIND, data: { source, requestId, content: receipt } },
      })
      this.#track(id, submission)
      return { submission }
    })
    const queued = prepared.then(() => undefined, () => undefined)
    this.#inputQueues.set(key, queued)
    void queued.finally(() => { if (this.#inputQueues.get(key) === queued) this.#inputQueues.delete(key) })
    return prepared.then(value => value.submission)
  }

  async #compact(target, signal) {
    const id = String(target?.session?.id ?? target?.id ?? target)
    if (target?.status !== undefined && target.status !== 'idle') throw serviceError('busy', `Conversation ${id} is busy`)
    if (signal?.aborted) throw serviceError('cancelled', signal.reason?.message ?? 'Compaction cancelled')
    const taskId = await this.harness.compact(id)
    let cancelled
    const cancellation = signal === undefined ? undefined : new Promise(resolve => {
      const stop = () => resolve({ cancelled: signal.reason ?? new Error('Compaction cancelled') })
      signal.addEventListener('abort', stop, { once: true })
      cancelled = () => signal.removeEventListener('abort', stop)
    })
    try {
      const settled = cancellation === undefined
        ? await this.harness.waitForTask(taskId)
        : await Promise.race([this.harness.waitForTask(taskId), cancellation])
      if (settled?.cancelled !== undefined) {
        await this.harness.abortTask(taskId)
        throw serviceError('cancelled', settled.cancelled?.message ?? 'Compaction cancelled')
      }
      const outcome = settled.state.outcome
      if (outcome.status === 'failed') throw new Error(outcome.error.message)
      if (outcome.status === 'aborted' || outcome.status === 'abandoned') throw serviceError('cancelled', 'Compaction cancelled')
      const submissionId = outcome.result?.submissionId
      if (submissionId === undefined) return outcome.result?.entryId === undefined ? null : { status: 'done' }
      const placed = cancellation === undefined
        ? await this.harness.waitForSubmission(submissionId)
        : await Promise.race([this.harness.waitForSubmission(submissionId), cancellation])
      if (placed?.cancelled !== undefined) {
        await this.harness.abortSubmission(submissionId, id)
        throw serviceError('cancelled', placed.cancelled?.message ?? 'Compaction cancelled')
      }
      if (placed.status === 'unanswered') throw serviceError(placed.reason ?? 'cancelled', `Compaction summary was not placed: ${placed.reason ?? 'cancelled'}`)
      return { status: placed.status, ...(placed.reason === undefined ? {} : { reason: placed.reason }) }
    } finally {
      cancelled?.()
    }
  }

  async #compactRegion(start, end, target, signal) {
    const id = String(target?.session?.id ?? target?.id ?? target)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new TypeError('Compaction range must use integer event sequences')
    if (signal?.aborted) throw serviceError('cancelled', signal.reason?.message ?? 'Compaction cancelled')
    const resolved = await this.#resolveAgent(id)
    if ('error' in resolved) throw serviceError('session/not-found', `Conversation ${id} does not exist`)
    const state = this.#sessionStates.get(id)
    const surface = state.events
      .map(record => record.event)
      .filter(event => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result')
    const startIndex = surface.findIndex(event => event.seq === start)
    const endIndex = surface.findIndex(event => event.seq === end)
    if (startIndex < 0) throw new Error(`compactRegion: start seq ${start} not found in surface`)
    if (endIndex < 0) throw new Error(`compactRegion: end seq ${end} not found in surface`)
    if (startIndex > endIndex) throw new Error(`compactRegion: start seq ${start} is after end seq ${end} on the surface`)
    const selected = surface.slice(startIndex, endIndex + 1)
    const selectedSeqs = new Set(selected.map(event => event.seq))
    const callOwners = new Map()
    const results = new Map()
    for (const event of surface) {
      if (event.type === 'tool/call') {
        callOwners.set(String(event.data.callId), event.seq)
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message.content ?? []) if (block.type === 'toolCall') callOwners.set(String(block.id), event.seq)
      } else if (event.type === 'tool/result') {
        results.set(String(event.data.message.toolCallId), event.seq)
      }
    }
    for (const event of selected) {
      if (event.type === 'tool/call' && !selectedSeqs.has(results.get(String(event.data.callId)))) {
        throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message.content ?? []) {
          if (block.type !== 'toolCall' || selectedSeqs.has(results.get(String(block.id)))) continue
          throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
        }
      } else if (event.type === 'tool/result' && !selectedSeqs.has(callOwners.get(String(event.data.message.toolCallId)))) {
        throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
      }
    }
    const entryIds = [...new Set(selected.map(event => String(event.entryId)))]
    const view = await this.harness.context(id)
    const selectedEntries = entryIds.map(entryId => view.entries.find(entry => String(entry.id) === entryId))
    if (selectedEntries.some(entry => entry === undefined)) throw new Error('compactRegion: selected surface changed before compaction began')
    const selectedMessages = new Set()
    for (const entryId of entryIds) {
      const at = view.entries.findIndex(entry => String(entry.id) === entryId)
      for (const message of view.contributions[at] ?? []) selectedMessages.add(message)
    }
    const messages = view.messages.filter(message => selectedMessages.has(message))
    const taskId = await this.harness.compactRange(id, {
      startSeq: start,
      endSeq: end,
      shadowedSeqs: selected.map(event => event.seq),
      shadowedEntryIds: selectedEntries.map(entry => entry.id),
      tailEntryId: view.entries.at(-1).id,
      entries: selectedEntries,
      messages: messages.length > 0 ? messages : selectedEntries.flatMap(entry => entry.model ?? []),
      firstKept: end + 1,
      reason: 'manual',
    })
    let cancelled
    const cancellation = signal === undefined ? undefined : new Promise(resolve => {
      const stop = () => resolve({ cancelled: signal.reason ?? new Error('Compaction cancelled') })
      signal.addEventListener('abort', stop, { once: true })
      cancelled = () => signal.removeEventListener('abort', stop)
    })
    try {
      const settled = cancellation === undefined
        ? await this.harness.waitForTask(taskId)
        : await Promise.race([this.harness.waitForTask(taskId), cancellation])
      if (settled?.cancelled !== undefined) {
        await this.harness.abortTask(taskId)
        throw serviceError('cancelled', settled.cancelled?.message ?? 'Compaction cancelled')
      }
      const outcome = settled.state.outcome
      if (outcome.status === 'failed') throw new Error(outcome.error.message)
      if (outcome.status !== 'completed') throw serviceError('cancelled', 'Compaction cancelled')
      return outcome.result
    } finally {
      cancelled?.()
    }
  }

  async #beforeCompact(input, api, context) {
    const memoName = 'ds-bot-owned-compaction'
    let decision = await api.memo(memoName, context)
    await this.#hostRuntime?.load?.()
    if (decision === undefined) {
      const resolved = await this.#resolveAgent(String(api.conversationId))
      if ('error' in resolved) return this.#hostRuntime?.isBotSession?.(String(api.conversationId)) === true ? { decline: true } : undefined
      const service = this.#services.get('compaction')
      const value = await service.beforeCompact({
        messages: input.messages,
        entries: input.entries,
        firstKept: input.firstKept,
        reason: input.reason,
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      }, resolved.agent, context.abortSignal)
      const summary = compactionSummary(value)
      const rawUsages = Array.isArray(value?.usages)
        ? value.usages
        : value?.usage === undefined ? [] : [{ provider: value.provider, model: value.model, usage: value.usage }]
      const usages = rawUsages.flatMap(item => {
        const usage = piUsage(item?.usage)
        return usage === undefined || item?.provider === undefined || item?.model === undefined
          ? []
          : [{ provider: String(item.provider), model: String(item.model), usage }]
      })
      decision = value?.decline === true
        ? { kind: 'decline', usages }
        : summary === ''
          ? { kind: 'delegate', usages }
          : {
              kind: 'summary',
              summary,
              usages,
            }
      decision = await api.memo(memoName, decision, context)
    }
    for (const [index, item] of (decision.usages ?? []).entries()) {
      await this.harness.recordCompactionUsage(String(api.conversationId), `${api.taskId}:${index}`, item.provider, item.model, item.usage)
    }
    if (decision.kind === 'decline') return { decline: true }
    if (decision.kind !== 'summary') return undefined
    return { summary: decision.summary }
  }

  async #summarizeRange(input, api) {
    await this.#hostRuntime?.load?.()
    const resolved = await this.#resolveAgent(String(api.conversationId))
    if ('error' in resolved) return { kind: 'failed', message: `Conversation ${api.conversationId} does not exist` }
    const service = this.#services.get('compaction')
    let value
    try {
      value = await service.summarize(input, resolved.agent, api.signal)
    } catch (error) {
      return { kind: 'failed', message: error?.message ?? String(error) }
    }
    const summary = compactionSummary(value)
    if (summary === '') return { kind: 'failed', message: 'Range compaction produced no summary' }
    const rawUsages = Array.isArray(value?.usages)
      ? value.usages
      : value?.usage === undefined ? [] : [{ provider: value.provider, model: value.model, usage: value.usage }]
    for (const [index, item] of rawUsages.entries()) {
      const usage = piUsage(item?.usage)
      if (usage !== undefined && item?.provider !== undefined && item?.model !== undefined) {
        await this.harness.recordCompactionUsage(String(api.conversationId), `${api.taskId}:${index}`, String(item.provider), String(item.model), usage)
      }
    }
    return { kind: 'summary', summary }
  }

  async #prompt({ sessionId, requestId = randomUUID(), mode, content, references = [] }) {
    const whenBusy = mode === 'steer' ? 'steer' : 'followUp'
    const configured = this.#sessionStates.get(String(sessionId))?.config
    const model = configured?.provider === undefined || configured?.model === undefined ? undefined : this.harness.models.getModel?.(configured.provider, configured.model)
    const receipt = textContent(content)
    const keptReferences = Array.isArray(references) ? references.map(reference => ({
      sessionId: String(reference.sessionId),
      label: String(reference.label),
      text: String(reference.text),
    })) : []
    const referenceText = keptReferences.map(reference => reference.text).filter(Boolean).join('\n\n')
    const modelContent = await inputContent({ content }, this.get('attachments'), model === undefined || (model.input ?? []).includes('image'))
    const submission = await this.harness.submit(sessionId, {
      content: referenceText === '' ? modelContent : [...modelContent, { type: 'text', text: referenceText }],
      requestId,
      whenBusy,
      entry: {
        kind: INPUT_KIND,
        data: {
          source: { kind: 'user', requestId }, requestId, content: receipt,
          ...(keptReferences.length === 0 ? {} : { references: keptReferences }),
        },
      },
    })
    return { submissionId: submission.id }
  }

  async #selectModel({ sessionId, provider, model, reasoningEffort }) {
    await this.harness.resolveAdapterModel(provider, model)
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
    const id = String(sessionId)
    const state = this.#sessionStates.get(id)
    if (state !== undefined) {
      await this.#refreshProjectionState(id, state)
      return state.projections
    }
    const entries = await this.#allEntries(id)
    const context = await this.harness.context(id)
    const configured = await this.harness.agent(id)
    const watch = await this.harness.watch(id, { min: 1, max: 1 })
    try {
      return this.#projectionValues(entries, watch.value.docs?.['pi.usage'], context.messages, configured)
    } finally {
      await watch.stop()
    }
  }

  #projectionValues(entries, usage, messages, configured) {
    const records = eventRecords(entries)
    if (records.length === 0) return { asOfSeq: -1, values: {} }
    const turns = records.filter(record => record.event.type === 'turn/end').length
    const model = configured?.model === undefined ? undefined : this.harness.models.getModel?.(configured.model.provider, configured.model.modelId)
    const pressureTokens = estimateContextTokens(messages).tokens
    return {
      asOfSeq: records.at(-1).event.seq,
      values: {
        sessionStats: { turns },
        tokenUsage: tokenUsageOf(usage),
        contextPressure: model?.contextWindow > 0 ? { pressureTokens, contextWindow: model.contextWindow } : {},
        turnOutline: records.filter(record => record.event.type === 'turn/start').map(record => record.event.data.turn),
      },
    }
  }

  async #refreshProjectionState(id, state) {
    const context = await this.harness.context(id)
    const configured = await this.harness.agent(id)
    state.projections = this.#projectionValues(state.entries, state.view.docs?.['pi.usage'], context.messages, configured)
  }

  #projectionState(session, key) {
    const id = String(session?.id ?? session)
    const builtIn = this.#sessionStates.get(id)?.projections?.values?.[key]
    if (builtIn !== undefined) return builtIn
    const definition = this.#projectionDefinitions.get(key)
    if (definition === undefined || session?.snapshotEvents === undefined) return undefined
    let state = definition.init(session.header, session.inheritedEventCount)
    for (const event of session.snapshotEvents()) state = definition.apply(state, event)
    return state
  }

  #projectionSnapshot(session, keys) {
    const id = String(session?.id ?? session)
    const current = this.#sessionStates.get(id)?.projections ?? { asOfSeq: -1, values: {} }
    const values = Object.fromEntries((keys ?? Object.keys(current.values)).flatMap(key => {
      const value = this.#projectionState(session, key)
      return value === undefined ? [] : [[key, value]]
    }))
    return { asOfSeq: current.asOfSeq, values }
  }

  async #list({ limit, order = 'ascending', includeActivity = false } = {}) {
    const items = []
    let cursor
    const maximum = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : Number.MAX_SAFE_INTEGER
    do {
      const page = await this.harness.scanConversations({ order }, Math.min(256, maximum - items.length), cursor)
      for (const conversation of page.items) {
        const sessionId = String(conversation.id)
        if (this.#archived.has(sessionId)) continue
        const projections = await this.#projections({ sessionId })
        let activity
        if (includeActivity) {
          const page = await this.#page({ sessionId, maxMessages: 1 })
          const event = page.records.at(-1)?.event
          activity = { blank: event === undefined, ...(event?.time === undefined ? {} : { updatedAt: event.time }) }
        }
        items.push({
          sessionId,
          title: this.#titles.get(sessionId),
          origin: conversation.owner === undefined ? 'session' : 'subagent',
          projections: { kind: 'sequenced', ...projections },
          ...activity,
        })
        if (items.length >= maximum) break
      }
      cursor = page.next
    } while (cursor !== undefined && items.length < maximum)
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

  #toolRecords(agent) {
    if (agent === undefined) return new Map(this.#tools)
    const id = String(agent.id ?? agent.session?.id)
    const state = this.#sessionStates.get(id)
    if (state === undefined) return new Map()
    const selected = this.#selectedExtensions.get(id) ?? new Map()
    const records = new Map()
    for (const [name, record] of this.#tools) {
      if (selected.has(record.extension.name)) records.set(name, record)
    }
    for (const [name, record] of state.tools) records.set(name, record)
    return records
  }

  #toolSchemas(agent) {
    const state = agent === undefined ? undefined : this.#sessionStates.get(String(agent.id ?? agent.session?.id))
    return [...this.#toolRecords(agent)]
      .filter(([name]) => !state?.restrictions.has(name))
      .map(([, item]) => ({ name: item.definition.name, description: item.definition.description, parameters: legacyParameters(item.definition.parameters) }))
  }

  #restrictTools(id, state, filter) {
    const names = [...new Set(filter?.deny ?? [])]
    const records = this.#toolRecords({ id })
    for (const name of names) {
      const record = records.get(name)
      if (record === undefined) throw new Error(`Tool ${String(name)} is not available in this session`)
      const held = state.restrictions.get(name)
      if (held === undefined) state.restrictions.set(name, { count: 1, tool: record.tool })
      else held.count += 1
    }
    this.#applyToolRestrictions(id, state)
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const name of names) {
        const held = state.restrictions.get(name)
        if (held === undefined) continue
        held.count -= 1
        if (held.count === 0) state.restrictions.delete(name)
      }
      return this.#applyToolRestrictions(id, state)
    }
  }

  #applyToolRestrictions(id, state) {
    const remove = [...state.restrictions.values()].map(entry => entry.tool)
    return this.#configure(id, { tools: remove.length === 0 ? null : { remove } })
  }

  #createDefinitionRecord(definition, extensionName) {
    const tool = defineTool({
      name: definition.name,
      description: definition.description ?? definition.name,
      parameters: legacyParameters(definition.parameters),
      replay: definition.replay === 'safe' ? 'safe' : 'unsafe',
      ...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
      ...(definition.structuredOutputSchema === undefined ? {} : { structuredOutputSchema: definition.structuredOutputSchema }),
      ...(definition.outputLimits === undefined ? {} : { outputLimits: definition.outputLimits }),
      execute: async (args, api, context) => {
        const resolved = await this.#resolveAgent(String(api.conversationId))
        if ('error' in resolved) throw new Error(resolved.error.message)
        if (this.#sessionStates.get(String(api.conversationId))?.restrictions.has(definition.name)) {
          return { output: [{ type: 'text', text: `Tool ${definition.name} is not available in this session` }], isError: true }
        }
        await this.#waitForToolCall(String(api.conversationId), api.callId, context.abortSignal)
        let terminate = false
        const exec = {
          agent: resolved.agent,
          name: definition.name,
          ownedNative: definition.ownedNative === true,
          ownedSchedule: definition.ownedSchedule === true,
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
        render: async input => {
          const text = typeof section.text === 'function'
            ? await section.text({ agent: this.#agents.get(String(input.conversationId)) })
            : section.text
          return typeof text === 'string' && text !== '' ? text : undefined
        },
      }))
    this.#promptExtension = defineExtension({ name: 'ds-bot-system-prompt', sections })
    this.#removePromptExtension = this.harness.install(this.#promptExtension)
  }

  #displayEvent(event) {
    if (event.type === 'user/message') {
      const attachments = event.data.content.filter(block => (block.type === 'image' || block.type === 'file') && block.attachment !== undefined)
      return [{
        kind: 'user',
        text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
        ...(attachments.length === 0 ? {} : { attachments, images: attachments.filter(block => block.type === 'image').length }),
        ...(Array.isArray(event.data.referenceLabels) && event.data.referenceLabels.length > 0 ? { referenceLabels: event.data.referenceLabels } : {}),
        time: event.time,
        seq: event.seq,
      }]
    }
    if (event.type === 'assistant/message') return event.data.message.content.filter(block => block.type === 'text').map(block => ({ kind: 'bot', text: block.text, time: event.time, seq: event.seq, turn: event.data.turn }))
    return []
  }

  #llmService() {
    const models = this.harness.models
    const adapterModels = provider => this.harness.listAdapterModels(provider)
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
      listModels: async provider => {
        const listed = await adapterModels(provider)
        return listed === undefined ? (models.getModels?.(provider) ?? []).map(modelInfo) : listed
      },
      resolveModelInfo: async (provider, model) => {
        const adapted = await this.harness.resolveAdapterModel(provider, model)
        if (adapted !== undefined) return adapted
        const found = models.getModel?.(provider, model)
        if (found === undefined) throw new Error(`Unknown model ${provider}/${model}`)
        return modelInfo(found)
      },
      listConfigurableProviders: () => {
        const adapterProviders = new Set(this.harness.adapterProviders().map(provider => provider.id))
        return models.getProviders?.()
          .filter(provider => !adapterProviders.has(provider.id))
          .map(provider => ({ provider: provider.id, name: provider.name })) ?? []
      },
      discoverModels: async (_kind, request) => (models.getModels?.(request?.provider) ?? []).map(modelInfo),
      registerAdapter: (routes, adapter) => {
        const registration = this.harness.registerAdapter(routes, adapter)
        const changed = () => this.emit('llm/adapters-updated')
        const dispose = () => { registration(); changed() }
        dispose.replace = next => { registration.replace(next); changed() }
        changed()
        return dispose
      },
      script: (id, respond) => this.harness.scriptModel(id, respond),
      beforeRequest: transform => this.harness.beforeRequest(transform),
      stream: options => this.#llmMiddleware(options, () => rawStream(options)),
    }
  }

}
