import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildPreload(output = join(root, 'build', 'preload.cjs')) {
  await mkdir(dirname(output), { recursive: true })
  await build({
    entryPoints: [join(root, 'src', 'preload.cjs')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    external: ['electron'],
    logLevel: 'silent',
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await buildPreload()
