import { Agent, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]']
const POLICY_ENV_NAMES = {
  httpProxy: ['http_proxy', 'HTTP_PROXY'],
  httpsProxy: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
}
const PROXY_ENV_NAMES = [...Object.values(POLICY_ENV_NAMES).flat(), 'all_proxy', 'ALL_PROXY']
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])
const DIRECT_POLICY = { noProxy: '', source: 'none' }
const ABSENT = { kind: 'absent' }
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)

let active
let installed
let inheritedProxyEnv

function readEnv(env, lower) {
  for (const name of [lower, lower.toUpperCase()]) {
    const raw = env?.[name]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value !== '') return { value, name }
  }
}

function parsedProxy(candidate, diagnostics) {
  if (candidate === undefined) return ABSENT
  let url
  try { url = new URL(candidate.value) } catch {
    diagnostics.push(`${candidate.name} is not a valid URL; connecting directly`)
    return { kind: 'rejected' }
  }
  if (SOCKS_PROTOCOLS.has(url.protocol)) {
    diagnostics.push(`${candidate.name} names a SOCKS proxy, which is not supported; connecting directly for that scheme`)
    return { kind: 'rejected' }
  }
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    diagnostics.push(`${candidate.name} uses an unsupported proxy scheme; connecting directly for that scheme`)
    return { kind: 'rejected' }
  }
  return { kind: 'accepted', value: candidate.value }
}

function resolveScheme(own, ...fallbacks) {
  if (own.kind === 'accepted') return own.value
  if (own.kind === 'rejected') return undefined
  return fallbacks.find(value => value !== undefined)
}

function withLoopback(noProxy) {
  const entries = String(noProxy ?? '').split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean)
  if (entries.includes('*')) return '*'
  const present = new Set(entries.map(entry => entry.toLowerCase()))
  return [...entries, ...LOOPBACK_NO_PROXY.filter(entry => !present.has(entry))].join(',')
}

function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      return rest.startsWith(':')
        ? { host: entry.slice(1, close), port: rest.slice(1) }
        : { host: entry.slice(1, close) }
    }
  }
  const colon = entry.indexOf(':')
  return colon !== -1 && entry.indexOf(':', colon + 1) === -1
    ? { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
    : { host: entry }
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice(7) : host)
}

function bypassesProxy(noProxy, url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate !== '' && (host === candidate || host.endsWith(`.${candidate}`))) return true
  }
  return false
}

export function resolveProxyPolicy(env = process.env) {
  const diagnostics = []
  const all = parsedProxy(readEnv(env, 'all_proxy'), diagnostics)
  const allValue = all.kind === 'accepted' ? all.value : undefined
  const http = parsedProxy(readEnv(env, 'http_proxy'), diagnostics)
  const https = parsedProxy(readEnv(env, 'https_proxy'), diagnostics)
  const httpProxy = resolveScheme(http, allValue)
  const httpsProxy = resolveScheme(https, allValue, httpProxy)
  if (httpProxy === undefined && httpsProxy === undefined) return { policy: DIRECT_POLICY, diagnostics }
  return {
    policy: {
      ...(httpProxy === undefined ? {} : { httpProxy }),
      ...(httpsProxy === undefined ? {} : { httpsProxy }),
      noProxy: withLoopback(readEnv(env, 'no_proxy')?.value),
      source: 'env',
    },
    diagnostics,
  }
}

export function proxyForUrl(policy, input) {
  const url = input instanceof URL ? input : new URL(input)
  const proxy = url.protocol === 'https:' ? policy.httpsProxy : url.protocol === 'http:' ? policy.httpProxy : undefined
  if (proxy === undefined || isLoopbackHost(url.hostname) || bypassesProxy(policy.noProxy, url)) return undefined
  return proxy
}

function snapshotProxyEnv() {
  return Object.fromEntries(Object.values(POLICY_ENV_NAMES).flat().map(name => [name, process.env[name]]))
}

function writeProxyEnv(values) {
  const previous = snapshotProxyEnv()
  for (const name of Object.keys(previous)) {
    const value = values[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function publishPolicy(policy) {
  const previousInherited = inheritedProxyEnv
  inheritedProxyEnv ??= snapshotProxyEnv()
  const values = {}
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    for (const name of names) values[name] = policy[field]
  }
  const restore = writeProxyEnv(values)
  return () => {
    restore()
    inheritedProxyEnv = previousInherited
  }
}

function policyDispatcher(policy) {
  return new Agent({
    factory(origin, options) {
      const proxy = proxyForUrl(policy, new URL(origin.toString()))
      return proxy === undefined ? new Pool(origin, options) : new ProxyAgent({ ...options, uri: proxy })
    },
  })
}

export async function installProxyFromEnvironment(env = process.env, report = () => {}) {
  const { policy, diagnostics } = resolveProxyPolicy(env)
  for (const diagnostic of diagnostics) report(diagnostic)
  const previousPolicy = active
  if (policy.source === 'none' && previousPolicy === undefined) {
    active = policy
    return async () => { active = previousPolicy }
  }
  if (policy.source === 'none') {
    const previousInstalled = installed
    const restoreEnv = inheritedProxyEnv === undefined ? undefined : writeProxyEnv(inheritedProxyEnv)
    const previousDispatcher = getGlobalDispatcher()
    const direct = new Agent()
    setGlobalDispatcher(direct)
    active = policy
    installed = undefined
    return async () => {
      setGlobalDispatcher(previousDispatcher)
      active = previousPolicy
      installed = previousInstalled
      restoreEnv?.()
      await direct.close()
    }
  }
  const restoreEnv = publishPolicy(policy)
  const previousDispatcher = getGlobalDispatcher()
  const previousInstalled = installed
  const dispatcher = policyDispatcher(policy)
  setGlobalDispatcher(dispatcher)
  active = policy
  installed = dispatcher
  return async () => {
    setGlobalDispatcher(previousDispatcher)
    active = previousPolicy
    installed = previousInstalled
    restoreEnv()
    await dispatcher.close()
  }
}

export function clearedModelProxyEnvironment() {
  return Object.fromEntries([...PROXY_ENV_NAMES, 'NODE_USE_ENV_PROXY'].map(name => [name, undefined]))
}
