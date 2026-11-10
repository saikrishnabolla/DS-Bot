import { speechConfig } from './config.mjs'
import { SpeechService } from './service.mjs'

export class SpeechHost {
  #service
  #root
  #tail = Promise.resolve()

  constructor({ open = SpeechService.open, config = speechConfig, options } = {}) {
    this.open = open
    this.config = config
    this.options = options
  }

  use(root) {
    const run = async () => {
      if (this.#service !== undefined && this.#root === root) return this.#service
      const previous = this.#service
      this.#service = undefined
      this.#root = undefined
      await previous?.dispose()
      const service = await this.open(this.config({ dataRoot: root }), this.options)
      this.#service = service
      this.#root = root
      return service
    }
    this.#tail = this.#tail.then(run, run)
    return this.#tail
  }

  stop() {
    const run = async () => {
      const service = this.#service
      this.#service = undefined
      this.#root = undefined
      await service?.dispose()
    }
    this.#tail = this.#tail.then(run, run)
    return this.#tail
  }
}
