import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry, defineExtension, GenerationTask, Harness, hook } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModelBridge } from './model-bridge.js'

const numericId = id => {
  const value = Number(id)
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid conversation id: ${String(id)}`)
  return value
}

export class OwnedHarness {
  #harness
  #models
  #registry
  #context
  #scriptModel
  #requestTransforms
  #generationTransforms
  #environment
  #streamBoundary

  constructor(harness, models, registry, context, scriptModel, requestTransforms, generationTransforms, environment, streamBoundary) {
    this.#harness = harness
    this.#models = models
    this.#registry = registry
    this.#context = context
    this.#scriptModel = scriptModel
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
      return messages === request.messages ? request : { ...request, messages }
    }, (model, request, options, next) => streamBoundary.run?.(model, request, options, next, {
      conversationId: request.messages?.map(message => messageOwners.get(message)).find(id => id !== undefined),
    }) ?? next())
    const generationPolicy = defineExtension({
      name: 'ds-bot-generation-policy',
      hooks: [hook(GenerationTask, {
        beforeRequest: async (request, api) => {
          let messages = request.messages
          for (const transform of generationTransforms) {
            const next = await transform(messages, { conversationId: String(api.conversationId) })
            if (next !== undefined) messages = next
          }
          for (const message of messages) {
            if (message !== null && typeof message === 'object') messageOwners.set(message, String(api.conversationId))
          }
          return messages === request.messages ? undefined : { messages }
        },
      })],
    })
    registry.install(generationPolicy)
    const extensions = [...(settings?.extensions ?? []), generationPolicy]
    const environment = { shellEnv: undefined }
    const harness = await Harness.open(storage, {
      models: bridge.models,
      registry,
      settings: { ...settings, extensions },
      env: env ?? (target => new NodeExecutionEnv({
        cwd: target.cwd ?? process.cwd(),
        shellEnv: environment.shellEnv?.(target),
      })),
    }, context)
    return new OwnedHarness(harness, bridge.models, registry, context, bridge.script, requestTransforms, generationTransforms, env === undefined ? environment : undefined, streamBoundary)
  }

  get models() { return this.#models }

  scriptModel(id, respond) { return this.#scriptModel(id, respond) }

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
