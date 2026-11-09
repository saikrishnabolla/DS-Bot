import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const API_ROUTE = '/api/bot'
const FEED_ROUTE = `${API_ROUTE}/feed`
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_FEED_CLIENTS = 32
const DEFAULT_MAX_QUEUED_EVENTS = 512
const DEFAULT_KEEPALIVE_MS = 20_000
const COOKIE = 'dsbot_session'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const json = (response, status, value) => {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

const refusal = (response, status, code, message) => json(response, status, {
  ok: false,
  error: { code, message, details: {} },
})

const sameSecret = (actual, expected) => {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

const cookieValue = (request, name) => {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at >= 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

const requestBody = async (request, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      request.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const eventChunk = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/**
 * Start the loopback HTTP boundary used by the desktop window.
 *
 * `dispatch` receives the existing DS Bot endpoint and payload. `subscribe` receives
 * a listener called as `(event, data)` and returns a disposer.
 */
export async function startOwnedServer({
  dispatch,
  subscribe = () => () => {},
  revision = () => 0,
  uiDir,
  host = DEFAULT_HOST,
  port = 0,
  launchToken = randomBytes(32).toString('base64url'),
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxFeedClients = DEFAULT_MAX_FEED_CLIENTS,
  maxQueuedEvents = DEFAULT_MAX_QUEUED_EVENTS,
  keepaliveMs = DEFAULT_KEEPALIVE_MS,
} = {}) {
  if (typeof dispatch !== 'function') throw new TypeError('dispatch must be a function')
  if (typeof subscribe !== 'function') throw new TypeError('subscribe must be a function')
  if (typeof revision !== 'function') throw new TypeError('revision must be a function')
  if (typeof uiDir !== 'string' || uiDir === '') throw new TypeError('uiDir must be a directory')
  if (typeof launchToken !== 'string' || launchToken.length < 16) throw new TypeError('launchToken must contain at least 16 characters')
  if (typeof host !== 'string' || !LOOPBACK_HOSTS.has(host.toLowerCase())) throw new TypeError('host must be a loopback address')

  const root = resolve(uiDir)
  const session = randomBytes(32).toString('base64url')
  const clients = new Set()
  let launchAvailable = true
  let closing = false
  let origin

  const leave = client => {
    if (!clients.delete(client)) return
    client.closed = true
    client.response.end()
  }

  const write = (client, chunk) => {
    if (client.closed) return
    if (client.blocked) {
      client.queue.push(chunk)
      if (client.queue.length > maxQueuedEvents) leave(client)
      return
    }
    client.blocked = !client.response.write(chunk)
  }

  const flush = client => {
    if (client.closed) return
    client.blocked = false
    while (!client.blocked && client.queue.length > 0) {
      client.blocked = !client.response.write(client.queue.shift())
    }
  }

  const publish = (event, data) => {
    if (typeof event !== 'string' || event === '' || /[\r\n]/.test(event)) return
    const chunk = eventChunk(event, data)
    for (const client of clients) write(client, chunk)
  }

  const unsubscribe = subscribe(publish) ?? (() => {})

  const server = createServer(async (request, response) => {
    try {
      if (closing) {
        response.writeHead(503, { connection: 'close' })
        response.end()
        return
      }

      const hostHeader = request.headers.host
      if (hostHeader === undefined || hostHeader.toLowerCase() !== new URL(origin).host.toLowerCase()) {
        refusal(response, 403, 'bot/forbidden', 'Invalid Host header')
        return
      }

      const requestOrigin = request.headers.origin
      if (requestOrigin !== undefined && requestOrigin !== origin) {
        refusal(response, 403, 'bot/forbidden', 'Invalid request origin')
        return
      }

      const url = new URL(request.url ?? '/', origin)
      const token = url.searchParams.get('token')
      if (request.method === 'GET' && url.pathname === '/' && token !== null) {
        if (!launchAvailable || !sameSecret(token, launchToken)) {
          refusal(response, 401, 'bot/unauthenticated', 'The launch link is no longer valid')
          return
        }
        launchAvailable = false
        response.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'referrer-policy': 'no-referrer',
          'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        })
        response.end()
        return
      }

      if (!sameSecret(cookieValue(request, COOKIE), session)) {
        refusal(response, 401, 'bot/unauthenticated', 'Authentication required')
        return
      }

      if (url.pathname === API_ROUTE) {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        const text = await requestBody(request, maxRequestBytes)
        if (text === undefined) {
          refusal(response, 413, 'bot/request-too-large', 'Request body is too large')
          return
        }
        let body
        try { body = JSON.parse(text) } catch { body = {} }
        const controller = new AbortController()
        request.once('aborted', () => controller.abort())
        response.once('close', () => { if (!response.writableEnded) controller.abort() })
        const result = await dispatch(String(body?.endpoint ?? ''), body?.payload, controller.signal)
        json(response, 200, result)
        return
      }

      if (url.pathname === FEED_ROUTE) {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        if (clients.size >= maxFeedClients) {
          refusal(response, 503, 'bot/feed-limit', 'Too many live feed connections')
          return
        }
        response.writeHead(200, {
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
          'x-accel-buffering': 'no',
        })
        const client = { response, queue: [], blocked: false, closed: false }
        clients.add(client)
        response.on('drain', () => flush(client))
        request.once('aborted', () => leave(client))
        response.once('close', () => { if (!client.closed) clients.delete(client) })
        write(client, eventChunk('hello', { revision: revision() }))
        return
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }

      let pathname
      try { pathname = decodeURIComponent(url.pathname) } catch {
        refusal(response, 400, 'bot/invalid', 'Invalid path')
        return
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const file = resolve(root, relative)
      if (file !== root && !file.startsWith(`${root}${sep}`)) {
        refusal(response, 404, 'bot/not-found', 'Not found')
        return
      }
      let info
      try { info = await stat(file) } catch {
        refusal(response, 404, 'bot/not-found', 'Not found')
        return
      }
      if (!info.isFile()) {
        refusal(response, 404, 'bot/not-found', 'Not found')
        return
      }
      const body = request.method === 'HEAD' ? undefined : await readFile(file)
      response.writeHead(200, {
        'cache-control': relative === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
        'content-length': info.size,
        'content-type': CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      response.end(body)
    } catch (error) {
      if (response.headersSent) response.destroy(error)
      else refusal(response, 500, 'bot/internal', 'Request failed')
    }
  })

  await new Promise((resolveListen, reject) => {
    const fail = error => { server.off('listening', ready); reject(error) }
    const ready = () => { server.off('error', fail); resolveListen() }
    server.once('error', fail)
    server.once('listening', ready)
    server.listen(port, host)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Owned server did not bind a TCP port')
  origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`

  const keepalive = setInterval(() => {
    for (const client of clients) write(client, ': keepalive\n\n')
  }, keepaliveMs)
  keepalive.unref?.()

  let closed
  const close = () => closed ??= (async () => {
    closing = true
    clearInterval(keepalive)
    unsubscribe()
    for (const client of clients) leave(client)
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  })()

  return {
    host,
    port: address.port,
    origin,
    launchUrl: `${origin}/?token=${encodeURIComponent(launchToken)}`,
    close,
  }
}
