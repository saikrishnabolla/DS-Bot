const DRIVER_PREFIX = 'cua_driver_native__'

const objectSchema = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseJson(value, label) {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`Cua Driver returned invalid ${label} JSON`, { cause: error })
  }
}

function inventoryOf(raw) {
  const inventory = parseJson(raw, 'tool inventory')
  if (inventory?.capability_version !== '1' || !Array.isArray(inventory.tools)) {
    throw new Error('Cua Driver returned an unsupported tool inventory')
  }
  const names = new Set()
  for (const tool of inventory.tools) {
    if (typeof tool?.name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(tool.name)) throw new Error('Cua Driver returned an invalid tool name')
    if (names.has(tool.name)) throw new Error(`Cua Driver returned duplicate tool ${tool.name}`)
    if (!objectSchema(tool.inputSchema)) throw new Error(`Cua Driver tool ${tool.name} has no input schema`)
    if (tool.outputSchema !== undefined && !objectSchema(tool.outputSchema)) throw new Error(`Cua Driver tool ${tool.name} has an invalid output schema`)
    names.add(tool.name)
  }
  return inventory
}

async function createDriver() {
  const { CuaDriver } = await import('@trycua/cua-driver')
  return CuaDriver.create({ embedded: true })
}

async function resultOf(result, attachments) {
  const structuredContent = typeof result.structuredJson === 'string'
    ? parseJson(result.structuredJson, 'structured result')
    : undefined
  const output = []
  const content = []
  if (typeof result.text === 'string' && result.text !== '') output.push({ type: 'text', text: result.text })
  for (const image of result.images ?? []) {
    if (typeof image?.dataBase64 !== 'string' || typeof image?.mimeType !== 'string') continue
    output.push({ type: 'image', data: image.dataBase64, mimeType: image.mimeType })
    if (typeof attachments?.saveImage === 'function') {
      const attachment = await attachments.saveImage({ data: Buffer.from(image.dataBase64, 'base64'), mediaType: image.mimeType })
      content.push({ type: 'image', attachment })
    }
  }
  if (output.length === 0 && result.isError === true) {
    output.push({ type: 'text', text: String(result.errorCode ?? 'Computer use failed') })
  }
  return {
    output,
    ...(content.length === 0 ? {} : { content }),
    ...(structuredContent === undefined ? {} : { structuredOutput: structuredContent, structuredContent }),
    ...(result.isError === true ? { isError: true } : {}),
    details: {
      ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode } : {}),
      ...(result.action === undefined ? {} : { action: result.action }),
      ...(result.verification === undefined ? {} : { verification: result.verification }),
      degraded: result.degraded === true,
    },
  }
}

export class OwnedComputerUse {
  #create
  #driver
  #starting
  #definitions = []
  #attachments

  constructor({ driverFactory = createDriver, attachments } = {}) {
    this.#create = driverFactory
    this.#attachments = attachments
  }

  get providerName() { return 'Cua Driver' }

  async start() {
    if (this.#driver !== undefined) return this.#definitions
    this.#starting ??= this.#start()
    try {
      return await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #start() {
    const driver = await this.#create()
    try {
      const inventory = inventoryOf(await driver.listToolsJson())
      const definitions = inventory.tools.map(tool => ({
        name: `${DRIVER_PREFIX}${tool.name}`,
        description: String(tool.description ?? tool.name),
        parameters: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { structuredOutputSchema: tool.outputSchema }),
        execute: async (args, exec) => resultOf(await driver.callTool(tool.name, JSON.stringify(args ?? {}),
          exec?.signal instanceof AbortSignal ? { signal: exec.signal } : undefined), this.#attachments),
      }))
      this.#driver = driver
      this.#definitions = definitions
      return definitions
    } catch (error) {
      await driver.shutdown?.().catch(() => undefined)
      driver.uniffiDestroy?.()
      throw error
    }
  }

  async stop() {
    const starting = this.#starting
    if (starting !== undefined) await starting.catch(() => undefined)
    const driver = this.#driver
    this.#driver = undefined
    this.#definitions = []
    if (driver === undefined) return
    try {
      await driver.shutdown()
    } finally {
      driver.uniffiDestroy?.()
    }
  }
}

export function installOwnedComputerUse(context, { access, ...options } = {}) {
  const service = new OwnedComputerUse({ attachments: context.get?.('attachments'), ...options })
  context.provide('ownedComputerUse', service)
  if (access !== undefined) context.provide('ownedComputerAccess', access)
  context.effect(() => () => service.stop())
  return service
}
