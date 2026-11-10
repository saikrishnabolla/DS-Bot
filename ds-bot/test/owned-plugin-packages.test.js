import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { OwnedPluginPackages } from '../src/engine/owned-plugin-packages.js'

const execFile = promisify(execFileCallback)

async function fixture(t, body = 'api.events.push(`loaded:${api.package.version}`); return () => api.events.push("disposed")') {
  const root = await mkdtemp(join(tmpdir(), 'cue-plugin-packages-'))
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  const packagePath = join(root, 'package')
  await mkdir(workspacePath, { recursive: true })
  await mkdir(join(packagePath, 'skills', 'example'), { recursive: true })
  await writeFile(join(packagePath, 'package.json'), `${JSON.stringify({
    name: 'cue-example',
    version: '1.0.0',
    cue: { plugins: ['./plugin.mjs'] },
    pi: { skills: ['./skills/example'] },
  }, null, 2)}\n`)
  await writeFile(join(packagePath, 'plugin.mjs'), `export default async function (api) { ${body} }\n`)
  await writeFile(join(packagePath, 'skills', 'example', 'SKILL.md'), '# Example\n')
  const events = []
  const open = () => OwnedPluginPackages.open({ dataDir, workspacePath, api: { events } })
  const manager = await open()
  t.after(() => manager.close())
  return { root, dataDir, workspacePath, packagePath, events, manager, open }
}

test('local Cue packages install, activate, persist, inspect, disable, enable, and remove', async t => {
  const env = await fixture(t)
  const installed = await env.manager.install(env.packagePath)
  assert.equal(installed.name, 'cue-example')
  assert.equal(installed.state, 'active')
  assert.deepEqual(env.events, ['loaded:1.0.0'])
  assert.deepEqual(installed.entries.map(path => path.endsWith('/plugin.mjs')), [true])
  assert.equal(installed.skills.length, 1)

  const inspected = await env.manager.read(installed.source)
  assert.equal(inspected.manifest.name, 'cue-example')
  assert.equal(inspected.fingerprint, inspected.approvedFingerprint)

  await env.manager.disable(installed.source)
  assert.equal((await env.manager.read(installed.source)).state, 'disabled')
  assert.deepEqual(env.events, ['loaded:1.0.0', 'disposed'])

  await env.manager.enable(installed.source)
  assert.equal((await env.manager.read(installed.source)).state, 'active')
  assert.deepEqual(env.events, ['loaded:1.0.0', 'disposed', 'loaded:1.0.0'])

  await env.manager.close()
  const restarted = await env.open()
  t.after(() => restarted.close())
  assert.equal((await restarted.read(installed.source)).state, 'active')
  assert.deepEqual(env.events, ['loaded:1.0.0', 'disposed', 'loaded:1.0.0', 'disposed', 'loaded:1.0.0'])

  assert.equal(await restarted.remove(installed.source), true)
  assert.deepEqual(await restarted.list(), [])
  assert.equal(await readFile(join(env.dataDir, 'plugin-runtime', 'settings.json'), 'utf8').then(JSON.parse).then(value => value.packages.length), 0)
})

test('changed package code is approval-required on restart and reload approves the new fingerprint', async t => {
  const env = await fixture(t)
  await writeFile(join(env.packagePath, 'helper.mjs'), 'export const version = "v1"\n')
  await writeFile(join(env.packagePath, 'plugin.mjs'), 'import { version } from "./helper.mjs"; export default api => { api.events.push(`loaded:${version}`) }\n')
  const installed = await env.manager.install(env.packagePath)
  await env.manager.close()
  await writeFile(join(env.packagePath, 'helper.mjs'), 'export const version = "v2"\n')

  const restarted = await env.open()
  t.after(() => restarted.close())
  const held = await restarted.read(installed.source)
  assert.equal(held.state, 'approval-required')
  assert.notEqual(held.fingerprint, held.approvedFingerprint)
  assert.deepEqual(env.events, ['loaded:v1'])

  const reloaded = await restarted.reload(installed.source)
  assert.equal(reloaded.state, 'active')
  assert.equal(reloaded.fingerprint, reloaded.approvedFingerprint)
  assert.deepEqual(env.events, ['loaded:v1', 'loaded:v2'])

  await writeFile(join(env.packagePath, 'helper.mjs'), 'export const version = "v3"\n')
  const updated = await restarted.update(installed.source)
  assert.equal(updated.state, 'active')
  assert.equal(updated.fingerprint, updated.approvedFingerprint)
  assert.deepEqual(env.events, ['loaded:v1', 'loaded:v2', 'loaded:v3'])
})

test('a changed staged copy is rebuilt from the approved package before a new process imports it', async t => {
  const env = await fixture(t)
  const installed = await env.manager.install(env.packagePath)
  await env.manager.close()
  await writeFile(join(env.dataDir, 'plugin-runtime', 'cache', installed.fingerprint, 'plugin.mjs'), `
export default async function (api) { api.events.push('loaded:tampered') }
`)

  const script = `
import { OwnedPluginPackages } from ${JSON.stringify(new URL('../src/engine/owned-plugin-packages.js', import.meta.url).href)}
const [dataDir, workspacePath, source] = process.argv.slice(1)
const events = []
const manager = await OwnedPluginPackages.open({ dataDir, workspacePath, api: { events } })
const row = await manager.read(source)
await manager.close()
console.log(JSON.stringify({ state: row.state, events }))
`
  const { stdout } = await execFile(process.execPath, ['--input-type=module', '--eval', script,
    env.dataDir, env.workspacePath, installed.source])
  assert.deepEqual(JSON.parse(stdout), { state: 'active', events: ['loaded:1.0.0', 'disposed'] })
})

test('ordinary Pi extension packages stay installed but are never executed as Cue plugins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cue-incompatible-package-'))
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  const packagePath = join(root, 'package')
  await mkdir(workspacePath, { recursive: true })
  await mkdir(join(packagePath, 'extensions'), { recursive: true })
  await writeFile(join(packagePath, 'package.json'), `${JSON.stringify({ name: 'pi-only', version: '1.0.0', pi: { extensions: ['./extensions/index.mjs'] } })}\n`)
  await writeFile(join(packagePath, 'extensions', 'index.mjs'), 'throw new Error("must not execute")\n')
  const manager = await OwnedPluginPackages.open({ dataDir, workspacePath, api: {} })
  t.after(() => manager.close())

  const installed = await manager.install(packagePath)
  assert.equal(installed.state, 'incompatible')
  assert.match(installed.error, /Cue plugin entry/)
  assert.equal(installed.entries.length, 0)
})

test('an approved client-only package exposes authenticated browser modules without running them on the host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cue-client-package-'))
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  const packagePath = join(root, 'package')
  await mkdir(workspacePath, { recursive: true })
  await mkdir(join(packagePath, 'client'), { recursive: true })
  await writeFile(join(packagePath, 'package.json'), `${JSON.stringify({
    name: 'cue-client-only',
    version: '1.0.0',
    cue: { client: ['./client/index.mjs'] },
  })}\n`)
  await writeFile(join(packagePath, 'client', 'index.mjs'), 'export default api => api.ui.register("settings.page", { id: "hello", label: "Hello" }, () => null)\n')
  const manager = await OwnedPluginPackages.open({ dataDir, workspacePath, api: {} })
  t.after(() => manager.close())

  const installed = await manager.install(packagePath)
  assert.equal(installed.state, 'active')
  assert.deepEqual(installed.entries, [])
  assert.deepEqual(installed.clientEntries.map(path => path.endsWith('/client/index.mjs')), [true])
  assert.deepEqual(await manager.clientEntries(), [{
    source: installed.source,
    name: 'cue-client-only',
    version: '1.0.0',
    fingerprint: installed.fingerprint,
    entries: ['client/index.mjs'],
  }])
  const asset = await manager.clientAsset(installed.fingerprint, 'client/index.mjs')
  assert.match(asset.data.toString('utf8'), /settings\.page/)
  assert.equal(asset.path, 'client/index.mjs')
  await assert.rejects(manager.clientAsset(installed.fingerprint, '../plugin.mjs'), /not found|inside/i)
})

test('invalid Cue entry paths fail closed without importing code outside the package', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cue-invalid-package-'))
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  const packagePath = join(root, 'package')
  await mkdir(workspacePath, { recursive: true })
  await mkdir(packagePath, { recursive: true })
  await writeFile(join(root, 'outside.mjs'), 'throw new Error("must not execute")\n')
  await writeFile(join(packagePath, 'package.json'), `${JSON.stringify({ name: 'escape', version: '1.0.0', cue: { plugins: ['../outside.mjs'] } })}\n`)
  const manager = await OwnedPluginPackages.open({ dataDir, workspacePath, api: {} })
  t.after(() => manager.close())

  const installed = await manager.install(packagePath)
  assert.equal(installed.state, 'error')
  assert.match(installed.error, /inside the package/)
})

test('package discovery searches the maintained Pi package namespace without claiming runtime compatibility', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cue-package-search-'))
  const requests = []
  const manager = await OwnedPluginPackages.open({
    dataDir: join(root, 'data'),
    workspacePath: root,
    fetch: async url => {
      requests.push(String(url))
      return new Response(JSON.stringify({ objects: [{ package: {
        name: '@example/pi-review',
        version: '2.1.0',
        description: 'Review helpers',
        keywords: ['pi-package'],
        links: { npm: 'https://www.npmjs.com/package/@example/pi-review' },
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  t.after(() => manager.close())

  const rows = await manager.search('review')
  assert.equal(new URL(requests[0]).searchParams.get('text'), 'keywords:pi-package review')
  assert.deepEqual(rows, [{
    name: '@example/pi-review',
    version: '2.1.0',
    description: 'Review helpers',
    source: 'npm:@example/pi-review@2.1.0',
    url: 'https://www.npmjs.com/package/@example/pi-review',
    keywords: ['pi-package'],
    compatibility: 'pi-package',
  }])
})
