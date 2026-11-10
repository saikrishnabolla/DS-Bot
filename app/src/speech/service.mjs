import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { SpeechDownloadError, inspectRuntime, prepareRuntime } from './runtime.mjs'
import { SPEECH_LANGUAGES } from './config.mjs'
import { SpeechInputError, validateWave } from './wave.mjs'

const failure = error => ({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return AbortSignal.any([signal, timeout])
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => { child.once('exit', resolve) })
}

function stopChild(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  child.kill()
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, graceMs)
  timer.unref()
  return waitForExit(child).finally(() => { clearTimeout(timer) })
}

async function readReady(child, limit, signal) {
  signal.throwIfAborted()
  let text = ''
  return await new Promise((resolve, reject) => {
    const done = (run, value) => {
      child.stdout.off('data', data)
      child.stdout.off('error', rejectReady)
      child.off('exit', exited)
      signal.removeEventListener('abort', aborted)
      run(value)
    }
    const rejectReady = error => done(reject, error)
    const aborted = () => rejectReady(signal.reason instanceof Error ? signal.reason : new Error('Speech worker start cancelled'))
    const exited = () => rejectReady(new Error(`Speech worker exited before readiness: ${String(child.stderrText ?? '')}`))
    const data = chunk => {
      text += chunk.toString('utf8')
      if (Buffer.byteLength(text) > limit) { rejectReady(new Error('Speech worker readiness exceeded its byte limit')); return }
      const end = text.indexOf('\n')
      if (end < 0) return
      try {
        const value = JSON.parse(text.slice(0, end))
        if (!Number.isInteger(value?.port) || value.port < 1 || value.port > 65535) throw new Error('port')
        done(resolve, value.port)
      } catch (error) { rejectReady(new Error('Invalid speech worker readiness', { cause: error })) }
    }
    child.stdout.on('data', data)
    child.stdout.on('error', rejectReady)
    child.once('exit', exited)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

async function readTranscript(response, limit) {
  if (!response.body) throw new Error('Speech worker returned no response')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error('Speech transcript exceeded its byte limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!response.ok) {
    const message = typeof value?.error === 'string' ? value.error : 'Speech worker failed'
    if ([400, 413].includes(response.status) && value?.code === 'invalid-input') throw new SpeechInputError(message)
    throw new Error(message)
  }
  if (typeof value?.text !== 'string' || !Number.isFinite(value.audioSeconds) || value.audioSeconds < 0
    || !Number.isFinite(value.inferenceSeconds) || value.inferenceSeconds < 0) throw new Error('Speech worker returned an invalid transcript')
  return value
}

export async function spawnSpeechWorker(config, paths, signal) {
  await mkdir(config.dataRoot, { recursive: true })
  const token = randomBytes(32).toString('hex')
  const child = spawn(process.execPath, [paths.worker, JSON.stringify({ ...config, ...paths })], {
    cwd: config.dataRoot,
    env: { ...process.env, DS_BOT_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderrText = ''
  child.stderr.on('data', chunk => {
    child.stderrText = `${child.stderrText}${chunk.toString('utf8')}`.slice(-config.maxLogBytes)
  })
  try {
    const port = await readReady(child, config.maxLogBytes, signal)
    let closed = false
    return {
      get closed() { return closed || child.exitCode !== null || child.signalCode !== null },
      async transcribe(audio, language, requestSignal) {
        const response = await fetch(`http://127.0.0.1:${String(port)}/transcribe?language=${encodeURIComponent(language)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
          body: audio,
          signal: requestSignal,
        })
        return await readTranscript(response, config.maxResponseBytes)
      },
      async close() {
        if (closed) return
        closed = true
        await stopChild(child, config.graceMs)
      },
    }
  } catch (error) {
    await stopChild(child, config.graceMs)
    throw error
  }
}

export class SpeechService {
  #runtime
  #worker
  #tail = Promise.resolve()
  #pending = 0
  #idle
  #preparing
  #lifetime = new AbortController()
  #state = { phase: 'unprepared' }
  #lastProgressAt = 0

  constructor(config, { runtime = { inspect: inspectRuntime, prepare: prepareRuntime }, workerFactory = spawnSpeechWorker, log = console } = {}) {
    this.config = config
    this.runtime = runtime
    this.workerFactory = workerFactory
    this.log = log
  }

  static async open(config, options) {
    const service = new SpeechService(config, options)
    await service.#inspect()
    return service
  }

  async #inspect() {
    const signal = combinedSignal(this.#lifetime.signal, this.config.prepareTimeoutMs)
    this.#publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
    try {
      this.#runtime = await this.runtime.inspect(this.config, signal)
      this.#publish({ phase: this.#runtime ? 'standby' : 'unprepared' })
    } catch (error) {
      this.#publish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  #publish(state) {
    const now = performance.now()
    if (state.phase === 'downloading' && this.#state.phase === 'downloading' && state.resource === this.#state.resource
      && state.completedBytes !== state.totalBytes && now - this.#lastProgressAt < this.config.progressIntervalMs) return
    this.#lastProgressAt = now
    this.#state = state
  }

  catalog() {
    const estimate = this.config.precision === 'int8' ? 1_000_000_000 : 2_000_000_000
    const origins = this.config.modelOrigin === undefined ? this.config.modelOrigins : [this.config.modelOrigin]
    const downloadSources = this.config.modelDirectory !== undefined && this.config.vadModelPath !== undefined ? [] : [...new Set(origins)]
    return {
      providers: [{
        id: this.config.providerId,
        name: `SenseVoiceSmall (${this.config.precision.toUpperCase()})`,
        location: 'host-local',
        languages: SPEECH_LANGUAGES,
        downloadSources,
        setupEstimate: { recommendedDiskBytes: estimate, expectedMemoryBytes: estimate, minimumMinutes: 1, maximumMinutes: 10 },
        preparation: structuredClone(this.#state),
      }],
      selection: { providerId: this.config.providerId, language: 'auto' },
      maxAudioBytes: this.config.maxAudioBytes,
      maxDurationSeconds: this.config.maxDurationSeconds,
    }
  }

  prepare(providerId) {
    if (providerId !== this.config.providerId) return failure(new Error(`Speech provider is unavailable: ${String(providerId)}`))
    if (this.#preparing || this.#worker) return { ok: true, value: true }
    const controller = new AbortController()
    const signal = combinedSignal(AbortSignal.any([controller.signal, this.#lifetime.signal]), this.config.prepareTimeoutMs)
    this.#preparing = { controller, task: undefined }
    const task = this.#enqueue(async () => { await this.#start(signal) }, signal)
      .catch(error => {
        if (this.#lifetime.signal.aborted) return
        this.#publish(signal.aborted && controller.signal.aborted ? { phase: 'cancelled' } : {
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof SpeechDownloadError ? { download: error.download } : {}),
        })
      }).finally(() => { this.#preparing = undefined })
    this.#preparing.task = task
    return { ok: true, value: true }
  }

  async #start(signal) {
    if (this.#worker?.closed) await this.#stopWorker()
    if (this.#worker) return this.#worker
    const cached = this.#runtime !== undefined
    if (!cached) {
      this.#publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
      this.#runtime = await this.runtime.prepare(this.config, signal, state => this.#publish(state))
    }
    signal.throwIfAborted()
    this.#publish({ phase: cached ? 'waking' : 'loading', step: 'load', startedAt: Date.now() })
    this.#worker = await this.workerFactory(this.config, this.#runtime, signal)
    this.#publish({ phase: 'ready' })
    return this.#worker
  }

  #enqueue(run, signal) {
    const combined = AbortSignal.any([signal, this.#lifetime.signal])
    combined.throwIfAborted()
    if (this.#pending >= this.config.maxPending) throw new Error('Speech transcription queue is full')
    clearTimeout(this.#idle)
    this.#pending += 1
    const job = this.#tail.then(async () => {
      combined.throwIfAborted()
      return await run(combined)
    })
    this.#tail = job.then(() => undefined, () => undefined).finally(() => {
      this.#pending -= 1
      if (this.#pending === 0 && !this.#lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
        this.#idle = setTimeout(() => {
          this.#tail = this.#tail.then(async () => { await this.#stopWorker() })
          void this.#tail.catch(error => { this.log.warn?.('Speech worker idle cleanup failed', error) })
        }, this.config.idleTimeoutMs)
        this.#idle.unref?.()
      }
    })
    return job
  }

  async transcribe(request, signal) {
    try {
      if (request?.providerId !== this.config.providerId) throw new Error(`Speech provider is unavailable: ${String(request?.providerId)}`)
      const language = request?.language ?? 'auto'
      const audio = Buffer.from(request?.audio ?? [])
      validateWave(audio, language, this.config.maxAudioBytes)
      if (!['ready', 'standby'].includes(this.#state.phase)) throw new Error('Prepare the local speech provider before recording')
      const transcript = await this.#enqueue(async combined => {
        try {
          const worker = await this.#start(combinedSignal(combined, this.config.prepareTimeoutMs))
          return await worker.transcribe(audio, language, combinedSignal(combined, this.config.inferenceTimeoutMs))
        } catch (error) {
          if (!(error instanceof SpeechInputError)) {
            await this.#stopWorker()
            if (this.#runtime !== undefined) this.#publish({ phase: 'standby' })
          }
          throw error
        }
      }, signal)
      return { ok: true, value: transcript }
    } catch (error) { return failure(error) }
  }

  async #stopWorker() {
    const worker = this.#worker
    if (!worker) return
    this.#worker = undefined
    await worker.close()
    if (this.#runtime !== undefined && !this.#lifetime.signal.aborted) this.#publish({ phase: 'standby' })
  }

  async dispose() {
    if (this.#lifetime.signal.aborted) return
    this.#lifetime.abort(new Error('Speech service disposed'))
    this.#preparing?.controller.abort(new Error('Speech service disposed'))
    clearTimeout(this.#idle)
    await Promise.allSettled([this.#tail, this.#preparing?.task])
    await this.#stopWorker()
  }
}
