// Released macOS and deb clients require their old asset name before showing an update.
// Publish aliases of the Cue payload so both prior product generations keep working.
import { copyFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LEGACY_ARTIFACT_PREFIX, PREVIOUS_ARTIFACT_PREFIX } from '../src/legacy.mjs'

for (const file of process.argv.slice(2)) {
  const name = basename(file)
  if (!/^Cue-.+-(?:mac-(?:arm64|x64)\.zip|linux-amd64\.deb)$/u.test(name)) throw new Error(`Unsupported release alias: ${name}`)
  for (const prefix of [PREVIOUS_ARTIFACT_PREFIX, LEGACY_ARTIFACT_PREFIX]) {
    const alias = join(dirname(file), name.replace(/^Cue/u, prefix))
    copyFileSync(file, alias)
    console.log(alias)
  }
}
