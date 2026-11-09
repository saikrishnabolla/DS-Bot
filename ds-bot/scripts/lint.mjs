// Usage: npm run lint [-- <oxlint options>]
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const plugin = resolve(import.meta.dirname, '..')
// Node runs oxlint's own script: on Windows it cannot spawn the .cmd shim in node_modules/.bin
// without a shell.
const bin = join(plugin, 'node_modules', 'oxlint', 'bin', 'oxlint')
const result = spawnSync(process.execPath, [bin, '-c', '.oxlintrc.json', ...process.argv.slice(2), 'index.js', 'web-search.js', 'src', 'dev', 'scripts', 'test'], { cwd: plugin, stdio: 'inherit' })
if (result.error) console.error(`lint: ${result.error.message}`)
process.exit(result.status ?? 1)
