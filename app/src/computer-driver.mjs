import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const permissionError = status => Object.assign(new Error('Computer use needs Accessibility and Screen Recording permission'), {
  code: 'computer/permissions', status,
})

export const packagedComputerModule = (resourcesPath, file, platform = process.platform) => pathToFileURL(join(
  resourcesPath, platform === 'linux' ? 'app' : 'app.asar.unpacked', 'node_modules', '@trycua', 'cua-driver', 'dist', file,
)).href

export class ComputerDriverHost {
  #driver
  #starting
  #stopping

  constructor({ platform = process.platform, loadDriver = () => import('@trycua/cua-driver'),
    loadPermissions = () => import('@trycua/cua-driver/electron'), openExternal, log = console } = {}) {
    this.platform = platform
    this.loadDriver = loadDriver
    this.loadPermissions = loadPermissions
    this.openExternal = openExternal
    this.log = log
  }

  async systemStatus() {
    if (this.platform !== 'darwin') return { accessibility: true, screenRecording: true }
    const { currentMacOsPermissionStatus } = await this.loadDriver()
    return currentMacOsPermissionStatus()
  }

  async requestPermission(permission) {
    if (this.platform !== 'darwin') return this.systemStatus()
    const { requestMacOSPermissions, openMacOSScreenRecordingSettings } = await this.loadPermissions()
    const status = requestMacOSPermissions()
    if (permission === 'screenRecording' && !status.screenRecording) await openMacOSScreenRecordingSettings()
    return status
  }

  async openSettings(permission) {
    if (this.platform !== 'darwin') return false
    if (permission === 'screenRecording') {
      const { openMacOSScreenRecordingSettings } = await this.loadPermissions()
      await openMacOSScreenRecordingSettings()
      return true
    }
    if (typeof this.openExternal !== 'function') return false
    await this.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    return true
  }

  async start() {
    await this.#stopping
    if (this.#driver !== undefined) return this.#driver
    this.#starting ??= (async () => {
      const status = await this.systemStatus()
      if (!status.accessibility || !status.screenRecording) throw permissionError(status)
      const { CuaDriver } = await this.loadDriver()
      const driver = CuaDriver.create({ embedded: true })
      this.#driver = driver
      return driver
    })()
    try { return await this.#starting }
    finally { this.#starting = undefined }
  }

  async handle(action, payload = {}, { signal } = {}) {
    if (action === 'system-status') return this.systemStatus()
    if (action === 'request-permission') return this.requestPermission(payload.permission)
    if (action === 'open-settings') return this.openSettings(payload.permission)
    if (action === 'stop') { await this.stop(); return true }
    const driver = await this.start()
    if (action === 'list-tools') return driver.listToolsJson()
    if (action === 'call-tool') return driver.callTool(String(payload.name), String(payload.raw ?? '{}'), signal === undefined ? undefined : { signal })
    throw new Error(`Unknown computer driver action: ${String(action)}`)
  }

  async stop() {
    if (this.#stopping !== undefined) return this.#stopping
    const starting = this.#starting
    this.#stopping = (async () => {
      await starting?.catch(() => undefined)
      const driver = this.#driver
      this.#driver = undefined
      if (driver === undefined) return
      try { await driver.shutdown() }
      catch (error) { this.log.warn?.('Computer driver shutdown failed', error) }
      finally { driver.uniffiDestroy?.() }
    })().finally(() => { this.#stopping = undefined })
    return this.#stopping
  }
}
