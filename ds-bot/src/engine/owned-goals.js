import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

const VERSION = 1
const FILE = /^[a-f0-9]{64}\.json$/u

const nameOf = key => `${createHash('sha256').update(key).digest('hex')}.json`

function syncDirectory(path) {
  let handle
  try {
    handle = openSync(path, 'r')
    fsyncSync(handle)
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM'].includes(error?.code)) throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

export class OwnedGoalStore {
  #dir
  #goals = new Map()

  constructor(dataDir) {
    if (dataDir === undefined) return
    this.#dir = join(resolve(dataDir), 'runtime-goals')
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!entry.isFile() || !FILE.test(entry.name)) continue
      const document = JSON.parse(readFileSync(join(this.#dir, entry.name), 'utf8'))
      if (document?.version !== VERSION || typeof document.key !== 'string' || document.goal === null || typeof document.goal !== 'object') {
        throw new Error(`Invalid owned goal document ${entry.name}`)
      }
      if (nameOf(document.key) !== entry.name) throw new Error(`Owned goal key does not match ${entry.name}`)
      this.#goals.set(document.key, document.goal)
    }
  }

  get(key) { return this.#goals.get(String(key)) }

  set(key, goal) {
    const normalized = String(key)
    if (this.#dir !== undefined) {
      const name = nameOf(normalized)
      const target = join(this.#dir, name)
      const temporary = join(this.#dir, `.${name}.${process.pid}.${randomUUID()}.tmp`)
      let handle
      try {
        handle = openSync(temporary, 'wx', 0o600)
        writeFileSync(handle, JSON.stringify({ version: VERSION, key: normalized, goal }), 'utf8')
        fsyncSync(handle)
        closeSync(handle)
        handle = undefined
        renameSync(temporary, target)
        syncDirectory(this.#dir)
      } catch (error) {
        if (handle !== undefined) closeSync(handle)
        rmSync(temporary, { force: true })
        throw error
      }
    }
    this.#goals.set(normalized, goal)
    return goal
  }

  delete(key) {
    const normalized = String(key)
    if (this.#dir !== undefined) {
      rmSync(join(this.#dir, nameOf(normalized)), { force: true })
      syncDirectory(this.#dir)
    }
    return this.#goals.delete(normalized)
  }
}
