export class SpeechRequests {
  #requests = new Map()

  #key(sender, id) { return `${String(sender.id)}:${String(id)}` }

  begin(sender, id) {
    const key = this.#key(sender, id)
    const previous = this.#requests.get(key)
    previous?.controller.abort(new Error('Speech request was replaced'))
    previous?.sender.off?.('destroyed', previous.destroyed)
    const controller = new AbortController()
    const destroyed = () => { controller.abort(new Error('Speech window closed')) }
    sender.once?.('destroyed', destroyed)
    const entry = { controller, sender, destroyed }
    this.#requests.set(key, entry)
    return {
      signal: controller.signal,
      end: () => {
        if (this.#requests.get(key) !== entry) return
        this.#requests.delete(key)
        sender.off?.('destroyed', destroyed)
      },
    }
  }

  cancel(sender, id) {
    this.#requests.get(this.#key(sender, id))?.controller.abort(new Error('Speech transcription cancelled'))
  }

  cancelAll() {
    for (const entry of this.#requests.values()) {
      entry.controller.abort(new Error('Speech service stopped'))
      entry.sender.off?.('destroyed', entry.destroyed)
    }
    this.#requests.clear()
  }
}
