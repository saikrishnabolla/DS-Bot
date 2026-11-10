import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import YAML from 'yaml'
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import { PROTOCOLS, customProviderConfig, keyRefFor } from './owned-models.js'

const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const SETTINGS_FILES = ['cordis.patch.yml', 'settings.yaml', 'settings.yaml.imported']

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function replaceJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function parseYaml(text, path) {
  try { return YAML.parse(text, { maxAliasCount: 0, prettyErrors: false }) } catch {
    throw new Error(`Cannot import legacy model settings from ${basename(path)}`)
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function credentialOf(record, key) {
  if (!object(record)) throw new Error(`Cannot import legacy credential record ${key}`)
  if (record.kind === 'api-key') {
    const credential = { type: 'api_key' }
    if (record.key !== undefined) {
      if (typeof record.key !== 'string' || record.key === '') throw new Error(`Cannot import legacy credential record ${key}`)
      credential.key = record.key
    }
    if (record.env !== undefined) {
      if (!object(record.env) || Object.values(record.env).some(value => typeof value !== 'string')) throw new Error(`Cannot import legacy credential record ${key}`)
      credential.env = { ...record.env }
    }
    if (credential.key === undefined && credential.env === undefined) throw new Error(`Cannot import legacy credential record ${key}`)
    return credential
  }
  if (record.kind === 'grant' && object(record.payload) && record.payload.type === 'oauth') return structuredClone(record.payload)
  throw new Error(`Cannot import legacy credential record ${key}`)
}

async function credentialsAt(root, platform) {
  const path = join(root, '.credentials.yaml')
  if (!existsSync(path)) return { refs: {}, auth: {}, issues: [] }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Legacy credentials were skipped because the credential file is not private')
  }
  const parsed = parseYaml(await readFile(path, 'utf8'), path)
  if (parsed === null) return { refs: {}, auth: {}, issues: [] }
  if (!object(parsed) || parsed.version !== 1 || !object(parsed.refs ?? {}) || !object(parsed.records ?? {})) {
    throw new Error('Cannot import legacy credentials: unsupported format')
  }
  const refs = {}
  for (const [key, value] of Object.entries(parsed.refs ?? {})) {
    if (typeof value !== 'string' || value === '') throw new Error('Cannot import legacy credentials: invalid reference')
    refs[key] = value
  }
  const auth = {}
  const issues = []
  for (const [key, record] of Object.entries(parsed.records ?? {})) {
    if (key === 'deepseek-account-platform/default') {
      issues.push('DeepSeek account sign-in must be completed again')
      continue
    }
    if (!key.startsWith('llm-pi-ai/')) continue
    const provider = key.slice('llm-pi-ai/'.length)
    if (!ROUTE_ID.test(provider)) throw new Error('Cannot import legacy credentials: invalid provider')
    auth[provider] = credentialOf(record, key)
  }
  return { refs, auth, issues }
}

function providersOf(value) {
  if (Array.isArray(value)) {
    const entry = value.find(item => object(item) && (
      item.id === 'llm-pi-ai' || item.id === '@deepseek-ai/dsh-llm-pi-ai'
      || item.name === '@deepseek-ai/dsh-llm-pi-ai' || item.name === 'llm-pi-ai'
    ))
    return object(entry?.config?.providers) ? entry.config.providers : {}
  }
  if (!object(value)) return {}
  if (object(value.providers)) return value.providers
  for (const key of ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai']) {
    if (object(value[key]?.providers)) return value[key].providers
    if (object(value[key]?.config?.providers)) return value[key].config.providers
  }
  return {}
}

function deepseekRouteOf(value) {
  const names = new Set(['llm-deepseek', 'llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-api-key'])
  if (Array.isArray(value)) {
    const entry = value.find(item => object(item) && (names.has(item.id) || names.has(item.name)))
    return object(entry?.config) ? entry.config : undefined
  }
  if (!object(value)) return undefined
  for (const key of names) {
    if (object(value[key]?.config)) return value[key].config
    if (object(value[key])) return value[key]
  }
  return undefined
}

async function routesAt(root) {
  const profiles = join(root, 'profiles')
  const names = (await readdir(profiles, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const routes = {}
  const issues = []
  for (const name of names) {
    for (const file of SETTINGS_FILES) {
      const path = join(profiles, name, file)
      if (!existsSync(path)) continue
      const settings = parseYaml(await readFile(path, 'utf8'), path)
      const providers = providersOf(settings)
      const deepseek = deepseekRouteOf(settings)
      if (deepseek !== undefined) {
        providers.deepseek ??= {
          apiKeyEnv: typeof deepseek.apiKeyEnv === 'string' ? deepseek.apiKeyEnv : 'DEEPSEEK_API_KEY',
          ...(deepseek.baseURL === undefined && deepseek.models === undefined ? {} : {
            api: 'anthropic-messages',
            baseURL: deepseek.baseURL ?? 'https://api.deepseek.com/anthropic',
            models: deepseek.models ?? getBuiltinModels('deepseek'),
          }),
        }
      }
      if (Object.keys(providers).length === 0) continue
      for (const [provider, route] of Object.entries(providers)) {
        if (!ROUTE_ID.test(provider) || !object(route)) throw new Error(`Cannot import legacy model route ${provider}`)
        if (routes[provider] !== undefined && JSON.stringify(routes[provider]) !== JSON.stringify(route)) {
          issues.push(`Skipped conflicting legacy model route ${provider}`)
          continue
        }
        routes[provider] = structuredClone(route)
      }
      break
    }
  }
  return { routes, issues }
}

function customRoute(provider, route) {
  const api = route.api
  const baseUrl = route.baseURL ?? route.baseUrl
  const models = route.models
  const custom = api !== undefined || baseUrl !== undefined || models !== undefined
  if (!custom) return undefined
  if (!PROTOCOLS.includes(api) || typeof baseUrl !== 'string' || baseUrl === '' || !Array.isArray(models) || models.length === 0) {
    throw new Error(`Cannot import unsupported legacy model route ${provider}`)
  }
  return customProviderConfig({
    provider,
    name: typeof route.displayName === 'string' && route.displayName !== '' ? route.displayName : provider,
    api,
    baseUrl,
    models: models.map(model => object(model) && object(route.compat)
      ? { ...structuredClone(model), compat: { ...structuredClone(route.compat), ...(object(model.compat) ? structuredClone(model.compat) : {}) } }
      : structuredClone(model)),
  })
}

async function sourceRoots(dataDir) {
  const roots = [resolve(dataDir)]
  const imported = await readJson(join(dataDir, 'bot', 'imported.json'), undefined)
  if (typeof imported?.from === 'string' && imported.from !== '') roots.push(resolve(imported.from))
  return [...new Set(roots)]
}

export async function prepareLegacyModels({ dataDir, platform = process.platform }) {
  const recordPath = join(dataDir, 'bot', 'pi-model-import.json')
  const record = await readJson(recordPath, undefined)
  if (record?.version === 1 && record.complete === true) return { credentials: 0, routes: 0 }
  if (record !== undefined && record?.version !== 1) throw new Error('Cannot import legacy models over an unsupported migration record')
  const authPath = join(dataDir, 'auth.json')
  const providersPath = join(dataDir, 'providers.json')
  const existingAuth = await readJson(authPath, {})
  const existingProviders = await readJson(providersPath, { enabled: [], custom: {} })
  if (!object(existingAuth) || !object(existingProviders) || !Array.isArray(existingProviders.enabled) || !object(existingProviders.custom)) {
    throw new Error('Cannot import legacy models over invalid owned model settings')
  }
  const importedAuth = {}
  const importedRoutes = {}
  const refs = {}
  const issues = []
  for (const root of await sourceRoots(dataDir)) {
    try {
      const credentials = await credentialsAt(root, platform)
      issues.push(...credentials.issues)
      for (const [key, value] of Object.entries(credentials.refs)) {
        if (refs[key] !== undefined && refs[key] !== value) issues.push(`Skipped conflicting legacy credential reference ${key}`)
        else refs[key] ??= value
      }
      for (const [provider, value] of Object.entries(credentials.auth)) importedAuth[provider] ??= value
      const found = await routesAt(root)
      issues.push(...found.issues)
      for (const [provider, route] of Object.entries(found.routes)) {
        if (importedRoutes[provider] !== undefined && JSON.stringify(importedRoutes[provider]) !== JSON.stringify(route)) {
          issues.push(`Skipped conflicting legacy model route ${provider}`)
          continue
        }
        importedRoutes[provider] = route
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Legacy model settings could not be imported')
    }
  }
  for (const [provider, route] of Object.entries(importedRoutes)) {
    if (importedAuth[provider] === undefined && typeof route.apiKeyEnv === 'string' && refs[route.apiKeyEnv] !== undefined) {
      importedAuth[provider] = { type: 'api_key', key: refs[route.apiKeyEnv] }
    }
  }
  for (const provider of getBuiltinProviders()) {
    const key = refs[keyRefFor(provider)]
    if (key !== undefined) importedAuth[provider] ??= { type: 'api_key', key }
  }
  if (refs.DEEPSEEK_API_KEY !== undefined) importedAuth.deepseek ??= { type: 'api_key', key: refs.DEEPSEEK_API_KEY }
  const auth = structuredClone(existingAuth)
  for (const [provider, credential] of Object.entries(importedAuth)) auth[provider] ??= credential
  const providers = structuredClone(existingProviders)
  for (const [provider, route] of Object.entries(importedRoutes)) {
    if (providers.custom[provider] !== undefined || providers.enabled.includes(provider)) continue
    try {
      const custom = customRoute(provider, route)
      if (custom === undefined) providers.enabled.push(provider)
      else providers.custom[provider] = custom
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `Skipped unsupported legacy model route ${provider}`)
    }
  }
  providers.enabled = [...new Set(providers.enabled)]
  if (JSON.stringify(auth) !== JSON.stringify(existingAuth)) await replaceJson(authPath, auth)
  if (JSON.stringify(providers) !== JSON.stringify(existingProviders)) await replaceJson(providersPath, providers)
  if (Object.keys(importedAuth).length > 0 || Object.keys(importedRoutes).length > 0 || issues.length > 0) {
    await replaceJson(recordPath, { version: 1, complete: true, issues: [...new Set(issues)] })
  }
  return { credentials: Object.keys(importedAuth).length, routes: Object.keys(importedRoutes).length, issues: [...new Set(issues)] }
}
