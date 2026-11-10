import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { OwnedHost } from 'ds-bot/host'
import { ComputerRemote } from './computer-remote.mjs'

const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024
const here = dirname(fileURLToPath(import.meta.url))

const send = message => new Promise((resolve, reject) => {
  if (!process.connected || process.send === undefined) { resolve(); return }
  process.send(message, error => { if (error === null) resolve(); else reject(error) })
})

async function main() {
  const dataDir = process.env.DS_BOT_DATA_DIR
  if (!dataDir) throw new Error('DS Bot data directory is not set')
  const computer = new ComputerRemote(send)
  const remote = (action, payload, options) => computer.request(action, payload, options)
  const driverFactory = async () => ({
    listToolsJson: async () => await remote('list-tools'),
    callTool: async (name, raw, options) => await remote('call-tool', { name, raw }, options),
    shutdown: async () => { await remote('stop') },
    uniffiDestroy() {},
  })
  const access = {
    systemStatus: async () => await remote('system-status'),
    requestPermission: async permission => await remote('request-permission', { permission }),
    openSettings: async permission => await remote('open-settings', { permission }),
  }
  const owned = await OwnedHost.open({
    dataDir,
    uiDir: join(here, '..', 'ui', 'dist'),
    workspacePath: process.env.DS_BOT_WORKSPACE,
    port: Number(process.env.DS_BOT_PORT || 0),
    computerUse: { driverFactory, access },
  })
  let stopping
  const stop = () => stopping ??= (async () => {
    await owned.close()
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', message => {
    if (message?.type === 'shutdown') { void stop(); return }
    computer.accept(message)
  })
  process.once('disconnect', () => {
    computer.disconnect()
    void stop()
  })
  await send({ type: 'ready', url: owned.launchUrl, injections: [] })
}

main().catch(async error => {
  console.error(error)
  process.exitCode = 1
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
  await send({ type: 'fatal', message, diagnostic }).catch(() => undefined)
  if (process.connected) process.disconnect()
})
