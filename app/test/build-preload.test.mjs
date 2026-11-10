import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildPreload } from '../scripts/build-preload.mjs'

test('the sandboxed window preload is one bundle with its speech and computer bridges', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-preload-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const output = join(dir, 'preload.cjs')

  await buildPreload(output)

  const source = readFileSync(output, 'utf8')
  assert.match(source, /speech-transcribe/u)
  assert.match(source, /computerCursor/u)
  assert.doesNotMatch(source, /require\(["']\.\//u)
})
