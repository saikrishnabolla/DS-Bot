// Runs the Host in plain Node on Linux, Electron's Node mode elsewhere, and owns its lifetime.
// Follows Cue apps/desktop/src/host-process.ts (MIT); see NOTICE.
import { spawn } from 'node:child_process'

const STDERR_TAIL_CHARS = 8 * 1024

export function hostExecutable() { return process.execPath }

// The web server prints its launch URL, and the launch token in it opens the Host.
const redact = (text) => text.replace(/([?&]token=)[^&\s]+/gu, '$1<hidden>')

// The engine's own report of a failure is on the Host's stderr; the error box
// gets its tail with the message so the real cause reaches the user.
export const withLogTail = (message, stderr) => {
  const tail = redact(stderr.trim())
  return tail === '' ? message : `${message}:\n${tail}`
}

const settlesWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(false) }, ms)
  void promise.then(() => { clearTimeout(timer); resolve(true) })
})

export class HostProcess {
  #options
  #child
  #ready
  #exit
  #stderr = ''
  #stopping = false
  #failed = false
  #messageListeners = new Set()

  /**
   * @param {{ entry: string, cwd: string, env: NodeJS.ProcessEnv, onFailure: (error: Error) => void, output?: (stream: 'stdout' | 'stderr', text: string) => void }} options
   *   `onFailure` receives the first unexpected failure, also after the Host was ready. `output`
   *   takes the Host's output with the launch token hidden; by default it goes to this process's.
   */
  constructor(options) { this.#options = options }

  /**
   * @returns {Promise<{ url: string, injections: unknown[] }>} the Host's launch URL and index injections
   */
  start() {
    this.#ready ??= new Promise((resolve, reject) => {
      const { entry, cwd, env, output = (stream, text) => { process[stream].write(text) } } = this.#options
      const child = spawn(hostExecutable(), [entry], {
        cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.#child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { output('stdout', redact(chunk)) })
      child.stderr.on('data', (chunk) => {
        output('stderr', redact(chunk))
        this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS)
      })
      child.on('message', (message) => {
        for (const listener of this.#messageListeners) listener(message)
        if (message?.type === 'ready') resolve({ url: message.url, injections: message.injections })
        else if (message?.type === 'fatal') this.#fail(new Error(withLogTail(message.message, this.#stderr)), reject)
      })
      child.once('error', (error) => { this.#fail(error, reject) })
      this.#exit = new Promise((done) => {
        child.once('close', (code) => {
          this.#fail(new Error(withLogTail(`The Cue Host stopped (exit ${String(code)})`, this.#stderr)), reject)
          done()
        })
      })
    })
    return this.#ready
  }

  onMessage(listener) { this.#messageListeners.add(listener); return () => this.#messageListeners.delete(listener) }

  send(message) {
    if (!this.#child?.connected) throw new Error('The Cue Host IPC channel is closed')
    this.#child.send(message)
  }

  /**
   * Ask the Host to shut down, then end it if it does not exit in time. With `now`, it is ended
   * at once instead: a start that goes on in another folder has no use for this Host's boot or
   * for an orderly shutdown of its data, which goes away with it.
   */
  async stop({ now = false } = {}) {
    const child = this.#child
    if (child === undefined) return
    this.#stopping = true
    if (now) child.kill()
    else {
      if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error) console.error(error) })
      if (!await settlesWithin(this.#exit, 10_000)) child.kill()
    }
    if (!await settlesWithin(this.#exit, 5_000)) child.kill('SIGKILL')
    this.#child = undefined
  }

  #fail(error, reject) {
    reject(error)
    if (this.#failed || this.#stopping) return
    this.#failed = true
    this.#options.onFailure(error)
  }
}
