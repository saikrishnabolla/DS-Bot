import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startOwnedServer } from '../src/server/owned-server.js'

const launchToken = 'launch-token-for-owned-server-tests'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-server-'))
  const uiDir = join(dir, 'ui')
  await mkdir(join(uiDir, 'assets'), { recursive: true })
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Owned UI</title>')
  await writeFile(join(uiDir, 'assets', 'app.js'), 'window.owned = true')
  const listeners = new Set()
  let unsubscribed = false
  const calls = []
  const server = await startOwnedServer({
    uiDir,
    launchToken,
    dispatch: async (endpoint, payload, signal) => {
      calls.push({ endpoint, payload, signal })
      return { ok: true, value: { endpoint, payload } }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribed = true }
    },
    revision: () => 7,
    ...options,
  })
  const publish = (event, data) => { for (const listener of listeners) listener(event, data) }
  const stop = async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
  t.after(stop)
  return { server, calls, publish, unsubscribed: () => unsubscribed }
}

async function authenticate(server) {
  const response = await fetch(server.launchUrl, { redirect: 'manual' })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/')
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  return setCookie.split(';', 1)[0]
}

async function nextEvent(reader, state = { buffer: '' }) {
  const decoder = new TextDecoder()
  for (;;) {
    const end = state.buffer.indexOf('\n\n')
    if (end >= 0) {
      const block = state.buffer.slice(0, end)
      state.buffer = state.buffer.slice(end + 2)
      if (block.startsWith(':')) continue
      const lines = block.split('\n')
      const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
      return { event: field('event'), data: JSON.parse(field('data')) }
    }
    const { value, done } = await reader.read()
    if (done) return undefined
    state.buffer += decoder.decode(value, { stream: true })
  }
}

const rawRequest = (url, options) => new Promise((resolve, reject) => {
  const request = httpRequest(url, options, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
  })
  request.on('error', reject)
  request.end(options.body)
})

test('the launch token is exchanged once for a strict session cookie', async t => {
  const { server } = await fixture(t)
  const unauthenticated = await fetch(server.origin)
  assert.equal(unauthenticated.status, 401)

  const cookie = await authenticate(server)
  const replay = await fetch(server.launchUrl, { redirect: 'manual' })
  assert.equal(replay.status, 401)

  const page = await fetch(server.origin, { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), '<!doctype html><title>Owned UI</title>')
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')

  const asset = await fetch(`${server.origin}/assets/app.js`, { headers: { cookie } })
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(await asset.text(), 'window.owned = true')
})

test('the API preserves the endpoint envelope and limits request bodies', async t => {
  const { server, calls } = await fixture(t, { maxRequestBytes: 128 })
  const cookie = await authenticate(server)
  const response = await fetch(`${server.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ endpoint: 'state', payload: { locale: 'en' } }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, value: { endpoint: 'state', payload: { locale: 'en' } } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal instanceof AbortSignal, true)

  const oversized = await fetch(`${server.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'send', payload: { text: 'x'.repeat(200) } }),
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error.code, 'bot/request-too-large')
  assert.equal(calls.length, 1)
})

test('uploads require authentication and the upload header and have an independent byte limit', async t => {
  const uploads = []
  const { server } = await fixture(t, {
    maxRequestBytes: 32,
    maxUploadBytes: 8,
    upload: async input => {
      uploads.push(input)
      return { attachmentId: `sha256:${'a'.repeat(64)}`, name: input.name, bytes: input.data.length, mediaType: input.mediaType }
    },
  })
  const unauthenticated = await fetch(`${server.origin}/api/bot/upload`, {
    method: 'POST',
    headers: { 'x-dsbot-file-name': 'note.txt', 'x-dsbot-upload': '1' },
    body: 'hello',
  })
  assert.equal(unauthenticated.status, 401)

  const cookie = await authenticate(server)
  const missingHeader = await fetch(`${server.origin}/api/bot/upload`, {
    method: 'POST', headers: { cookie, 'x-dsbot-file-name': 'note.txt' }, body: 'hello',
  })
  assert.equal(missingHeader.status, 403)

  const uploaded = await fetch(`${server.origin}/api/bot/upload`, {
    method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'text/plain', 'x-dsbot-file-name': encodeURIComponent('../note.txt'), 'x-dsbot-upload': '1' },
    body: 'hello',
  })
  assert.equal(uploaded.status, 200)
  assert.equal((await uploaded.json()).value.bytes, 5)
  assert.deepEqual(uploads.map(input => ({ name: input.name, mediaType: input.mediaType, data: input.data.toString() })), [
    { name: '../note.txt', mediaType: 'text/plain', data: 'hello' },
  ])

  const oversized = await fetch(`${server.origin}/api/bot/upload`, {
    method: 'POST',
    headers: { cookie, 'x-dsbot-file-name': 'big.bin', 'x-dsbot-upload': '1' },
    body: '123456789',
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error.code, 'bot/upload-too-large')
  assert.equal(uploads.length, 1)
})

test('approved client plugin modules are authenticated, typed, immutable, and path-bounded', async t => {
  const calls = []
  const fingerprint = 'a'.repeat(64)
  const { server } = await fixture(t, {
    pluginAsset: async input => {
      calls.push(input)
      if (input.fingerprint !== fingerprint || input.path !== 'client/index.mjs') throw new Error('not found')
      return { path: input.path, data: Buffer.from('export default () => {}') }
    },
  })
  const route = `${server.origin}/api/bot/plugin/${fingerprint}/client/index.mjs`
  assert.equal((await fetch(route)).status, 401)

  const cookie = await authenticate(server)
  const response = await fetch(route, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await response.text(), 'export default () => {}')
  assert.deepEqual(calls, [{ fingerprint, path: 'client/index.mjs' }])

  const traversal = await fetch(`${server.origin}/api/bot/plugin/${fingerprint}/%2e%2e/index.mjs`, { headers: { cookie } })
  assert.equal(traversal.status, 404)
  assert.equal(calls.length, 1)
})

test('Host and Origin headers must name the configured server', async t => {
  await assert.rejects(startOwnedServer({
    uiDir: tmpdir(),
    host: '0.0.0.0',
    launchToken,
    dispatch: async () => ({ ok: true }),
  }), /publicOrigin/)
  const { server, calls } = await fixture(t)
  const cookie = await authenticate(server)
  const badOrigin = await fetch(`${server.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, origin: 'https://example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state' }),
  })
  assert.equal(badOrigin.status, 403)

  const badHost = await rawRequest(`${server.origin}/api/bot`, {
    method: 'POST',
    headers: { cookie, host: 'example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state' }),
  })
  assert.equal(badHost.status, 403)
  assert.equal(calls.length, 0)
})

test('the feed sends hello and published events, caps clients, and cleans up', async t => {
  const { server, publish, unsubscribed } = await fixture(t, { maxFeedClients: 1, keepaliveMs: 60_000 })
  const cookie = await authenticate(server)
  const abort = new AbortController()
  const response = await fetch(`${server.origin}/api/bot/feed`, { headers: { cookie }, signal: abort.signal })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = response.body.getReader()
  assert.deepEqual(await nextEvent(reader), { event: 'hello', data: { revision: 7 } })

  publish('revision', { revision: 8 })
  assert.deepEqual(await nextEvent(reader), { event: 'revision', data: { revision: 8 } })

  const second = await fetch(`${server.origin}/api/bot/feed`, { headers: { cookie } })
  assert.equal(second.status, 503)
  assert.equal((await second.json()).error.code, 'bot/feed-limit')

  abort.abort()
  await assert.rejects(reader.read(), error => error.name === 'AbortError')
  await server.close()
  assert.equal(unsubscribed(), true)
})
