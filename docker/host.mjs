import { mkdir } from 'node:fs/promises'
import { OwnedHost } from '../ds-bot/src/engine/owned-host.js'

const dataDir = process.env.CUE_DATA_DIR || '/data'
const workspacePath = process.env.CUE_WORKSPACE || '/workspace'
const host = process.env.CUE_HOST || '0.0.0.0'
const port = Number(process.env.CUE_PORT || 3080)
const publicOrigin = process.env.CUE_PUBLIC_ORIGIN || 'http://localhost:3080'

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CUE_PORT must be a valid port')

await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(workspacePath, { recursive: true }),
])

const cue = await OwnedHost.open({
  dataDir,
  workspacePath,
  uiDir: '/app/app/ui/dist',
  host,
  port,
  publicOrigin,
})

console.log(`Cue is ready at ${cue.launchUrl}`)

let closing
const close = () => {
  closing ??= cue.close().finally(() => process.exit(0))
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
