import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { createRegistry, defineDoc, defineExtension, GenerationTask, Harness, hook, UsageDoc } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { linesFor } from '../host/steward.js'
import { createModelBridge } from './model-bridge.js'
import { OwnedRangeCompactionTask } from './owned-range-compaction.js'

const numericId = id => {
  const value = Number(id)
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid conversation id: ${String(id)}`)
  return value
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const isGenerationControl = value => value?.kind === 'complete' || value?.kind === 'reject'

const CompactionUsageDoc = defineDoc({
  kind: 'ds-bot.compaction-usage',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ tasks: [] }),
  checkpointWhen: () => true,
})

function addUsage(total, usage) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) total[key] += usage[key]
  for (const key of ['cacheWrite1h', 'reasoning']) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) total.cost[key] += usage.cost[key]
}

function ownedCompactionPolicy(models) {
  return {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 16_384,
    backgroundTokens: 32_768,
    get modelOverrides() {
      const overrides = {}
      for (const provider of models.getProviders?.() ?? []) {
        for (const model of models.getModels?.(provider.id) ?? []) {
          if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) continue
          const lines = linesFor({ window: model.contextWindow, reserve: model.maxTokens })
          overrides[`${model.provider}/${model.id}`] = {
            enabled: true,
            reserveTokens: model.contextWindow - lines.hard,
            keepRecentTokens: Math.min(16_384, Math.max(1, lines.check)),
            backgroundTokens: Math.max(0, lines.hard - lines.check),
          }
        }
      }
      return overrides
    },
  }
}

function controlledStream(model, control) {
  const stream = createAssistantMessageEventStream()
  const rejected = control.kind === 'reject'
  const message = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    usage: ZERO_USAGE,
    stopReason: rejected ? 'aborted' : 'stop',
    timestamp: Date.now(),
    ...(rejected ? { errorMessage: control.reason ?? 'Model step rejected before provider request' } : {}),
  }
  queueMicrotask(() => {
    stream.push(rejected
      ? { type: 'error', reason: 'aborted', error: message }
      : { type: 'done', reason: 'stop', message })
  })
  return stream
}

export class OwnedHarness {
  #harness
  #models
  #registry
  #context
  #modelBridge
  #requestTransforms
  #generationTransforms
  #environment
  #streamBoundary

  constructor(harness, models, registry, context, modelBridge, requestTransforms, generationTransforms, environment, streamBoundary) {
    this.#harness = harness
    this.#models = models
    this.#registry = registry
    this.#context = context
    this.#modelBridge = modelBridge
    this.#requestTransforms = requestTransforms
    this.#generationTransforms = generationTransforms
    this.#environment = environment
    this.#streamBoundary = streamBoundary
  }

  static async open({ dataDir, database = join(dataDir, 'runtime.sqlite'), models, registry = createRegistry(), context = BACKGROUND_CONTEXT, settings, env }) {
    await mkdir(dirname(database), { recursive: true })
    const runtime = models ?? await ModelRuntime.create({
      authPath: join(dataDir, 'auth.json'),
      modelsPath: join(dataDir, 'models.json'),
      refreshOnCreate: false,
    })
    const storage = await openNodeSqliteStorage(database)
    const requestTransforms = new Set()
    const generationTransforms = new Set()
    const messageOwners = new WeakMap()
    const generationControls = new Map()
    const streamBoundary = { run: undefined }
    const bridge = createModelBridge(runtime, async (request) => {
      const conversationId = request.messages?.map(message => messageOwners.get(message)).find(id => id !== undefined)
      let messages = request.messages
      for (const transform of requestTransforms) {
        const next = await transform(messages, {
          conversationId,
        })
        if (next !== undefined) messages = next
      }
      if (conversationId !== undefined) {
        for (const message of messages ?? []) {
          if (message !== null && typeof message === 'object') messageOwners.set(message, conversationId)
        }
      }
      return messages === request.messages ? request : { ...request, messages }
    }, (model, request, options, next) => {
      const conversationId = request.messages?.map(message => messageOwners.get(message)).find(id => id !== undefined)
      const control = conversationId === undefined ? undefined : generationControls.get(conversationId)
      if (control !== undefined) {
        generationControls.delete(conversationId)
        return controlledStream(model, control)
      }
      const terminal = () => next(conversationId === undefined ? {} : { sessionId: conversationId })
      return streamBoundary.run?.(model, request, options, terminal, { conversationId }) ?? terminal()
    })
    const generationPolicy = defineExtension({
      name: 'ds-bot-generation-policy',
      hooks: [hook(GenerationTask, {
        beforeRequest: async (request, api) => {
          const conversationId = String(api.conversationId)
          generationControls.delete(conversationId)
          let messages = request.messages
          for (const transform of generationTransforms) {
            const next = await transform(messages, { conversationId })
            if (isGenerationControl(next)) {
              generationControls.set(conversationId, next)
              break
            }
            if (next !== undefined) messages = next
          }
          for (const message of new Set([...(request.messages ?? []), ...(messages ?? [])])) {
            if (message !== null && typeof message === 'object') messageOwners.set(message, conversationId)
          }
          return messages === request.messages ? undefined : { messages }
        },
      })],
    })
    for (const extension of settings?.extensions ?? []) registry.install(extension)
    registry.install(generationPolicy)
    const extensions = [...(settings?.extensions ?? []), generationPolicy]
    const compaction = settings?.compaction ?? ownedCompactionPolicy(bridge.models)
    const environment = { shellEnv: undefined }
    const harness = await Harness.open(storage, {
      models: bridge.models,
      registry,
      settings: { ...settings, compaction, extensions },
      env: env ?? (target => new NodeExecutionEnv({
        cwd: target.cwd ?? process.cwd(),
        shellEnv: environment.shellEnv?.(target),
      })),
    }, context)
    return new OwnedHarness(harness, bridge.models, registry, context, bridge, requestTransforms, generationTransforms, env === undefined ? environment : undefined, streamBoundary)
  }

  get models() { return this.#models }

  scriptModel(id, respond) { return this.#modelBridge.script(id, respond) }

  registerAdapter(routes, adapter) { return this.#modelBridge.registerAdapter(routes, adapter) }

  adapterProviders() { return this.#modelBridge.adapterProviders() }

  listAdapterModels(provider) { return this.#modelBridge.listAdapterModels(provider) }

  resolveAdapterModel(provider, model) { return this.#modelBridge.resolveAdapterModel(provider, model) }

  beforeRequest(transform) {
    this.#requestTransforms.add(transform)
    return () => this.#requestTransforms.delete(transform)
  }

  beforeGeneration(transform) {
    this.#generationTransforms.add(transform)
    return () => this.#generationTransforms.delete(transform)
  }

  setShellEnvironment(resolve) {
    if (this.#environment !== undefined) this.#environment.shellEnv = resolve
  }

  setStreamInterceptor(intercept) { this.#streamBoundary.run = intercept }

  install(extension) {
    this.#registry.install(extension)
    return () => this.#registry.uninstall(extension)
  }

  resume() { this.#harness.resume() }

  commit(change, options) { return this.#harness.commit(change, this.#context, options) }

  snapshot(token) { return this.#harness.snapshot(token, this.#context) }

  getTask(id) { return this.#harness.getTask(id, this.#context) }

  scanTasks(query = {}, limit = 100, cursor) { return this.#harness.commit(tx => tx.scanTasks(query, limit, cursor), this.#context) }

  abortTask(id) { return this.#harness.abortTask(id, this.#context) }

  async createConversation(agent) {
    const conversation = await this.#harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, this.#context)
    return String(conversation.id)
  }

  async conversation(id) {
    return this.#harness.conversation(numericId(id), this.#context)
  }

  async submit(id, { content, requestId, whenBusy = 'followUp', entry }) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    const submission = await conversation.submit({ type: 'input', content, requestId, whenBusy, ...(entry === undefined ? {} : { entry }) }, this.#context)
    return {
      id: String(submission.id),
      wait: () => submission.wait(this.#context),
    }
  }

  async entries(id, { limit = 100, cursor, order = 'ascending', minEntryId, maxEntryId } = {}) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    return conversation.entries({ order, ...(minEntryId === undefined ? {} : { minEntryId }), ...(maxEntryId === undefined ? {} : { maxEntryId }) }, limit, cursor, this.#context)
  }

  async context(id) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    return conversation.context(this.#context)
  }

  async compact(id, instructions) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    return conversation.compact(instructions, this.#context)
  }

  compactRange(id, input) {
    return this.commit(tx => tx.createTask(OwnedRangeCompactionTask, input, {
      ownership: { kind: 'conversation' },
      conversationId: numericId(id),
    }))
  }

  async recordCompactionUsage(id, taskId, provider, model, usage) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    const conversationId = numericId(id)
    return conversation.commit(async tx => {
      const ledger = await tx.doc(CompactionUsageDoc, conversationId)
      const key = String(taskId)
      if (ledger.tasks.includes(key)) return false
      ledger.tasks.push(key)
      const models = (await tx.doc(UsageDoc, conversationId)).models
      const modelKey = `${provider}/${model}`
      const total = Object.hasOwn(models, modelKey) ? models[modelKey] : undefined
      if (total === undefined) Object.defineProperty(models, modelKey, { value: structuredClone(usage), enumerable: true, writable: true })
      else addUsage(total, usage)
      return true
    }, this.#context)
  }

  waitForTask(id) { return this.#harness.waitForTask(id, this.#context) }

  async waitForSubmission(id) {
    const submission = await this.#harness.submission(id, this.#context)
    if (submission === undefined) throw new Error(`Submission ${String(id)} does not exist`)
    return submission.wait(this.#context)
  }

  abortSubmission(id, conversationId) { return this.#harness.abortSubmission(id, this.#context, numericId(conversationId)) }

  async configure(id, change) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    await conversation.configure(change, this.#context)
  }

  async agent(id) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    return conversation.agent(this.#context)
  }

  scanConversations(query = {}, limit = 100, cursor) {
    return this.#harness.commit(tx => tx.scanConversations(query, limit, cursor), this.#context)
  }

  inspect() { return this.#harness.inspect(this.#context) }

  async waitForIdle(id) {
    const conversation = await this.conversation(id)
    if (conversation !== undefined) await conversation.waitForIdle(this.#context)
  }

  async watch(id, window) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    return conversation.watch(this.#context, window)
  }

  async abort(id, options) {
    const conversation = await this.conversation(id)
    if (conversation !== undefined) await conversation.abort(this.#context, options)
  }

  async close() {
    await this.#models.settleCredentialWrites?.()
    await this.#harness.close(this.#context)
  }
}
