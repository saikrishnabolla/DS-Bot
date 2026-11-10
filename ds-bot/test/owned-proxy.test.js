import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  clearedModelProxyEnvironment,
  installProxyFromEnvironment,
  proxyForUrl,
  resolveProxyPolicy,
} from '../src/engine/owned-proxy.js'

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address()))
})

const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

test('owned proxy resolves launch variables with Cue precedence and safe diagnostics', () => {
  const lower = 'http://lower.test:8080'
  const upper = 'http://upper.test:8080'
  const { policy, diagnostics } = resolveProxyPolicy({
    http_proxy: lower,
    HTTP_PROXY: upper,
    ALL_PROXY: 'http://all.test:8080',
    HTTPS_PROXY: 'socks5://user:secret@socks.test:1080',
    NO_PROXY: 'example.com',
  })
  assert.equal(policy.httpProxy, lower)
  assert.equal(policy.httpsProxy, undefined)
  assert.match(policy.noProxy, /^example\.com,localhost,127\.0\.0\.1,::1,\[::1\]$/)
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /HTTPS_PROXY names a SOCKS proxy/)
  assert.doesNotMatch(diagnostics[0], /user|secret|socks\.test/)

  const fallback = resolveProxyPolicy({ ALL_PROXY: 'http://all.test:8080' }).policy
  assert.equal(fallback.httpProxy, 'http://all.test:8080')
  assert.equal(fallback.httpsProxy, 'http://all.test:8080')
  const httpFallback = resolveProxyPolicy({ HTTP_PROXY: upper }).policy
  assert.equal(httpFallback.httpsProxy, upper)
})

test('owned proxy always bypasses loopback and honors host, subdomain and port exclusions', () => {
  const policy = resolveProxyPolicy({ HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: 'example.com,port.test:8443' }).policy
  for (const url of [
    'http://localhost/a', 'http://api.localhost/a', 'http://127.99.2.3/a',
    'http://[::1]/a', 'http://[::ffff:127.0.0.2]/a',
    'http://example.com/a', 'http://api.example.com/a', 'http://port.test:8443/a',
  ]) assert.equal(proxyForUrl(policy, url), undefined, url)
  assert.equal(proxyForUrl(policy, 'http://port.test:8080/a'), 'http://proxy.test:8080')
  assert.equal(proxyForUrl(policy, 'http://outside.test/a'), 'http://proxy.test:8080')
})

test('owned proxy routes global fetch through a fake proxy and restores direct loopback traffic', async t => {
  const proxied = []
  const proxy = createServer((request, response) => {
    proxied.push(request.url)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('through proxy')
  })
  const target = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('direct loopback')
  })
  const proxyAddress = await listen(proxy)
  const targetAddress = await listen(target)
  t.after(async () => { await Promise.all([close(proxy), close(target)]) })
  const stop = await installProxyFromEnvironment({ HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}` })
  t.after(stop)

  assert.equal(await (await fetch('http://owned-proxy-target.invalid/path?q=1')).text(), 'through proxy')
  assert.deepEqual(proxied, ['http://owned-proxy-target.invalid/path?q=1'])
  assert.equal(await (await fetch(`http://127.0.0.1:${targetAddress.port}/local`)).text(), 'direct loopback')
  assert.equal(proxied.length, 1)
})

test('owned proxy clears every credential-bearing proxy variable from model shell overlays', () => {
  assert.deepEqual(clearedModelProxyEnvironment(), {
    http_proxy: undefined,
    HTTP_PROXY: undefined,
    https_proxy: undefined,
    HTTPS_PROXY: undefined,
    no_proxy: undefined,
    NO_PROXY: undefined,
    all_proxy: undefined,
    ALL_PROXY: undefined,
    NODE_USE_ENV_PROXY: undefined,
  })
})
