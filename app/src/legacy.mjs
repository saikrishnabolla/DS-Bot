// Compatibility identifiers are kept here so released installs can upgrade in place.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PRODUCT_NAME = 'Cue'
export const APP_ID = 'io.github.fei2411.dsbot'
export const PREVIOUS_PRODUCT_NAME = 'DS Bot'
export const LEGACY_PRODUCT_NAME = 'DeepSeek Bot'
export const LEGACY_ENGINE = 'deepseek-bot-engine'
export const PREVIOUS_ARTIFACT_PREFIX = 'DS-Bot'
export const LEGACY_ARTIFACT_PREFIX = 'DeepSeek-Bot'

/** Keep the shell data and Chromium encryption identity of an existing installation. */
export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const current = app.getPath('userData')
  const explicit = env.DS_BOT_SHELL_DATA
  // An explicitly isolated run must never discover an installed application.
  const prior = explicit || env.DS_BOT_HOME ? [] : [PREVIOUS_PRODUCT_NAME, LEGACY_PRODUCT_NAME]
    .map(name => ({ name, path: join(app.getPath('appData'), name) }))
  const source = prior.find(entry => exists(join(entry.path, 'locations.json'))) ?? prior.find(entry => exists(entry.path))
  const reuse = source !== undefined && !exists(join(current, 'locations.json'))
  const userData = explicit || (reuse ? source.path : current)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures this name for OSCrypt before ready. Restore the visible name
  // before creating menus or windows; the captured keychain identity stays unchanged.
  if (reuse && platform !== 'win32') {
    app.setName(source.name)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, legacy: reuse }
}
