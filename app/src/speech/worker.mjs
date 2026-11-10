import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { SPEECH_LANGUAGES } from './config.mjs'
import { SpeechInputError, validateWave } from './wave.mjs'

function readConfig() {
  const value = JSON.parse(process.argv[2] ?? 'null')
  if (value === null || typeof value !== 'object') throw new Error('Speech worker configuration is missing')
  for (const name of ['model', 'tokens', 'vad']) if (typeof value[name] !== 'string' || !isAbsolute(value[name])) throw new Error(`Speech worker ${name} path is invalid`)
  for (const name of ['threads', 'segmentSeconds', 'maxAudioBytes']) if (!Number.isFinite(value[name]) || value[name] <= 0) throw new Error(`Speech worker ${name} is invalid`)
  return value
}

function createTranscriber(config) {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: config.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: config.tokens,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
  }
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  const detector = new sherpa.Vad({
    sileroVad: {
      model: config.vad,
      threshold: config.vadThreshold,
      minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds,
      maxSpeechDuration: config.segmentSeconds,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: config.threads,
    provider: 'cpu',
    debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1)
  return (audio, language) => {
    const audioSeconds = validateWave(audio, language, config.maxAudioBytes)
    const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44)
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, index) => pcm.getInt16(index * 2, true) / 32768)
    nativeConfig.modelConfig.senseVoice.language = language
    recognizer.setConfig(nativeConfig)
    detector.reset()
    const started = performance.now()
    const texts = []
    const onsetPadding = Math.round(config.vadOnsetPaddingSeconds * 16000)
    let first = true
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false)
        let speech = segment.samples
        if (first) {
          first = false
          const from = Math.max(0, segment.start - onsetPadding)
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length)
            restored.set(samples.subarray(from, segment.start))
            restored.set(speech, segment.start - from)
            speech = restored
          }
        }
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: speech })
        recognizer.decode(stream)
        texts.push(recognizer.getResult(stream).text.trim())
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    detector.flush()
    drain()
    return { text: texts.filter(Boolean).join(' ').trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
  }
}

async function startServer(token, config, transcribe) {
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume()
      reply(401, { error: 'Unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'POST' || url.pathname !== '/transcribe') {
      request.resume()
      reply(404, { error: 'Unknown endpoint' })
      return
    }
    const length = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(length) || length < 46 || length > config.maxAudioBytes) {
      request.resume()
      reply(413, { error: 'Invalid speech audio size', code: 'invalid-input' })
      return
    }
    void (async () => {
      try {
        const chunks = []
        let received = 0
        for await (const chunk of request) {
          received += chunk.length
          if (received > config.maxAudioBytes) throw new SpeechInputError('Speech audio exceeds the worker byte limit')
          chunks.push(chunk)
        }
        const language = url.searchParams.get('language') ?? 'auto'
        if (!SPEECH_LANGUAGES.includes(language)) throw new SpeechInputError('Unsupported SenseVoice language')
        reply(200, transcribe(Buffer.concat(chunks), language))
      } catch (error) {
        reply(error instanceof SpeechInputError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof SpeechInputError ? { code: 'invalid-input' } : {}),
        })
      }
    })()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return server.address().port
}

async function main() {
  const config = readConfig()
  const token = process.env.DS_BOT_SPEECH_TOKEN
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) throw new Error('Speech worker token is invalid')
  delete process.env.DS_BOT_SPEECH_TOKEN
  const port = await startServer(token, config, createTranscriber(config))
  process.stdout.write(`${JSON.stringify({ port })}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => { process.exit(1) })
})
