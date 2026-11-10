import assert from 'node:assert/strict'
import test from 'node:test'
import { ImportFlow } from '../src/import-flow.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function harness({ copy, inUse = () => false, signal = new AbortController().signal } = {}) {
  const asked = []
  const shown = []
  const answers = []
  let respond
  const io = {
    offer: { from: '/old', bots: 2, rooms: 1, names: ['Chief', 'Writer'], sessions: 3 },
    ask: (card, options) => {
      asked.push(card)
      return new Promise(resolve => {
        respond = resolve
        void options?.settle?.then(() => resolve('settled'))
        if (answers.length > 0) resolve(answers.shift())
      })
    },
    show: card => shown.push(card),
    inUse,
    until: async (check, waitSignal) => { while (!waitSignal.aborted && !check()) await tick() },
    warmed: async () => {},
    copy: copy ?? (async () => ({ bots: 2, sessions: 3 })),
    reasonOf: error => error.code === 'EBUSY' ? 'inUse' : 'other',
    lang: 'en',
    signal,
  }
  return {
    io,
    asked,
    shown,
    answer(value) {
      if (respond) { const resolve = respond; respond = undefined; resolve(value) } else answers.push(value)
    },
  }
}

test('import flow passes workspace choices to the one-way copy', async () => {
  let options
  const { io, answer } = harness({ copy: async value => { options = value; return { bots: 2, sessions: 3 } } })
  const flow = new ImportFlow(io)
  const run = flow.run()
  await tick()
  flow.act('importOption', { option: 'regen', value: true })
  flow.act('importOption', { option: 'skipWork', value: true })
  answer('copy')
  assert.equal((await run).outcome, 'copied')
  assert.equal(options.leaveRegenerable, true)
  assert.equal(options.skipWork, true)
})

test('import flow retries a failed copy and can continue without it', async () => {
  let tries = 0
  const { io, asked, answer } = harness({
    copy: async () => {
      tries += 1
      if (tries === 1) throw Object.assign(new Error('busy\nagain'), { code: 'EBUSY' })
      return { bots: 2, sessions: 3 }
    },
  })
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  while (asked.length < 2) await tick()
  assert.deepEqual(asked[1], { kind: 'importFailed', reason: 'inUse', log: ['busy', 'again'] })
  answer('retry')
  assert.equal((await run).outcome, 'copied')
  assert.equal(tries, 2)
})

test('import flow waits for the old host to release the team', async () => {
  let held = true
  const { io, asked, answer } = harness({ inUse: () => held })
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  while (asked.length < 2) await tick()
  assert.equal(asked[1].kind, 'inUse')
  held = false
  assert.equal((await run).outcome, 'copied')
})

test('import flow stops an active copy when the app aborts it', async () => {
  const controller = new AbortController()
  let copying
  const { io, shown, answer } = harness({
    signal: controller.signal,
    copy: ({ signal }) => new Promise((_, reject) => {
      copying = true
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  while (!copying) await tick()
  assert.equal(shown.at(-1).kind, 'copying')
  controller.abort(new Error('quit'))
  assert.deepEqual(await run, { outcome: 'gone' })
})
