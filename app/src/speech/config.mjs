import { isAbsolute, join } from 'node:path'

export const SPEECH_PROVIDER_ID = 'sensevoice-local'
export const SPEECH_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

const positive = (env, name, fallback, { zero = false } = {}) => {
  if (env[name] === undefined || env[name] === '') return fallback
  const value = Number(env[name])
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < (zero ? 0 : 1)) throw new Error(`${name} must be ${zero ? 'a non-negative' : 'a positive'} integer`)
  return value
}

const decimal = (env, name, fallback, min, max) => {
  if (env[name] === undefined || env[name] === '') return fallback
  const value = Number(env[name])
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${String(min)} and ${String(max)}`)
  return value
}

const absolute = (value, name) => {
  if (value === undefined || value === '') return undefined
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return value
}

const origin = (value, name) => {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTP origin without credentials, path, query, or fragment`)
  }
  return parsed.origin
}

export function speechConfig({ dataRoot, env = process.env } = {}) {
  const root = absolute(env.DS_BOT_SPEECH_DATA_ROOT || dataRoot, 'speech data root')
  if (root === undefined) throw new Error('speech data root is required')
  const precision = env.DS_BOT_SPEECH_PRECISION || 'int8'
  if (!['int8', 'fp32'].includes(precision)) throw new Error('DS_BOT_SPEECH_PRECISION must be int8 or fp32')
  const selectedOrigin = env.DS_BOT_SPEECH_MODEL_ORIGIN ? origin(env.DS_BOT_SPEECH_MODEL_ORIGIN, 'DS_BOT_SPEECH_MODEL_ORIGIN') : undefined
  const configuredOrigins = (env.DS_BOT_SPEECH_MODEL_ORIGINS || 'https://huggingface.co,https://hf-mirror.com')
    .split(',').map(value => value.trim()).filter(Boolean).map(value => origin(value, 'DS_BOT_SPEECH_MODEL_ORIGINS'))
  if (selectedOrigin === undefined && configuredOrigins.length === 0) throw new Error('DS_BOT_SPEECH_MODEL_ORIGINS must include at least one origin')
  const maxAudioBytes = positive(env, 'DS_BOT_SPEECH_MAX_AUDIO_BYTES', 4 * 1024 * 1024)
  return {
    providerId: SPEECH_PROVIDER_ID,
    dataRoot: root,
    modelDirectory: absolute(env.DS_BOT_SPEECH_MODEL_DIRECTORY, 'DS_BOT_SPEECH_MODEL_DIRECTORY'),
    vadModelPath: absolute(env.DS_BOT_SPEECH_VAD_MODEL, 'DS_BOT_SPEECH_VAD_MODEL'),
    precision,
    modelOrigin: selectedOrigin,
    modelOrigins: [...new Set(configuredOrigins)],
    modelProbeTimeoutMs: positive(env, 'DS_BOT_SPEECH_MODEL_PROBE_TIMEOUT_MS', 3000),
    threads: positive(env, 'DS_BOT_SPEECH_THREADS', 2),
    segmentSeconds: positive(env, 'DS_BOT_SPEECH_SEGMENT_SECONDS', 30),
    vadThreshold: decimal(env, 'DS_BOT_SPEECH_VAD_THRESHOLD', 0.5, 0, 1),
    minSpeechSeconds: decimal(env, 'DS_BOT_SPEECH_MIN_SPEECH_SECONDS', 0.25, 0, 120),
    minSilenceSeconds: decimal(env, 'DS_BOT_SPEECH_MIN_SILENCE_SECONDS', 0.5, 0.01, 120),
    vadOnsetPaddingSeconds: decimal(env, 'DS_BOT_SPEECH_VAD_ONSET_PADDING_SECONDS', 0.3, 0, 1),
    maxAudioBytes,
    maxDurationSeconds: Math.min(120, (maxAudioBytes - 44) / 32000),
    prepareTimeoutMs: positive(env, 'DS_BOT_SPEECH_PREPARE_TIMEOUT_MS', 3_600_000),
    inferenceTimeoutMs: positive(env, 'DS_BOT_SPEECH_INFERENCE_TIMEOUT_MS', 120_000),
    idleTimeoutMs: positive(env, 'DS_BOT_SPEECH_IDLE_TIMEOUT_MS', 300_000, { zero: true }),
    maxPending: positive(env, 'DS_BOT_SPEECH_MAX_PENDING', 4),
    graceMs: positive(env, 'DS_BOT_SPEECH_GRACE_MS', 1000),
    maxLogBytes: positive(env, 'DS_BOT_SPEECH_MAX_LOG_BYTES', 64 * 1024),
    maxResponseBytes: positive(env, 'DS_BOT_SPEECH_MAX_RESPONSE_BYTES', 128 * 1024),
    progressIntervalMs: positive(env, 'DS_BOT_SPEECH_PROGRESS_INTERVAL_MS', 100),
    workerPath: join(import.meta.dirname, 'worker.mjs'),
  }
}
