import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { speechConfig } from '../src/speech/config.mjs'
import { SpeechService } from '../src/speech/service.mjs'

const root = process.env.DS_BOT_SPEECH_E2E_ROOT
if (!root || !isAbsolute(root)) {
  console.error('check-speech: DS_BOT_SPEECH_E2E_ROOT must be an absolute cache directory')
  process.exit(2)
}

const audioUrl = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/zh.wav'
const service = await SpeechService.open(speechConfig({ dataRoot: root }))
try {
  const started = service.prepare('sensevoice-local')
  assert.equal(started.ok, true)
  let previous = ''
  const deadline = Date.now() + 3_600_000
  for (;;) {
    const state = service.catalog().providers[0].preparation
    const progress = state.phase === 'downloading' ? `${state.completedBytes}/${state.totalBytes}` : ''
    const line = `${state.phase}:${state.step ?? ''}:${progress}`
    if (line !== previous) { console.log(`check-speech: ${line}`); previous = line }
    if (state.phase === 'ready') break
    if (['failed', 'cancelled'].includes(state.phase)) throw new Error(state.message ?? `Speech preparation ${state.phase}`)
    if (Date.now() > deadline) throw new Error('Speech preparation timed out')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const response = await fetch(audioUrl)
  if (!response.ok) throw new Error(`Speech fixture returned HTTP ${String(response.status)}`)
  const audio = Buffer.from(await response.arrayBuffer())
  const request = { providerId: 'sensevoice-local', language: 'zh', audio }
  const cold = await service.transcribe(request, new AbortController().signal)
  const warm = await service.transcribe(request, new AbortController().signal)
  assert.equal(cold.ok, true, cold.error?.message)
  assert.equal(warm.ok, true, warm.error?.message)
  assert.equal(cold.value.text, '开饭时间早上9点至下午5点。')
  assert.equal(warm.value.text, cold.value.text)
  assert.ok(cold.value.audioSeconds > 0)
  console.log(`check-speech: recognized ${JSON.stringify(cold.value.text)} twice`)
  console.log('check-speech: passed')
} finally {
  await service.dispose()
}
