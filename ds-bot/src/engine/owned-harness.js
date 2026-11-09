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
  #context

  constructor(harness, models, context) {
    this.#harness = harness
    this.#models = models
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
    return new OwnedHarness(harness, runtime, context)
  }

  get models() { return this.#models }

  resume() { this.#harness.resume() }

  async createConversation(agent) {
    const conversation = await this.#harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, this.#context)
    return String(conversation.id)
  }

  async conversation(id) {
    return this.#harness.conversation(numericId(id), this.#context)
  }

  async submit(id, { content, requestId, whenBusy = 'followUp' }) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    const submission = await conversation.submit({ type: 'input', content, requestId, whenBusy }, this.#context)
    return {
      id: String(submission.id),
      wait: () => submission.wait(this.#context),
    }
  }

  async entries(id, { limit = 100, cursor, order = 'ascending' } = {}) {
    const conversation = await this.conversation(id)
    if (conversation === undefined) throw new Error(`Conversation ${String(id)} does not exist`)
    return conversation.entries({ order }, limit, cursor, this.#context)
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
