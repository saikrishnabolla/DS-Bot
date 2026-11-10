import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { speechConfig } from '../src/speech/config.mjs'
import { inspectRuntime, prepareRuntime } from '../src/speech/runtime.mjs'
import { SpeechService } from '../src/speech/service.mjs'
import { SpeechHost } from '../src/speech/host.mjs'
import { SpeechRequests } from '../src/speech/requests.mjs'
import { validateWave } from '../src/speech/wave.mjs'
import { speechBridge } from '../src/speech-preload.cjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

function wave(samples = 160) {
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}

test('speech configuration is portable and validates deployment overrides', () => {
  const root = join(tmpdir(), 'speech-config')
  const configured = speechConfig({ dataRoot: root, env: {
    DS_BOT_SPEECH_THREADS: '4',
    DS_BOT_SPEECH_MODEL_ORIGIN: 'https://models.example',
    DS_BOT_SPEECH_IDLE_TIMEOUT_MS: '0',
  } })
  assert.equal(configured.dataRoot, root)
  assert.equal(configured.threads, 4)
  assert.equal(configured.modelOrigin, 'https://models.example')
  assert.equal(configured.idleTimeoutMs, 0)
  assert.throws(() => speechConfig({ dataRoot: root, env: { DS_BOT_SPEECH_MODEL_DIRECTORY: 'relative' } }), /absolute path/u)
  assert.throws(() => speechConfig({ dataRoot: root, env: { DS_BOT_SPEECH_MODEL_ORIGIN: 'https://user:secret@example.com' } }), /without credentials/u)
})

test('managed speech assets download atomically and restore only after hash verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-speech-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bodies = {
    'model.int8.onnx': Buffer.from('model'),
    'tokens.txt': Buffer.from('tokens'),
    'silero_vad.onnx': Buffer.from('vad'),
  }
  const server = createServer((request, response) => {
    const body = bodies[basename(new URL(request.url, 'http://localhost').pathname)]
    if (!body) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-length': body.length })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${String(server.address().port)}`
  const asset = (name, path) => ({ name, url: `${origin}/models/resolve/revision/${path}`, bytes: bodies[name].length, sha256: sha256(bodies[name]) })
  const assets = {
    models: { int8: asset('model.int8.onnx', 'model.int8.onnx'), fp32: asset('model.int8.onnx', 'model.int8.onnx') },
    tokens: asset('tokens.txt', 'tokens.txt'),
    vad: asset('silero_vad.onnx', 'silero_vad.onnx'),
  }
  const config = speechConfig({ dataRoot: root, env: { DS_BOT_SPEECH_MODEL_ORIGIN: origin } })
  const signal = new AbortController().signal
  assert.equal(await inspectRuntime(config, signal, assets), undefined)
  const states = []
  const paths = await prepareRuntime(config, signal, state => { states.push(state) }, { assets })
  assert.deepEqual(await Promise.all([paths.model, paths.tokens, paths.vad].map(path => readFile(path))), [bodies['model.int8.onnx'], bodies['tokens.txt'], bodies['silero_vad.onnx']])
  assert.deepEqual(await inspectRuntime(config, signal, assets), paths)
  assert.ok(states.some(state => state.phase === 'downloading' && state.completedBytes === state.totalBytes))
})

test('owned speech service keeps the catalog contract, serializes inference, and cancels active work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-speech-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = speechConfig({ dataRoot: root, env: { DS_BOT_SPEECH_IDLE_TIMEOUT_MS: '0' } })
  const calls = []
  let closeCount = 0
  const runtime = {
    inspect: async () => undefined,
    prepare: async (_config, _signal, report) => { report({ phase: 'downloading', completedBytes: 1, totalBytes: 1 }); return { model: '/model', tokens: '/tokens', vad: '/vad', worker: '/worker' } },
  }
  const workerFactory = async () => ({
    closed: false,
    async transcribe(audio, language, signal) {
      calls.push(language)
      if (language === 'yue') await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
      return { text: ' hello ', audioSeconds: validateWave(audio, language, config.maxAudioBytes), inferenceSeconds: 0.01 }
    },
    async close() { closeCount += 1 },
  })
  const service = await SpeechService.open(config, { runtime, workerFactory })
  t.after(() => service.dispose())
  assert.equal(service.catalog().providers[0].preparation.phase, 'unprepared')
  assert.equal(service.prepare('sensevoice-local').ok, true)
  for (let count = 0; service.catalog().providers[0].preparation.phase !== 'ready'; count += 1) {
    if (count > 100) assert.fail('speech preparation did not finish')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const audio = wave()
  assert.deepEqual(await service.transcribe({ providerId: 'sensevoice-local', language: 'en', audio }, new AbortController().signal), {
    ok: true, value: { text: ' hello ', audioSeconds: 0.01, inferenceSeconds: 0.01 },
  })
  const cancelled = new AbortController()
  const pending = service.transcribe({ providerId: 'sensevoice-local', language: 'yue', audio }, cancelled.signal)
  for (let count = 0; !calls.includes('yue'); count += 1) {
    if (count > 100) assert.fail('speech inference did not start')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  cancelled.abort(new Error('cancelled by test'))
  assert.equal((await pending).ok, false)
  assert.equal(service.catalog().providers[0].preparation.phase, 'standby')
  assert.equal(closeCount, 1)
})

test('preload speech bridge sanitizes requests and sends explicit cancellation', async () => {
  const calls = []
  const ipc = {
    invoke: async (...args) => { calls.push(['invoke', ...args]); return { ok: true } },
    send: (...args) => { calls.push(['send', ...args]) },
  }
  const bridge = speechBridge(ipc)
  await bridge.catalog()
  await bridge.prepare(42)
  await bridge.transcribe('request-1', { audioBase64: 'YQ==', providerId: 'local', language: 'en', ignored: 'value' })
  bridge.cancel('request-1')
  assert.deepEqual(calls, [
    ['invoke', 'ds-bot:speech-catalog'],
    ['invoke', 'ds-bot:speech-prepare', '42'],
    ['invoke', 'ds-bot:speech-transcribe', 'request-1', { audioBase64: 'YQ==', providerId: 'local', language: 'en' }],
    ['send', 'ds-bot:speech-cancel', 'request-1'],
  ])
})

test('speech host retries a failed open and shutdown recovers a rejected serial tail', async () => {
  const disposed = []
  let opens = 0
  const host = new SpeechHost({
    config: ({ dataRoot }) => ({ dataRoot }),
    open: async ({ dataRoot }) => {
      opens += 1
      if (opens === 1) throw new Error('first open failed')
      return { dataRoot, dispose: async () => { disposed.push(dataRoot) } }
    },
  })
  await assert.rejects(host.use('/speech-a'), /first open failed/u)
  assert.equal((await host.use('/speech-a')).dataRoot, '/speech-a')
  await host.stop()
  assert.deepEqual(disposed, ['/speech-a'])
  await host.stop()
})

test('speech request cancellation survives service initialization and window teardown', async () => {
  const requests = new SpeechRequests()
  const listeners = new Map()
  const sender = {
    id: 7,
    once: (name, listener) => { listeners.set(name, listener) },
    off: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name) },
  }
  const first = requests.begin(sender, 'one')
  requests.cancel(sender, 'one')
  assert.equal(first.signal.aborted, true)
  first.end()
  const second = requests.begin(sender, 'two')
  listeners.get('destroyed')()
  assert.equal(second.signal.aborted, true)
  second.end()
  const third = requests.begin(sender, 'three')
  requests.cancelAll()
  assert.equal(third.signal.aborted, true)
  assert.equal(listeners.has('destroyed'), false)
})
