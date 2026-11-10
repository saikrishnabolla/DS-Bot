import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_PRESETS } from '../shared/agent-presets.js'

const BUILT_INS = new Map(AGENT_PRESETS.map(row => [row.id, row]))
const ID = /^[a-z][a-z0-9-]{0,63}$/
const TOOL = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/

const text = (value, name, maximum, { optional = false } = {}) => {
  const clean = String(value ?? '').trim()
  if (clean === '' && optional) return ''
  if (clean === '') throw new Error(`${name} is required`)
  if (clean.length > maximum) throw new Error(`${name} is too long`)
  return clean
}

function cleanCustom(input) {
  const id = text(input?.id, 'Preset id', 64)
  if (!ID.test(id)) throw new Error('Preset id must start with a letter and use lowercase letters, numbers, or hyphens')
  if (BUILT_INS.has(id)) throw new Error(`Built-in Agent preset ${JSON.stringify(id)} cannot be replaced`)
  const tools = [...new Set(Array.isArray(input?.tools) ? input.tools.map(value => String(value).trim()) : [])]
  if (tools.length === 0) throw new Error('A custom Agent preset needs at least one tool')
  if (tools.some(name => !TOOL.test(name))) throw new Error('A custom Agent preset contains an invalid tool name')
  return {
    id,
    name: text(input?.name, 'Preset name', 80),
    group: 'custom',
    description: text(input?.description, 'Preset description', 400, { optional: true }),
    tools,
    instructions: text(input?.instructions, 'Preset instructions', 20_000, { optional: true }),
  }
}

export class OwnedAgentPresets {
  #path
  #rows = new Map()
  #toolNames
  #writing = Promise.resolve()

  constructor(dataDir, { toolNames = () => new Set() } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.#path = join(dataDir, 'agent-presets.json')
    this.#toolNames = toolNames
    let parsed = []
    try { parsed = JSON.parse(readFileSync(this.#path, 'utf8')) }
    catch (error) { if (error?.code !== 'ENOENT') throw new Error(`Could not read custom Agent presets: ${error?.message ?? error}`) }
    if (!Array.isArray(parsed)) throw new Error('Custom Agent presets must be an array')
    for (const value of parsed) {
      const row = cleanCustom(value)
      if (this.#rows.has(row.id)) throw new Error(`Duplicate custom Agent preset ${JSON.stringify(row.id)}`)
      this.#rows.set(row.id, row)
    }
  }

  #view(row) {
    const available = this.#toolNames()
    const missing = row.tools?.filter(name => !available.has(name)) ?? []
    return { ...row, ...(missing.length === 0 ? {} : { broken: `Missing tools: ${missing.join(', ')}` }) }
  }

  async list() {
    return [
      ...AGENT_PRESETS.map(({ id, name }) => ({ id, name })),
      ...[...this.#rows.values()].map(row => this.#view(row)),
    ]
  }

  resolve(id) {
    const key = String(id ?? '')
    const builtIn = BUILT_INS.get(key)
    if (builtIn !== undefined) return { ...builtIn }
    const row = this.#rows.get(key)
    if (row === undefined) throw new Error(`Unknown Agent preset ${JSON.stringify(key)}`)
    const view = this.#view(row)
    if (view.broken !== undefined) throw new Error(`Agent preset ${JSON.stringify(key)} is unavailable: ${view.broken}`)
    return view
  }

  async #save() {
    const contents = `${JSON.stringify([...this.#rows.values()], null, 2)}\n`
    const temporary = `${this.#path}.tmp-${process.pid}-${randomUUID()}`
    const write = this.#writing.then(async () => {
      try {
        await writeFile(temporary, contents, { mode: 0o600 })
        await rename(temporary, this.#path)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.#writing = write.catch(() => undefined)
    return write
  }

  async save(input) {
    const row = cleanCustom(input)
    this.#rows.set(row.id, row)
    try { await this.#save() }
    catch (error) {
      this.#rows.delete(row.id)
      throw error
    }
    return this.#view(row)
  }

  async remove(id) {
    const key = String(id ?? '')
    if (BUILT_INS.has(key)) throw new Error(`Built-in Agent preset ${JSON.stringify(key)} cannot be removed`)
    const previous = this.#rows.get(key)
    if (previous === undefined) throw new Error(`Unknown Agent preset ${JSON.stringify(key)}`)
    this.#rows.delete(key)
    try { await this.#save() }
    catch (error) {
      this.#rows.set(key, previous)
      throw error
    }
    return true
  }

  serviceFor(_agent, name) { return name === 'compaction' ? undefined : undefined }
}
