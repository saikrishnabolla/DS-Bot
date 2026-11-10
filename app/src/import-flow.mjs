export class ImportFlow {
  #io
  #options = { regen: false, skipWork: false }

  constructor(io) { this.#io = io }

  card() {
    const offer = this.#io.offer
    return {
      kind: 'import', bots: offer.bots, groups: offer.rooms, sessions: offer.sessions, path: offer.from,
      names: offer.names.slice(0, 3).join(this.#io.lang === 'en' ? ', ' : '、'),
      bare: 'Bare', model: '', models: [], options: { ...this.#options },
    }
  }

  act(name, value) {
    if (name !== 'importOption' || value === null || typeof value !== 'object') return
    if (!['regen', 'skipWork'].includes(value.option)) return
    this.#options = { ...this.#options, [value.option]: value.value === true }
    this.#io.show(this.card())
  }

  async run() {
    const answer = await this.#io.ask(this.card())
    if (answer !== 'copy') return { outcome: answer === 'skip' ? 'skipped' : answer === 'pick' ? 'pick' : 'gone' }
    if (this.#io.inUse()) {
      const next = await this.#io.ask({ kind: 'inUse' }, { settle: this.#io.until(() => !this.#io.inUse(), this.#io.signal) })
      if (next !== 'settled') return { outcome: next === 'skip' ? 'skipped' : 'gone' }
    }
    for (;;) {
      try {
        this.#io.show({ kind: 'copying', step: 2, steps: [{}, { a: '0', b: '…' }, {}], fraction: 0, eta: null, arc: 0.15 })
        await this.#io.warmed()
        const summary = await this.#io.copy({
          leaveRegenerable: this.#options.regen,
          skipWork: this.#options.skipWork,
          signal: this.#io.signal,
          onProgress: () => undefined,
        })
        this.#io.show({ kind: 'copying', step: 3, steps: [{}, { a: '…', b: '…' }, {}], fraction: 1, eta: null, arc: 1 })
        return { outcome: 'copied', summary }
      } catch (error) {
        if (this.#io.signal.aborted) return { outcome: 'gone' }
        const message = error instanceof Error ? error.message : String(error)
        const next = await this.#io.ask({ kind: 'importFailed', reason: this.#io.reasonOf(error), log: message.split('\n') })
        if (next !== 'retry') return { outcome: next === 'startWithout' ? 'skipped' : 'gone' }
      }
    }
  }
}
