import { SPEECH_LANGUAGES } from './config.mjs'

export class SpeechInputError extends Error {}

export function validateWave(audio, language, maxAudioBytes) {
  if (!SPEECH_LANGUAGES.includes(language)) throw new SpeechInputError('Unsupported SenseVoice language')
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (data.length > maxAudioBytes) throw new SpeechInputError('Speech audio exceeds the worker byte limit')
  if (data.length < 46 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE' || data.toString('ascii', 12, 16) !== 'fmt '
    || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1
    || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000
    || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16
    || data.toString('ascii', 36, 40) !== 'data' || data.readUInt32LE(4) !== data.length - 8
    || data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 2 !== 0) {
    throw new SpeechInputError('Audio must be a canonical 16 kHz mono PCM16 WAV recording')
  }
  return (data.length - 44) / 32000
}
