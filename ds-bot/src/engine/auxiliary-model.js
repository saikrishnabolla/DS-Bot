import { retryDelayMs } from '@earendil-works/pi-ai'
import { BlockAssembler } from './messages.js'
import { modelFailure } from './model-failure.js'

const TRANSIENT_CODES = new Set(['TRANSPORT', 'TIMEOUT'])
const DEFAULT_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 }

const canRetry = (failure, attempt, policy) => policy.enabled === true
  && attempt <= policy.maxRetries
  && TRANSIENT_CODES.has(failure?.code)

function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedAssembler(failure) {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'error', reason: 'aborted', error: { failure: failure ?? { code: 'ABORTED', message: 'Stopped' } } })
  return assembler
}

export async function assembleAuxiliaryModel(ctx, options, { signal, policy = DEFAULT_RETRY, waitForRetry = wait } = {}) {
  const fused = options.signal && signal
    ? AbortSignal.any([options.signal, signal])
    : options.signal ?? signal
  const request = fused === options.signal ? options : { ...options, signal: fused }
  for (let attempt = 1; ; attempt += 1) {
    const assembler = new BlockAssembler()
    let thrown
    try {
      for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
    } catch (error) {
      thrown = error
    }
    if (thrown !== undefined) {
      const failure = modelFailure(thrown)
      if (fused?.aborted || !canRetry(failure, attempt, policy)) throw thrown
      if (!await waitForRetry(retryDelayMs(policy, attempt), fused)) throw fused?.reason ?? thrown
      continue
    }
    const finish = assembler.finish
    if (finish.kind !== 'error' || fused?.aborted || !canRetry(finish.failure, attempt, policy)) return assembler
    if (!await waitForRetry(retryDelayMs(policy, attempt), fused)) return abortedAssembler(finish.failure)
  }
}

export const auxiliaryRetryPolicy = override => ({ ...DEFAULT_RETRY, ...override })
