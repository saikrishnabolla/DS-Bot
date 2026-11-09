import { createHash } from 'node:crypto'
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp'

const SERVER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_TOOL_NAME = 64

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

function serverIdOf(config) {
  const id = String(config?.serverName ?? config?.name ?? '').trim()
  if (!SERVER_ID.test(id)) throw invalid('An MCP server name uses lowercase letters, digits and single hyphens')
  return id
}

function secretValues(config) {
  const headers = Object.values(config?.headers ?? {}).filter(value => typeof value === 'string')
  const authorizationParts = headers.flatMap(value => value.split(/\s+/).filter(part => part.length >= 4 && !/^(?:bearer|basic)$/i.test(part)))
  return [...headers, ...authorizationParts, ...Object.values(config?.env ?? {})]
    .filter(value => typeof value === 'string' && value !== '')
    .sort((left, right) => right.length - left.length)
}

function redactText(value, secrets) {
  let text = String(value ?? '')
  for (const secret of secrets) text = text.split(secret).join('[secret]')
  return text
}

function redactValue(value, secrets, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value, secrets)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(entry => redactValue(entry, secrets, seen))
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets, seen)]))
}

function safeError(error, secrets) {
  const message = redactText(error?.message ?? error, secrets)
  return Object.assign(new Error(message || 'MCP request failed'), { code: error?.code ?? 'MCP_ERROR' })
}

function normalizedToolPart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

function namespacedToolName(serverId, toolName) {
  const full = `mcp__${normalizedToolPart(serverId)}__${normalizedToolPart(toolName)}`
  if (full.length <= MAX_TOOL_NAME) return full
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
  return `${full.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`
}

function parametersOf(tool) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema : {}
  return { ...schema, type: 'object', properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {} }
}

function transportFor(config, options) {
  if (options.transport !== undefined) return options.transport
  if (config.transport === 'stdio') {
    const command = String(config.command ?? '').trim()
    if (command === '') throw invalid('An MCP stdio server needs a command')
    return new StdioTransport({
      command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      ...(typeof config.cwd === 'string' && config.cwd !== '' ? { cwd: config.cwd } : {}),
      env: Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, String(value)])),
      inheritEnv: config.inheritEnv !== false,
      stderr: 'pipe',
    })
  }
  if (config.transport === 'streamable-http') {
    let url
    try { url = new URL(String(config.url ?? '')) } catch { throw invalid('An MCP HTTP server needs a valid URL') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('An MCP HTTP server needs an http or https URL')
    return new StreamableHttpTransport({
      url,
      headers: Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, String(value)])),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  }
  throw invalid('An MCP server transport must be stdio or streamable-http')
}

function detailsOf(result, secrets) {
  const details = {}
  if (result.structuredContent !== undefined) details.structuredContent = redactValue(result.structuredContent, secrets)
  if (result._meta !== undefined) details.meta = redactValue(result._meta, secrets)
  return Object.keys(details).length === 0 ? undefined : details
}

function registrationOf(serverId, tool, client, secrets) {
  const registration = {
    name: namespacedToolName(serverId, tool.name),
    description: typeof tool.description === 'string' && tool.description.trim() !== ''
      ? redactText(tool.description, secrets)
      : `Call ${tool.title ?? tool.name} on the ${serverId} MCP server.`,
    parameters: parametersOf(tool),
    replay: 'unsafe',
    async execute(args, api, context) {
      let progress = Promise.resolve()
      try {
        const result = await client.callTool(tool.name, args, {
          signal: context?.abortSignal,
          onProgress: update => {
            if (typeof api?.details !== 'function') return
            const next = redactValue({ progress: update.progress, ...(update.total === undefined ? {} : { total: update.total }), ...(update.message === undefined ? {} : { message: update.message }) }, secrets)
            progress = progress.then(() => api.details(next, context)).catch(() => undefined)
          },
        })
        await progress
        const structured = result.structuredContent === undefined ? undefined : redactValue(result.structuredContent, secrets)
        return {
          output: redactValue(toLlmContent(result), secrets),
          ...(structured === undefined ? {} : { structuredOutput: structured }),
          ...(detailsOf(result, secrets) === undefined ? {} : { details: detailsOf(result, secrets) }),
          ...(result.isError === true ? { isError: true } : {}),
        }
      } catch (error) {
        await progress
        const safe = safeError(error, secrets)
        return {
          output: [{ type: 'text', text: safe.message }],
          isError: true,
          diagnostics: [{ severity: 'error', message: safe.message, code: String(safe.code) }],
        }
      }
    },
  }
  if (tool.outputSchema && typeof tool.outputSchema === 'object' && !Array.isArray(tool.outputSchema)) {
    registration.structuredOutputSchema = tool.outputSchema
  }
  return registration
}

export class McpToolConnection {
  #client
  #closed

  constructor(client, tools, serverInfo) {
    this.#client = client
    this.tools = tools
    this.serverInfo = serverInfo
  }

  get connectionState() { return this.#client.connectionState }

  close() {
    return this.#closed ??= this.#client.close()
  }
}

export async function connectMcpTools(config, options = {}) {
  const serverId = serverIdOf(config)
  const secrets = secretValues(config)
  const client = options.client ?? new McpClient({
    name: `ds-bot-${serverId}`,
    version: options.version ?? '0.3.2',
    ...(options.roots === undefined ? {} : { roots: options.roots }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  })
  try {
    await client.connect(transportFor(config, options))
    const remote = await client.listTools()
    const names = new Set()
    const tools = remote.map(tool => {
      const registration = registrationOf(serverId, tool, client, secrets)
      if (names.has(registration.name)) throw new Error(`MCP tools collide after namespacing: ${registration.name}`)
      names.add(registration.name)
      return registration
    })
    return new McpToolConnection(client, tools, client.serverInfo)
  } catch (error) {
    await client.close().catch(() => undefined)
    throw safeError(error, secrets)
  }
}

export const mcpToolName = namespacedToolName
