import { randomUUID } from 'node:crypto'

const abortError = signal => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Computer driver request aborted'), { name: 'AbortError' })

export function sendComputerResponse(host, message) {
  try {
    host.send(message)
    return true
  } catch {
    return false
  }
}

export class ComputerRemote {
  #send
  #pending = new Map()

  constructor(send) { this.#send = send }

  request(action, payload, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const abort = () => {
        if (!this.#pending.delete(id)) return
        void this.#send({ type: 'ds-bot:computer-cancel', id }).catch(() => undefined)
        reject(abortError(signal))
      }
      this.#pending.set(id, { resolve, reject, signal, abort })
      signal?.addEventListener('abort', abort, { once: true })
      void this.#send({ type: 'ds-bot:computer-request', id, action, payload }).catch(error => {
        const request = this.#take(id)
        request?.reject(error)
      })
    })
  }

  accept(message) {
    if (message?.type !== 'ds-bot:computer-response' || typeof message.id !== 'string') return false
    const request = this.#take(message.id)
    if (request === undefined) return true
    if (message.error) request.reject(Object.assign(new Error(String(message.error.message ?? 'Computer driver failed')), {
      code: message.error.code, status: message.error.status,
    }))
    else request.resolve(message.value)
    return true
  }

  disconnect(error = new Error('Computer driver host disconnected')) {
    for (const id of [...this.#pending.keys()]) this.#take(id)?.reject(error)
  }

  #take(id) {
    const request = this.#pending.get(id)
    if (request === undefined) return undefined
    this.#pending.delete(id)
    request.signal?.removeEventListener('abort', request.abort)
    return request
  }
}
