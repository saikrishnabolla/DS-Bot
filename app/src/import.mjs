import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { copyTree, within } from './copy-tree.mjs'

export { within }
export const REGENERABLE_DEFAULT_BYTES = 200e6
export const REGENERABLE = new Set(['node_modules', '.venv', '__pycache__', '.pnpm-store', '.next'])
const LEFT_BEHIND = new Set(['state.lock', 'inflight.json', 'workspace'])
const LOCK_STALE_MS = 60_000

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function userDshHome(env = process.env) {
  const value = env.DSH_HOME?.trim()
  if (!value) return join(homedir(), '.dsh')
  return resolve(value === '~' ? homedir() : /^~[\\/]/u.test(value) ? join(homedir(), value.slice(2)) : value)
}

export function sessionIdsOf(team) {
  const parts = entries => entries.map(part => part?.sessionId)
  return [...new Set([
    ...Object.values(team.bots ?? {}).flatMap(bot => [bot.id, bot.sessionId, ...parts(bot.segments ?? [])]),
    ...Object.values(team.rooms ?? {}).flatMap(room => [room.id, room.sessionId, ...Object.values(room.sessions ?? {}), ...parts(Object.values(room.segments ?? {}).flat())]),
  ].filter(id => typeof id === 'string' && id !== ''))]
}

export function findTeam(from) {
  const statePath = join(from, 'bot', 'state.json')
  if (!existsSync(statePath)) return undefined
  const team = readJson(statePath)
  const bots = Object.keys(team.bots ?? {}).length
  if (bots === 0) return undefined
  return { from, team, bots, rooms: Object.keys(team.rooms ?? {}).length, profiles: [] }
}

export function teamInUse(from, { host = hostname(), now = Date.now(), isAlive = pidAlive } = {}) {
  const path = join(from, 'bot', 'state.lock')
  const lock = statSync(path, { throwIfNoEntry: false })
  if (lock === undefined || now - lock.mtimeMs >= LOCK_STALE_MS) return false
  let holder
  try { holder = readJson(path) } catch { return true }
  return holder?.host !== host || isAlive(holder.pid)
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function sessionDirs(from, team) {
  const root = join(from, 'sessions')
  const groups = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name)
  const found = []
  const missing = []
  for (const id of sessionIdsOf(team)) {
    const group = groups.find(name => existsSync(join(root, name, id)))
    if (group === undefined) missing.push(id)
    else found.push({ id, group })
  }
  return { found, missing }
}

export async function copySessions(from, team, to, signal, onProgress) {
  const { found } = await sessionDirs(from, team)
  for (const [index, { id, group }] of found.entries()) {
    signal?.throwIfAborted()
    await copyTree(join(from, 'sessions', group, id), join(to, 'sessions', group, id), { signal })
    onProgress?.(index + 1, found.length)
  }
  return found.map(entry => entry.id)
}

export async function teamSizes(from, team) {
  const { found } = await sessionDirs(from, team)
  return { sessions: found.length }
}

export async function importTeam({ from, to, workspace, signal, leaveRegenerable = false, skipWork = false, onProgress }) {
  const found = findTeam(from)
  if (found === undefined) throw new Error(`There is no Bot team in ${from}`)
  const present = existsSync(join(to, 'bot', 'state.json')) ? readJson(join(to, 'bot', 'state.json')) : undefined
  if (Object.keys(present?.bots ?? {}).length > 0) throw new Error(`${to} already has a Bot team`)
  await mkdir(to, { recursive: true })
  const stage = join(to, `.import-${String(Date.now())}`)
  await rm(stage, { recursive: true, force: true })
  let bytes = 0
  const seen = size => { bytes += size; onProgress?.(bytes) }
  try {
    await copyTree(join(from, 'bot'), join(stage, 'bot'), { leave: path => LEFT_BEHIND.has(path.split(/[\\/]/u)[0]), signal, seen })
    const team = readJson(join(stage, 'bot', 'state.json'))
    delete team.workspaceId
    team.agents = {}
    await writeFile(join(stage, 'bot', 'state.json'), `${JSON.stringify(team, null, 2)}\n`)
    const sessions = await copySessions(from, team, stage, signal)
    const { missing } = await sessionDirs(from, team)
    if (existsSync(join(from, 'attachments'))) await copyTree(join(from, 'attachments'), join(stage, 'attachments'), { signal, seen })
    if (!skipWork && workspace && existsSync(join(from, 'bot', 'workspace'))) {
      await mkdir(workspace, { recursive: true })
      const leave = leaveRegenerable ? path => path.split(/[\\/]/u).some(name => REGENERABLE.has(name)) : undefined
      await copyTree(join(from, 'bot', 'workspace'), workspace, { force: false, skip: true, signal, seen, leave })
    }
    const summary = { from, bots: found.bots, rooms: found.rooms, sessions: sessions.length, missingSessions: missing }
    await writeFile(join(stage, 'bot', 'imported.json'), `${JSON.stringify({ ...summary, at: Date.now() }, null, 2)}\n`)
    signal?.throwIfAborted()
    await rm(join(to, 'bot'), { recursive: true, force: true })
    await rm(join(to, 'sessions'), { recursive: true, force: true })
    await rm(join(to, 'attachments'), { recursive: true, force: true })
    for (const name of ['bot', 'sessions', 'attachments']) {
      if (existsSync(join(stage, name))) await rename(join(stage, name), join(to, name))
    }
    await rm(stage, { recursive: true, force: true })
    return summary
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
