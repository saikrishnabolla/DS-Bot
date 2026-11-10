// The first start: where the app keeps its data and the Bots' files (the default places, or the
// one folder picked from the start page). The answers are kept in the app's own data.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findTeam, userDshHome } from './import.mjs'
import { installFolder } from './move-data.mjs'
import { freeSpace } from './place.mjs'
import { langOf, t } from './start/text.mjs'

// The app's picker and the cards in the team window speak the language of the start page
// (main.mjs gives it the same locale).
export const lang = () => langOf(app.getLocale())
export const tx = (key, vars) => t(lang(), key, vars)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')

const PICKER_LABELS = ['places', 'drives', 'home', 'desktop', 'documents', 'downloads', 'path', 'go', 'up', 'newFolder', 'newName', 'create', 'name', 'cancel', 'chooseFolder', 'open', 'save', 'replace', 'loading']
const PICKER_LINES = ['empty', 'noFolders', 'more']
const PICKER_ERRORS = ['missing', 'drive', 'denied', 'notFolder', 'notFile', 'tooLong', 'unreadable', 'name', 'exists', 'isFolder', 'replace']

/** The words of the app's picker (preload.cjs showPicker), which has no text of its own. */
export function pickerLabels() {
  return Object.fromEntries([
    ...PICKER_LABELS.map(key => [key, tx(`picker.${key}`)]),
    ...PICKER_LINES.map(key => [key, tx(`dialog.picker.${key}`)]),
    ...PICKER_ERRORS.map(key => [`error.${key}`, tx(`dialog.picker.${key}`)]),
  ])
}

// A quit request while the picker is open stops the first run right after it.
class Quit extends Error {}

async function pick(title, from, signal, ui) {
  const picked = await ui.asking(ui.pick({ mode: 'folder', title, start: existsSync(from) ? from : dirname(from) }))
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return picked ?? undefined
}

export const programFolder = () => installFolder(app.getPath('exe'))

/**
 * The picker of 「换个位置…」 on the start page: one folder, from which the root rule
 * (place.mjs) makes the places. Undefined when the picker was cancelled or the app is quitting.
 * @param {string} from the folder the picker opens in
 */
export async function pickRoot(from, signal, ui) {
  try {
    return await pick(tx('dialog.pickRoot'), from, signal, ui)
  } catch (error) {
    if (error instanceof Quit) return undefined
    throw error
  }
}

/** The places a first start offers. */
export const defaultPlaces = () => ({ dataDir: join(homedir(), '.ds-bot'), workspace: join(homedir(), 'DS Bot') })

/** The Bot team in a data folder, if it has one. */
export function teamIn(dataDir) {
  try {
    const team = JSON.parse(readFileSync(join(dataDir, 'bot', 'state.json'), 'utf8'))
    return { bots: Object.keys(team.bots ?? {}).length, rooms: Object.keys(team.rooms ?? {}).length, team }
  } catch {
    return undefined
  }
}

/**
 * What the start window can say before the first-run questions: the team that a reinstall keeps.
 */
export function teamsAt(dataDir = defaultPlaces().dataDir) {
  const team = teamIn(dataDir)
  return { team, offered: team === undefined && teamIn(userDshHome()) !== undefined }
}

function offerOf(dataDir) {
  try { return teamIn(dataDir) === undefined ? findTeam(userDshHome()) : undefined } catch (error) { console.error(error); return undefined }
}

/**
 * Write the chosen places once the first run is finished; quitting before that asks again. The
 * free space of the data's drive when the data goes to a folder is kept as long as it stays
 * there: a later start shows the place line again once a fifth of it is left (start-window §5).
 */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  const saved = readSaved(file)
  const kept = saved !== undefined && typeof saved.dataDir === 'string' && resolve(saved.dataDir) === resolve(dataDir) && roomOf(saved.freeAtStart) !== undefined
  // A full drive gives no room to measure a fifth of: the next save measures again.
  const freeAtStart = kept ? saved.freeAtStart : roomOf(freeSpace(dataDir))
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace, freeAtStart }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

const roomOf = bytes => (Number.isFinite(bytes) && bytes > 0 ? bytes : undefined)

function readSaved(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Where the app keeps its data and the Bots' files: the saved places, or at the first start the
 * default ones without a question (the start page says where the data goes and offers
 * 「换个位置…」; windows-onboarding §3). A run on throwaway folders (DS_BOT_HOME, for development
 * and tests) asks nothing. `freeAtStart` is the free space of the data's drive that
 * saveLocations() kept, none when it kept none yet.
 * @returns {{ dataDir: string, workspace?: string, freeAtStart?: number }}
 */
export function chooseLocations() {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { dataDir: saved.dataDir, workspace: saved.workspace, freeAtStart: roomOf(saved.freeAtStart) }
  }
  const { dataDir, workspace } = defaultPlaces()
  const offer = offerOf(dataDir)
  if (offer !== undefined) return { dataDir, workspace, offer }
  saveLocations({ dataDir, workspace })
  return { dataDir, workspace }
}
