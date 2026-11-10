import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'

const STATE_VERSION = 1
const STATE_FILE = 'plugin-packages.json'
const RUNTIME_DIR = 'plugin-runtime'
const PACKAGE_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'
const IGNORED_FINGERPRINT_DIRS = new Set(['.git'])
const REMOTE_SOURCE = /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git@)/u

const inside = (root, candidate) => {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

const clone = value => structuredClone(value)

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readState(path) {
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw new Error(`Could not read Cue plugin state: ${error?.message ?? error}`)
  }
  if (value?.version !== STATE_VERSION || !Array.isArray(value.packages)) throw new Error('Cue plugin state has an unsupported format')
  const rows = new Map()
  for (const row of value.packages) {
    if (typeof row?.source !== 'string' || row.source === '' || typeof row.enabled !== 'boolean') throw new Error('Cue plugin state contains an invalid package')
    rows.set(row.source, {
      source: row.source,
      enabled: row.enabled,
      ...(typeof row.approvedFingerprint === 'string' ? { approvedFingerprint: row.approvedFingerprint } : {}),
    })
  }
  return rows
}

async function fingerprintTree(root) {
  const hash = createHash('sha256')
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_FINGERPRINT_DIRS.has(entry.name)) continue
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) {
        hash.update(`d\0${name}\0`)
        await walk(path)
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Cue plugin packages cannot contain symbolic links: ${name}`)
      } else if (entry.isFile()) {
        hash.update(`f\0${name}\0`)
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        hash.update('\0')
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

function declaredEntries(manifest, field) {
  const configured = manifest?.cue?.[field]
  if (configured === undefined) return []
  const entries = typeof configured === 'string' ? [configured] : configured
  if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`package.json cue.${field} must be a path or a non-empty array of paths`)
  }
  return [...new Set(entries.map(entry => entry.trim()))]
}

const pluginEntries = manifest => declaredEntries(manifest, 'plugins')
const clientEntries = manifest => declaredEntries(manifest, 'client')

async function packageDescriptor(configured, resources, failure) {
  const base = {
    source: configured.source,
    scope: configured.scope,
    installedPath: configured.installedPath,
    name: configured.source,
    version: '',
    entries: [],
    clientEntries: [],
    skills: [],
    fingerprint: '',
    manifest: undefined,
  }
  if (failure !== undefined) return { ...base, state: 'error', error: failure.message }
  if (typeof configured.installedPath !== 'string' || configured.installedPath === '') return { ...base, state: 'error', error: 'The package is not installed' }
  try {
    const root = await realpath(configured.installedPath)
    const packageStat = await stat(root)
    const manifestPath = packageStat.isDirectory() ? join(root, 'package.json') : undefined
    if (manifestPath === undefined) throw new Error('Cue plugins must be packages with a package.json file')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const declared = pluginEntries(manifest)
    const declaredClient = clientEntries(manifest)
    const entries = []
    const browserEntries = []
    const resolveEntry = async (declaredPath, kind) => {
      const candidate = resolve(root, declaredPath)
      if (!inside(root, candidate)) throw new Error(`Cue ${kind} entry ${JSON.stringify(declaredPath)} must stay inside the package`)
      const resolved = await realpath(candidate)
      if (!inside(root, resolved)) throw new Error(`Cue ${kind} entry ${JSON.stringify(declaredPath)} must stay inside the package`)
      const entryStat = await lstat(candidate)
      if (!entryStat.isFile()) throw new Error(`Cue ${kind} entry ${JSON.stringify(declaredPath)} is not a file`)
      return resolved
    }
    for (const declaredPath of declared) entries.push(await resolveEntry(declaredPath, 'plugin'))
    for (const declaredPath of declaredClient) browserEntries.push(await resolveEntry(declaredPath, 'client'))
    const skills = resources.skills
      .filter(resource => resource.enabled && resource.metadata?.packageRoot !== undefined)
      .filter(resource => resolve(resource.metadata.packageRoot) === resolve(configured.installedPath))
      .map(resource => resource.path)
    const fingerprint = await fingerprintTree(root)
    return {
      ...base,
      root,
      manifestPath,
      manifest,
      name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : configured.source,
      version: typeof manifest.version === 'string' ? manifest.version : '',
      entries,
      clientEntries: browserEntries,
      skills,
      fingerprint,
    }
  } catch (error) {
    return { ...base, state: 'error', error: error?.message ?? String(error) }
  }
}

const publicRow = row => {
  const { manifest: _manifest, root: _root, manifestPath: _manifestPath, ...view } = row
  return clone(view)
}

export class OwnedPluginPackages {
  #dataDir
  #statePath
  #settings
  #packages
  #api
  #fetch
  #trust
  #rows = new Map()
  #active = new Map()
  #writing = Promise.resolve()
  #closed = false

  constructor({ dataDir, workspacePath, api, fetch }, trust) {
    this.#dataDir = resolve(dataDir)
    this.#statePath = join(this.#dataDir, STATE_FILE)
    const agentDir = join(this.#dataDir, RUNTIME_DIR)
    this.#settings = SettingsManager.create(resolve(workspacePath), agentDir, { projectTrusted: false })
    this.#packages = new DefaultPackageManager({ cwd: resolve(workspacePath), agentDir, settingsManager: this.#settings })
    this.#api = api ?? {}
    this.#fetch = fetch ?? globalThis.fetch
    this.#trust = trust
  }

  static async open({ dataDir, workspacePath = process.cwd(), api = {}, fetch } = {}) {
    if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a directory')
    await mkdir(resolve(dataDir), { recursive: true, mode: 0o700 })
    const statePath = join(resolve(dataDir), STATE_FILE)
    const manager = new OwnedPluginPackages({ dataDir, workspacePath, api, fetch }, await readState(statePath))
    await manager.#refresh()
    return manager
  }

  async #saveTrust() {
    const contents = {
      version: STATE_VERSION,
      packages: [...this.#trust.values()].sort((left, right) => left.source.localeCompare(right.source)),
    }
    const write = this.#writing.then(() => atomicJson(this.#statePath, contents))
    this.#writing = write.catch(() => undefined)
    return write
  }

  #assertOpen() {
    if (this.#closed) throw new Error('Cue plugin packages are closed')
  }

  #configured(source) {
    const key = String(source ?? '')
    const exact = this.#packages.listConfiguredPackages().find(row => row.source === key)
    if (exact !== undefined) return exact
    const known = this.#rows.get(key)
    if (known !== undefined) return { source: known.source, scope: known.scope, installedPath: known.installedPath }
    throw new Error(`Unknown Cue plugin package ${JSON.stringify(key)}`)
  }

  async #deactivate(source) {
    const active = this.#active.get(source)
    if (active === undefined) return
    this.#active.delete(source)
    await Promise.allSettled(active.disposers.reverse().map(dispose => Promise.resolve().then(dispose)))
  }

  async #activate(row) {
    const current = this.#active.get(row.source)
    if (current?.fingerprint === row.fingerprint) return row
    await this.#deactivate(row.source)
    const disposers = []
    try {
      const staged = await this.#stage(row)
      for (const entry of row.entries) {
        const stagedEntry = join(staged, relative(row.root, entry))
        const module = await import(pathToFileURL(stagedEntry).href)
        if (typeof module.default !== 'function') throw new Error(`Cue plugin entry ${JSON.stringify(entry)} must export a default setup function`)
        const supplied = typeof this.#api === 'function' ? await this.#api(publicRow(row)) : this.#api
        const dispose = await module.default({
          ...supplied,
          package: {
            source: row.source,
            name: row.name,
            version: row.version,
            root: row.root,
            fingerprint: row.fingerprint,
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
        else if (typeof dispose?.dispose === 'function') disposers.push(() => dispose.dispose())
      }
      this.#active.set(row.source, { fingerprint: row.fingerprint, disposers })
      return row
    } catch (error) {
      await Promise.allSettled(disposers.reverse().map(dispose => Promise.resolve().then(dispose)))
      throw error
    }
  }

  async #stage(row) {
    const cache = join(this.#dataDir, RUNTIME_DIR, 'cache')
    const target = join(cache, row.fingerprint)
    try {
      if ((await lstat(target)).isDirectory()) {
        try { if (await fingerprintTree(target) === row.fingerprint) return target }
        catch {}
      }
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    try {
      await cp(row.root, temporary, {
        recursive: true,
        filter: source => !relative(row.root, source).split(sep).includes('.git'),
      })
      if (await fingerprintTree(temporary) !== row.fingerprint) {
        throw new Error('The Cue plugin package changed while it was being staged; inspect and approve it again')
      }
      try { await rename(temporary, target) }
      catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
        if (await fingerprintTree(target) !== row.fingerprint) throw new Error('The staged Cue plugin package did not match its approved fingerprint')
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
    return target
  }

  async #refresh({ force = new Set() } = {}) {
    this.#assertOpen()
    let resources
    try { resources = await this.#packages.resolve(async () => 'skip') }
    catch (error) { resources = { extensions: [], skills: [], prompts: [], themes: [], installFailures: [{ source: '', message: error?.message ?? String(error) }] } }
    const configured = this.#packages.listConfiguredPackages()
    const failures = new Map((resources.installFailures ?? []).map(failure => [failure.source, failure]))
    const next = new Map()
    for (const item of configured) {
      let row = await packageDescriptor(item, resources, failures.get(item.source))
      const trust = this.#trust.get(item.source)
      if (row.state === 'error') {
        await this.#deactivate(item.source)
      } else if (row.entries.length === 0 && row.clientEntries.length === 0) {
        await this.#deactivate(item.source)
        row = row.skills.length > 0
          ? { ...row, state: 'resources-only' }
          : { ...row, state: 'incompatible', error: 'The package does not declare a Cue plugin entry in package.json cue.plugins' }
      } else if (trust?.enabled === false) {
        await this.#deactivate(item.source)
        row = { ...row, state: 'disabled', approvedFingerprint: trust.approvedFingerprint }
      } else if (trust?.approvedFingerprint !== row.fingerprint) {
        await this.#deactivate(item.source)
        row = { ...row, state: 'approval-required', approvedFingerprint: trust?.approvedFingerprint }
      } else {
        if (force.has(item.source)) await this.#deactivate(item.source)
        try {
          await this.#activate(row)
          row = { ...row, state: 'active', approvedFingerprint: trust.approvedFingerprint }
        } catch (error) {
          row = { ...row, state: 'error', approvedFingerprint: trust.approvedFingerprint, error: error?.message ?? String(error) }
        }
      }
      next.set(item.source, row)
    }
    for (const source of this.#active.keys()) {
      if (!next.has(source)) await this.#deactivate(source)
    }
    this.#rows = next
  }

  async list() {
    await this.#refresh()
    return [...this.#rows.values()].map(publicRow).sort((left, right) => left.name.localeCompare(right.name))
  }

  async read(source) {
    await this.#refresh()
    const row = this.#rows.get(String(source ?? ''))
    if (row === undefined) throw new Error(`Unknown Cue plugin package ${JSON.stringify(String(source ?? ''))}`)
    return { ...publicRow(row), manifest: clone(row.manifest) }
  }

  async clientEntries() {
    await this.#refresh()
    return [...this.#rows.values()]
      .filter(row => row.state === 'active' && row.clientEntries.length > 0)
      .map(row => ({
        source: row.source,
        name: row.name,
        version: row.version,
        fingerprint: row.fingerprint,
        entries: row.clientEntries.map(entry => relative(row.root, entry).split(sep).join('/')),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async clientAsset(fingerprint, requestedPath) {
    this.#assertOpen()
    const key = String(fingerprint ?? '')
    const name = String(requestedPath ?? '').split('/').join(sep)
    if (!/^[a-f0-9]{64}$/u.test(key) || name === '' || isAbsolute(name)) throw new Error('Cue client asset not found')
    await this.#refresh()
    const row = [...this.#rows.values()].find(value => value.state === 'active' && value.fingerprint === key && value.clientEntries.length > 0)
    if (row === undefined) throw new Error('Cue client asset not found')
    const staged = await realpath(await this.#stage(row))
    const candidate = resolve(staged, name)
    if (!inside(staged, candidate)) throw new Error('Cue client asset must stay inside the package')
    const resolved = await realpath(candidate)
    if (!inside(staged, resolved)) throw new Error('Cue client asset must stay inside the package')
    const info = await lstat(candidate)
    if (!info.isFile()) throw new Error('Cue client asset not found')
    return { data: await readFile(resolved), path: relative(staged, resolved).split(sep).join('/') }
  }

  async search(query = '') {
    this.#assertOpen()
    if (typeof this.#fetch !== 'function') throw new Error('Package search is not available')
    const text = String(query ?? '').trim()
    if (text.length > 120) throw new Error('Package search is too long')
    const url = new URL(PACKAGE_SEARCH_URL)
    url.searchParams.set('text', ['keywords:pi-package', text].filter(Boolean).join(' '))
    url.searchParams.set('size', '20')
    const response = await this.#fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Package search failed with HTTP ${response.status}`)
    const body = await response.json()
    return (Array.isArray(body?.objects) ? body.objects : []).flatMap(item => {
      const entry = item?.package
      if (typeof entry?.name !== 'string' || entry.name === '') return []
      const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : []
      return [{
        name: entry.name,
        version: typeof entry.version === 'string' ? entry.version : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        source: `npm:${entry.name}${entry.version ? `@${entry.version}` : ''}`,
        url: typeof entry.links?.npm === 'string' ? entry.links.npm : '',
        keywords,
        compatibility: keywords.includes('cue-plugin') ? 'declared-cue' : 'pi-package',
      }]
    })
  }

  async install(source) {
    this.#assertOpen()
    const before = new Set(this.#packages.listConfiguredPackages().map(row => row.source))
    await this.#packages.installAndPersist(String(source))
    await this.#settings.flush()
    await this.#refresh()
    const added = this.#packages.listConfiguredPackages().filter(row => !before.has(row.source))
    let configured = added.length === 1 ? added[0] : undefined
    if (configured === undefined) {
      const target = resolve(String(source))
      configured = this.#packages.listConfiguredPackages().find(row => row.installedPath !== undefined && resolve(row.installedPath) === target)
    }
    if (configured === undefined) throw new Error(`Installed package ${JSON.stringify(String(source))} could not be identified`)
    const row = this.#rows.get(configured.source)
    if (row === undefined) throw new Error(`Installed package ${JSON.stringify(configured.source)} could not be inspected`)
    this.#trust.set(configured.source, { source: configured.source, enabled: true, ...(row.fingerprint === '' ? {} : { approvedFingerprint: row.fingerprint }) })
    await this.#saveTrust()
    await this.#refresh({ force: new Set([configured.source]) })
    return this.read(configured.source)
  }

  async update(source) {
    const configured = this.#configured(source)
    await this.#packages.update(REMOTE_SOURCE.test(configured.source) ? configured.source : configured.installedPath)
    await this.#settings.flush()
    return this.reload(configured.source)
  }

  async remove(source) {
    const configured = this.#configured(source)
    await this.#deactivate(configured.source)
    const operationSource = REMOTE_SOURCE.test(configured.source) ? configured.source : configured.installedPath
    const removed = await this.#packages.removeAndPersist(operationSource, { local: configured.scope === 'project' })
    await this.#settings.flush()
    this.#trust.delete(configured.source)
    await this.#saveTrust()
    await this.#refresh()
    return removed
  }

  async disable(source) {
    const configured = this.#configured(source)
    await this.#refresh()
    const row = this.#rows.get(configured.source)
    const previous = this.#trust.get(configured.source)
    this.#trust.set(configured.source, {
      source: configured.source,
      enabled: false,
      ...(previous?.approvedFingerprint === undefined && row?.fingerprint === '' ? {} : { approvedFingerprint: previous?.approvedFingerprint ?? row?.fingerprint }),
    })
    await this.#saveTrust()
    await this.#refresh()
    return this.read(configured.source)
  }

  async enable(source) {
    return this.#approve(source, false)
  }

  async reload(source) {
    return this.#approve(source, true)
  }

  async #approve(source, force) {
    const configured = this.#configured(source)
    await this.#refresh()
    const row = this.#rows.get(configured.source)
    if (row === undefined) throw new Error(`Unknown Cue plugin package ${JSON.stringify(configured.source)}`)
    if (row.fingerprint === '') return this.read(configured.source)
    this.#trust.set(configured.source, { source: configured.source, enabled: true, approvedFingerprint: row.fingerprint })
    await this.#saveTrust()
    await this.#refresh({ force: force ? new Set([configured.source]) : new Set() })
    return this.read(configured.source)
  }

  async close() {
    if (this.#closed) return
    for (const source of this.#active.keys()) await this.#deactivate(source)
    await this.#writing
    await this.#settings.flush()
    this.#closed = true
  }
}
