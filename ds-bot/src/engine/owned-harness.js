import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

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

  constructor(harness, models, registry, context) {
    this.#harness = harness
    this.#models = models
    this.#registry = registry
    this.#context = context
  }

  static async open({ dataDir, database = join(dataDir, 'runtime.sqlite'), models, registry = createRegistry(), context = BACKGROUND_CONTEXT, settings, env }) {
    await mkdir(dirname(database), { recursive: true })
    const runtime = models ?? await ModelRuntime.create({
      authPath: join(dataDir, 'auth.json'),
      modelsPath: join(dataDir, 'models.json'),
      refreshOnCreate: false,
    })
    const storage = await openNodeSqliteStorage(database)
    const harness = await Harness.open(storage, {
      models: runtime,
      registry,
      ...(settings === undefined ? {} : { settings }),
      ...(env === undefined ? {} : { env }),
    }, context)
    return new OwnedHarness(harness, runtime, registry, context)
  }

  get models() { return this.#models }

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
