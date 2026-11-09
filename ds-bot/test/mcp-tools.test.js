import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing'
import { connectMcpTools, mcpToolName } from '../src/engine/mcp-tools.js'

async function mcpServer(t, { tools, call }) {
  const pair = createInMemoryTransportPair()
  await pair.server.start()
  const off = pair.server.onMessage(message => {
    if (!('id' in message)) return
    void (async () => {
      if (message.method === 'initialize') {
        await pair.server.send({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1.0.0' } },
        })
      } else if (message.method === 'tools/list') {
        await pair.server.send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      } else if (message.method === 'tools/call') {
        const token = message.params?._meta?.progressToken
        if (token !== undefined) {
          await pair.server.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'Halfway' } })
        }
        const result = await call(message.params)
        if (result?.error) await pair.server.send({ jsonrpc: '2.0', id: message.id, error: result.error })
        else await pair.server.send({ jsonrpc: '2.0', id: message.id, result })
      }
    })()
  })
  t.after(async () => { off(); await pair.server.close() })
  return pair.client
}

test('connects, namespaces tools, forwards schemas, progress and structured results', async t => {
  const transport = await mcpServer(t, {
    tools: [{
      name: 'search-items',
      title: 'Search items',
      description: 'Search the catalog',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
    }],
    call: async ({ name, arguments: args }) => ({
      content: [{ type: 'text', text: `${name}: ${args.query}` }],
      structuredContent: { count: 1 },
      _meta: { source: 'fixture' },
    }),
  })
  const connection = await connectMcpTools({ name: 'research', transport: 'stdio', command: 'unused' }, { transport })
  t.after(() => connection.close())

  assert.deepEqual(connection.serverInfo, { name: 'test-server', version: '1.0.0' })
  assert.equal(connection.tools.length, 1)
  const [tool] = connection.tools
  assert.equal(tool.name, 'mcp__research__search_items')
  assert.equal(tool.parameters.properties.query.type, 'string')
  assert.deepEqual(tool.structuredOutputSchema, { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] })
  assert.equal(tool.replay, 'unsafe')

  const details = []
  const result = await tool.execute({ query: 'Pi' }, { details: async value => { details.push(value) } }, BACKGROUND_CONTEXT)
  assert.deepEqual(details, [{ progress: 1, total: 2, message: 'Halfway' }])
  assert.deepEqual(result, {
    output: [{ type: 'text', text: 'search-items: Pi' }],
    structuredOutput: { count: 1 },
    details: { structuredContent: { count: 1 }, meta: { source: 'fixture' } },
  })

  await Promise.all([connection.close(), connection.close()])
  assert.equal(connection.connectionState, 'closed')
})

test('preserves MCP error outcomes while redacting saved secrets', async t => {
  const headerSecret = 'Bearer header-secret-123'
  const envSecret = 'env-secret-456'
  const transport = await mcpServer(t, {
    tools: [{ name: 'fail', description: `Never print ${headerSecret}`, inputSchema: {} }],
    call: async () => ({ error: { code: -32000, message: `Remote refused ${headerSecret} and ${envSecret}` } }),
  })
  const connection = await connectMcpTools({
    name: 'private', transport: 'stdio', command: 'unused',
    headers: { Authorization: headerSecret }, env: { TOKEN: envSecret },
  }, { transport })
  t.after(() => connection.close())
  const [tool] = connection.tools
  assert.doesNotMatch(tool.description, /header-secret/)
  const result = await tool.execute({}, {}, BACKGROUND_CONTEXT)
  assert.equal(result.isError, true)
  assert.match(result.output[0].text, /\[secret\]/)
  assert.doesNotMatch(JSON.stringify(result), /header-secret|env-secret/)
  assert.equal(result.diagnostics[0].severity, 'error')
})

test('redacts connection errors and closes the failed client', async () => {
  const listeners = { message: new Set(), error: new Set(), close: new Set() }
  let closes = 0
  const transport = {
    async start() { throw new Error('Cannot use top-secret-key') },
    async send() {},
    async close() { closes += 1 },
    onMessage(listener) { listeners.message.add(listener); return () => listeners.message.delete(listener) },
    onError(listener) { listeners.error.add(listener); return () => listeners.error.delete(listener) },
    onClose(listener) { listeners.close.add(listener); return () => listeners.close.delete(listener) },
  }
  await assert.rejects(
    connectMcpTools({ name: 'broken', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'top-secret-key' } }, { transport }),
    error => error.message === 'Cannot use [secret]',
  )
  assert.equal(closes, 1)
})

test('rejects unsafe config and keeps long names deterministic and distinct', async () => {
  await assert.rejects(connectMcpTools({ name: 'Bad Name', transport: 'stdio', command: 'mcp' }), /lowercase letters/)
  await assert.rejects(connectMcpTools({ name: 'valid', transport: 'stdio', command: '' }), /needs a command/)
  await assert.rejects(connectMcpTools({ name: 'valid', transport: 'streamable-http', url: 'file:///tmp/mcp' }), /http or https/)
  const first = mcpToolName('server', `tool-${'a'.repeat(100)}`)
  const second = mcpToolName('server', `tool-${'b'.repeat(100)}`)
  assert.equal(first.length, 64)
  assert.equal(second.length, 64)
  assert.notEqual(first, second)
  assert.equal(first, mcpToolName('server', `tool-${'a'.repeat(100)}`))
})
