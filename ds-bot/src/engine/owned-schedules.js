import { randomUUID } from 'node:crypto'
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'

const INPUT_KIND = 'ds-bot.user'
const TASK_KIND = 'ds-bot.schedule'
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/
const formatters = new Map()

const SchedulesDoc = defineDoc({
  kind: 'ds-bot.schedules',
  version: 1,
  scope: 'session',
  initial: () => ({ items: {} }),
  checkpointWhen: () => true,
})

const completed = result => ({ status: 'terminal', outcome: { status: 'completed', result } })

function formatter(timeZone) {
  let value = formatters.get(timeZone)
  if (value !== undefined) return value
  try {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    throw new TypeError(`Invalid time zone: ${String(timeZone)}`)
  }
  formatters.set(timeZone, value)
  return value
}

function zonedParts(at, timeZone) {
  const values = {}
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return values
}

const serial = value => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)

function localCandidates(value, timeZone) {
  const wanted = serial(value)
  let candidate = wanted
  for (let count = 0; count < 6; count += 1) {
    const delta = wanted - serial(zonedParts(candidate, timeZone))
    if (delta === 0) break
    candidate += delta
  }
  const matches = []
  for (let at = candidate - 4 * 60 * 60_000; at <= candidate + 4 * 60 * 60_000; at += 60_000) {
    const found = zonedParts(at, timeZone)
    if (serial(found) === wanted) matches.push(at)
  }
  return [...new Set(matches)].sort((left, right) => left - right)
}

function dateAfter(value, days) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function wallTime(value) {
  const match = TIME.exec(String(value))
  if (match === null) throw new TypeError('Invalid schedule time')
  return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] ?? 0), text: `${match[1]}:${match[2]}:${match[3] ?? '00'}` }
}

function nextWall(timing, after) {
  const zone = timing.timeZone
  formatter(zone)
  const start = zonedParts(after, zone)
  const allowed = timing.kind === 'weekly' ? new Set(timing.weekdays) : undefined
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = dateAfter(start, offset)
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() || 7
    if (allowed !== undefined && !allowed.has(weekday)) continue
    const candidates = localCandidates({ ...date, hour: timing.hour, minute: timing.minute, second: timing.second }, zone)
    const next = candidates.find(candidate => candidate > after)
    if (next !== undefined) return next
  }
  throw new RangeError('Could not find the next schedule occurrence')
}

function nextAt(timing, after) {
  if (timing.kind === 'at') return timing.at > after ? timing.at : undefined
  if (timing.kind === 'every') {
    const interval = timing.everySeconds * 1_000
    const elapsed = Math.max(0, after - timing.anchor)
    return timing.anchor + (Math.floor(elapsed / interval) + 1) * interval
  }
  return nextWall(timing, after)
}

function normalizeTiming(input, now) {
  switch (input?.kind) {
    case 'at': {
      const at = Date.parse(String(input.at ?? ''))
      if (!Number.isFinite(at) || at <= now) throw new TypeError('Schedule time must be in the future')
      return { kind: 'at', at }
    }
    case 'every': {
      const everySeconds = Number(input.every_seconds)
      if (!Number.isInteger(everySeconds) || everySeconds < 1) throw new TypeError('Schedule interval must be at least one second')
      return { kind: 'every', everySeconds, anchor: now }
    }
    case 'daily': {
      const time = wallTime(input.daily?.time)
      const timeZone = String(input.daily?.time_zone ?? '')
      formatter(timeZone)
      return { kind: 'daily', ...time, timeZone }
    }
    case 'weekly': {
      const time = wallTime(input.weekly?.time)
      const timeZone = String(input.weekly?.time_zone ?? '')
      formatter(timeZone)
      const weekdays = [...new Set((Array.isArray(input.weekly?.weekdays) ? input.weekly.weekdays : []).map(Number))]
        .filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
        .sort((left, right) => left - right)
      if (weekdays.length === 0) throw new TypeError('Weekly schedules need at least one weekday')
      return { kind: 'weekly', ...time, timeZone, weekdays }
    }
    default:
      throw new TypeError(`Unsupported schedule timing: ${String(input?.kind)}`)
  }
}

function scheduleText(record, occurrenceAt) {
  return [
    '[SCHEDULE REMINDER]',
    `schedule_id_json: ${JSON.stringify(record.id)}`,
    `occurrence_at: ${new Date(occurrenceAt).toISOString()}`,
    `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}

function publicRecord(record) {
  const base = {
    id: record.id,
    kind: record.timing.kind,
    title: record.title,
    prompt: record.prompt,
    scheduledAt: new Date(record.scheduledAt).toISOString(),
    target: { kind: 'session', sessionId: record.targetSessionId },
    status: record.status,
  }
  if (record.timing.kind === 'every') return { ...base, everySeconds: record.timing.everySeconds }
  if (record.timing.kind === 'daily') return { ...base, time: record.timing.text, timeZone: record.timing.timeZone }
  if (record.timing.kind === 'weekly') return { ...base, time: record.timing.text, timeZone: record.timing.timeZone, weekdays: [...record.timing.weekdays] }
  return base
}

function validTarget(target) {
  const sessionId = target?.kind === 'session' ? String(target.sessionId ?? '') : ''
  const numeric = Number(sessionId)
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new TypeError('Schedule target must be an existing session')
  return { sessionId, numeric }
}

const ScheduleTask = defineTask({
  name: TASK_KIND,
  version: 1,
  initial: input => ({ phase: 'wait', scheduledAt: input.scheduledAt }),
  phases: {
    wait: async (task, runtime, context) => {
      const scheduleId = task.input.scheduleId
      const expected = task.state.checkpoint.scheduledAt
      if (expected > runtime.now()) return runtime.sleepUntil(expected, task.state.checkpoint, context)
      const snapshot = await runtime.snapshot(SchedulesDoc, context)
      const found = snapshot?.items?.[scheduleId]
      if (found === undefined || found.status !== 'active' || found.taskId !== runtime.taskId) {
        return runtime.commit(() => completed({ delivered: false }), context)
      }
      if (found.scheduledAt !== expected) {
        return runtime.sleepUntil(found.scheduledAt, { phase: 'wait', scheduledAt: found.scheduledAt }, context)
      }
      const target = await runtime.conversation(Number(found.targetSessionId), context)
      if (target === undefined) {
        return runtime.commit(async tx => {
          const schedules = await tx.doc(SchedulesDoc)
          const current = schedules.items[scheduleId]
          if (current !== undefined && current.taskId === runtime.taskId) current.status = 'ended'
          return completed({ delivered: false })
        }, context)
      }
      return runtime.commit(async tx => {
        const schedules = await tx.doc(SchedulesDoc)
        const current = schedules.items[scheduleId]
        if (current === undefined || current.status !== 'active' || current.taskId !== runtime.taskId) return completed({ delivered: false })
        if (current.scheduledAt !== expected) {
          return { status: 'sleeping', until: current.scheduledAt, checkpoint: { phase: 'wait', scheduledAt: current.scheduledAt } }
        }
        const occurrence = current.scheduledAt
        const requestId = `schedule:${scheduleId}:${occurrence}`
        await target.submit(tx, {
          type: 'input',
          content: [{ type: 'text', text: scheduleText(current, occurrence) }],
          requestId,
          whenBusy: 'followUp',
          entry: { kind: INPUT_KIND, data: { source: { kind: 'schedule', scheduleId, occurrenceAt: new Date(occurrence).toISOString(), requestId }, requestId } },
        })
        const next = nextAt(current.timing, Math.max(occurrence, runtime.now()))
        if (next === undefined) {
          current.status = 'ended'
          delete current.taskId
          return completed({ delivered: true })
        }
        current.scheduledAt = next
        return { status: 'sleeping', until: next, checkpoint: { phase: 'wait', scheduledAt: next } }
      }, context)
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})

const ScheduleExtension = defineExtension({ name: 'ds-bot-owned-schedules', tasks: [ScheduleTask] })

class OwnedSchedules {
  constructor(harness) { this.harness = harness }

  async hydrate() {
    const snapshot = await this.harness.snapshot(SchedulesDoc)
    for (const record of Object.values(snapshot?.items ?? {})) {
      if (record.status !== 'active') continue
      const task = record.taskId === undefined ? undefined : await this.harness.getTask(record.taskId)
      if (task === undefined || task.state.status === 'terminal') await this.#replaceTask(record.id, record.taskId)
    }
  }

  async create({ title, prompt, timing: input, target }) {
    const now = Date.now()
    const timing = normalizeTiming(input, now)
    const scheduledAt = nextAt(timing, now)
    if (scheduledAt === undefined) throw new TypeError('Schedule time must be in the future')
    const { sessionId, numeric } = validTarget(target)
    if (await this.harness.conversation(sessionId) === undefined) throw new TypeError('Schedule target must be an existing session')
    const id = randomUUID()
    await this.harness.commit(async tx => {
      const schedules = await tx.doc(SchedulesDoc)
      const taskId = await tx.createTask(ScheduleTask, { scheduleId: id, scheduledAt }, {
        ownership: { kind: 'conversation' }, conversationId: numeric, background: true,
      })
      schedules.items[id] = { id, title: String(title), prompt: String(prompt), timing, scheduledAt, targetSessionId: sessionId, status: 'active', taskId }
    })
    return { id }
  }

  async catalog() {
    const snapshot = await this.harness.snapshot(SchedulesDoc)
    return Object.values(snapshot?.items ?? {})
      .map(publicRecord)
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id))
  }

  async edit(request) {
    const current = (await this.harness.snapshot(SchedulesDoc))?.items?.[request.id]
    if (current === undefined) return { id: request.id, updated: false, code: 'schedule_not_found' }
    if (request.action === 'delete') {
      const taskId = await this.harness.commit(async tx => {
        const schedules = await tx.doc(SchedulesDoc)
        const found = schedules.items[request.id]
        if (found === undefined) return undefined
        const id = found.taskId
        delete schedules.items[request.id]
        return id
      })
      if (taskId !== undefined) await this.harness.abortTask(taskId)
      return { id: request.id, deleted: true }
    }
    if (request.action === 'pause') {
      const taskId = await this.harness.commit(async tx => {
        const found = (await tx.doc(SchedulesDoc)).items[request.id]
        if (found === undefined) return undefined
        found.status = 'paused'
        const id = found.taskId
        delete found.taskId
        return id
      })
      if (taskId !== undefined) await this.harness.abortTask(taskId)
      return { id: request.id, updated: true }
    }
    if (request.action === 'resume') {
      if (current.status === 'active') return { id: request.id, updated: true }
      const scheduledAt = nextAt(current.timing, Date.now())
      if (scheduledAt === undefined) throw new TypeError('Schedule time must be in the future')
      await this.#replaceTask(request.id, current.taskId, { status: 'active', scheduledAt })
      return { id: request.id, updated: true }
    }
    if (request.action !== 'update') throw new TypeError(`Unsupported schedule action: ${String(request.action)}`)
    const patch = request.patch ?? {}
    const target = patch.target === undefined ? { sessionId: current.targetSessionId, numeric: Number(current.targetSessionId) } : validTarget(patch.target)
    if (await this.harness.conversation(target.sessionId) === undefined) throw new TypeError('Schedule target must be an existing session')
    const timing = patch.timing === undefined ? current.timing : normalizeTiming(patch.timing, Date.now())
    const scheduledAt = patch.timing === undefined ? current.scheduledAt : nextAt(timing, Date.now())
    if (scheduledAt === undefined) throw new TypeError('Schedule time must be in the future')
    const replacement = {
      title: patch.title === undefined ? current.title : String(patch.title),
      prompt: patch.prompt === undefined ? current.prompt : String(patch.prompt),
      timing,
      scheduledAt,
      targetSessionId: target.sessionId,
    }
    if (current.status === 'active') await this.#replaceTask(request.id, current.taskId, replacement)
    else {
      await this.harness.commit(async tx => Object.assign((await tx.doc(SchedulesDoc)).items[request.id], replacement))
    }
    return { id: request.id, updated: true }
  }

  async #replaceTask(scheduleId, previousTaskId, patch = {}) {
    const nextTaskId = await this.harness.commit(async tx => {
      const schedules = await tx.doc(SchedulesDoc)
      const current = schedules.items[scheduleId]
      if (current === undefined || (previousTaskId !== undefined && current.taskId !== previousTaskId)) return undefined
      Object.assign(current, patch)
      const target = validTarget({ kind: 'session', sessionId: current.targetSessionId })
      const taskId = await tx.createTask(ScheduleTask, { scheduleId, scheduledAt: current.scheduledAt }, {
        ownership: { kind: 'conversation' }, conversationId: target.numeric, background: true,
      })
      current.taskId = taskId
      current.status = 'active'
      return taskId
    })
    if (nextTaskId !== undefined && previousTaskId !== undefined) await this.harness.abortTask(previousTaskId)
    return nextTaskId
  }
}

export async function installOwnedSchedules(context) {
  context.harness.install(ScheduleExtension)
  const schedules = new OwnedSchedules(context.harness)
  await schedules.hydrate()
  context.provide('schedule', schedules)
  return schedules
}
