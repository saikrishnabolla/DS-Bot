// Moving the app's data to another folder. The copy is put together in a folder beside the new
// one and takes its name only once it is whole, so a copy that stopped or failed leaves nothing
// that looks like data. The old folder stays as it was.
import { basename, dirname, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { copyTree, disk, real, within } from './copy-tree.mjs'

export { copyReason } from './copy-tree.mjs'

const { existsSync, readdirSync, statSync } = disk
const { mkdir, rename, rm, rmdir, writeFile } = disk.promises

// The engine's lock on the team belongs to the old folder.
const LEFT_BEHIND = [/^bot[\\/]state\.lock$/u]
// Marks a staging folder as this app's, so that only those are removed.
const MARK = '.ds-bot-moving'
const LOCK_STALE_MS = 15_000

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Whether another owned Host still holds this team's state lock. */
export function teamInUse(from, { host = hostname(), now = Date.now(), isAlive = pidAlive } = {}) {
  const path = join(from, 'bot', 'state.lock')
  const lock = statSync(path, { throwIfNoEntry: false })
  if (lock === undefined || now - lock.mtimeMs >= LOCK_STALE_MS) return false
  let holder
  try { holder = JSON.parse(disk.readFileSync(path, 'utf8')) } catch { return true }
  return holder?.host !== host || isAlive(holder.pid)
}

/** The folder that an update or uninstall replaces: on macOS the whole .app bundle. */
export function installFolder(exe, platform = process.platform) {
  if (platform === 'darwin') {
    for (let at = dirname(exe); dirname(at) !== at; at = dirname(at)) if (at.endsWith('.app')) return at
  }
  return dirname(exe)
}

/**
 * What keeps `to` from being the new data location, or undefined.
 * @param {{ from: string, to: string, workspace?: string, program?: string }} places
 * @returns {'drive' | 'nested' | 'workspace' | 'program' | 'notEmpty' | undefined}
 */
export function moveProblem(places) {
  const [from, to] = [places.from, places.to].map(real)
  const workspace = places.workspace === undefined ? undefined : real(places.workspace)
  const program = places.program === undefined ? undefined : real(places.program)
  if (dirname(to) === to) return 'drive'
  if (within(to, from) || within(from, to)) return 'nested'
  if (workspace !== undefined && (within(to, workspace) || within(workspace, to))) return 'workspace'
  if (program !== undefined && within(to, program)) return 'program'
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) return 'notEmpty'
  return undefined
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Copy the data in `from` to `to`, an empty or new folder. The signal stops it between files.
 * @param {string} from @param {string} to @param {AbortSignal} [signal]
 */
export async function copyData(from, to, signal) {
  const parent = dirname(resolve(to))
  await mkdir(parent, { recursive: true })
  // A run that was killed can leave its staging folder behind.
  const staging = new RegExp(`^\\.${escaped(basename(to))}\\.moving-\\d+$`, 'u')
  for (const name of readdirSync(parent).filter(entry => staging.test(entry) && existsSync(join(parent, entry, MARK)))) {
    await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 })
  }
  const stage = join(parent, `.${basename(to)}.moving-${String(Date.now())}`)
  await mkdir(stage)
  try {
    await writeFile(join(stage, MARK), '')
    // Anything left out would be missing from the data the app moves on to, so it stops the move.
    await copyTree(from, stage, { as: to, leave: path => LEFT_BEHIND.some(pattern => pattern.test(path)), signal })
    signal?.throwIfAborted()
    if (existsSync(to)) await rmdir(to)
    await rename(stage, to)
  } catch (error) {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 })
    throw error
  }
  // Only now: a staging folder cut short before its rename keeps the mark that lets it go.
  await rm(join(to, MARK), { force: true })
}
