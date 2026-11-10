const STABLE_CODES = new Set([
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'QUOTA', 'TRANSPORT', 'TIMEOUT',
  'RATE_LIMIT', 'SERVER', 'INTERRUPTED', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST',
])

const string = value => (typeof value === 'string' ? value.trim() : '')

const header = (headers, name) => {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined
  if (headers === null || typeof headers !== 'object') return undefined
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return found === undefined ? undefined : String(found[1])
}

const statusOf = (error, response, message) => {
  const value = error?.status ?? error?.statusCode ?? response?.status
  const status = Number(value)
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  const leading = /^(?:HTTP(?:\/\d(?:\.\d)?)?\s+)?([45]\d{2})\b/i.exec(message)
  return leading === null ? undefined : Number(leading[1])
}

const messageOf = error => string(error?.message ?? error?.errorMessage ?? error)

function codeOf(error, status, message) {
  const supplied = string(error?.code).toUpperCase().replaceAll('-', '_')
  if (STABLE_CODES.has(supplied)) return supplied
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status !== undefined && status >= 400) return 'INVALID_REQUEST'

  if (/\b(?:no|missing) api key\b|\bapi key (?:is )?(?:missing|required)\b|\bprovider is not configured\b/i.test(message)) return 'MISSING_CREDENTIAL'
  if (/\b(?:malformed|invalid format|wrong format)\b.{0,40}\bapi key\b|\bapi key\b.{0,40}\b(?:malformed|invalid format|wrong format)\b/i.test(message)) return 'INVALID_CREDENTIAL'
  if (/\b(?:unauthorized|authentication failed|invalid api key|incorrect api key|permission denied)\b/i.test(message)) return 'AUTH'
  if (/\b(?:quota|insufficient (?:balance|credits?)|billing limit|payment required)\b/i.test(message)) return 'QUOTA'
  if (/\b(?:rate limit|too many requests)\b/i.test(message)) return 'RATE_LIMIT'
  if (/\b(?:timed? out|timeout)\b/i.test(message) || /^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(supplied)) return 'TIMEOUT'
  if (/\b(?:maximum context length|context window|context length exceeded)\b/i.test(message)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (/\b(?:fetch failed|network error|connection (?:failed|refused|reset)|socket hang up|dns)\b/i.test(message)
    || /^(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN)$/.test(supplied)) return 'TRANSPORT'
  return 'UNKNOWN'
}

export function modelFailure(error, response = {}) {
  const message = messageOf(error) || 'Model request failed'
  const status = statusOf(error, response, message)
  const requestId = string(error?.requestId)
    || header(response.headers, 'x-request-id')
    || header(response.headers, 'request-id')
  return {
    code: codeOf(error, status, message),
    message: message.slice(0, 500),
    ...(status === undefined ? {} : { status }),
    ...(requestId ? { requestId } : {}),
  }
}

export function messageFailure(message) {
  if (message?.failure && typeof message.failure === 'object') return modelFailure(message.failure)
  return modelFailure({
    code: message?.errorCode,
    message: message?.errorMessage,
    status: message?.errorStatus,
    requestId: message?.requestId,
  })
}
