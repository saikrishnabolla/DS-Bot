// A file: dependency is copied by npm, so edits made after npm install otherwise leave
// the Electron Host older than the renderer built from this checkout.
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(appRoot, '..', 'ds-bot')
const target = resolve(appRoot, 'node_modules', 'ds-bot')
if (target !== join(appRoot, 'node_modules', 'ds-bot')) throw new Error('Refusing to replace an unexpected dependency path')

const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
if (manifest.name !== 'ds-bot' || !Array.isArray(manifest.files)) throw new Error('The local ds-bot package manifest is invalid')

await mkdir(target, { recursive: true })
for (const entry of ['package.json', 'LICENSE', ...manifest.files]) {
  const from = resolve(source, entry)
  const to = resolve(target, entry)
  if (from !== source && !from.startsWith(`${source}/`)) throw new Error(`Invalid ds-bot package entry: ${entry}`)
  if (to !== target && !to.startsWith(`${target}/`)) throw new Error(`Invalid installed ds-bot package entry: ${entry}`)
  await rm(to, { recursive: true, force: true })
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true, force: true })
}
