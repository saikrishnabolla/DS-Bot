import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadAttachment } from '../src/api.js'

test('attachment upload sends raw bytes and encoded metadata to the owned route', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ ok: true, value: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'résumé.pdf', bytes: 3, mediaType: 'application/pdf' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const file = new File([Buffer.from('pdf')], 'résumé.pdf', { type: 'application/pdf' })
  const reference = await uploadAttachment(file)
  assert.equal(request.url, 'api/bot/upload')
  assert.equal(request.options.body, file)
  assert.equal(request.options.headers['x-dsbot-file-name'], encodeURIComponent('résumé.pdf'))
  assert.equal(request.options.headers['x-dsbot-upload'], '1')
  assert.equal(reference.name, 'résumé.pdf')
})

test('attachment upload surfaces the host refusal', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { message: 'File is too large' } }), {
    status: 413,
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(uploadAttachment(new File(['large'], 'large.bin')), /File is too large/)
})
