import { randomUUID } from 'node:crypto'
import { ConversationBusy, defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { Cron, RRule, canonicalizeTimeZone, resolveLocalInstant } from './recurrence.js'

const INPUT_KIND = 'ds-bot.user'
const TASK_KIND = 'ds-bot.schedule'
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/
const MAX_TITLE = 120
const MIN_EVERY_SECONDS = 60
const LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
const formatters = new Map()

export class OwnedScheduleInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OwnedScheduleInputError'
    this.code = code
  }
}

class OwnedScheduleConflictError extends Error {}

const inputError = (code, message) => { throw new OwnedScheduleInputError(code, message) }
const requireRevision = (record, expected) => {
  if (expected !== undefined && expected !== (record.updatedAt ?? null)) throw new OwnedScheduleConflictError()
}

const SchedulesDoc = defineDoc({
  kind: 'ds-bot.schedules',
  version: 1,
  scope: 'session',
  initial: () => ({ items: {} }),
  checkpointWhen: () => true,
})

const completed = result => ({ status: 'terminal', outcome: { status: 'completed', result } })

function canonicalTimeZone(timeZone) {
  if (typeof timeZone !== 'string') inputError('invalid_time_zone', 'time zone must be UTC or a valid IANA Area/Location name.')
  const result = canonicalizeTimeZone(timeZone)
  if (result.kind === 'rejected') inputError('invalid_time_zone', 'time zone must be UTC or a valid IANA Area/Location name.')
  return result.timeZone
}

function formatter(timeZone) {
  const canonical = canonicalTimeZone(timeZone)
  let value = formatters.get(canonical)
  if (value !== undefined) return value
  value = new Intl.DateTimeFormat('en-CA', {
    timeZone: canonical,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  formatters.set(canonical, value)
  return value
}

function zonedParts(at, timeZone) {
  const values = {}
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return values
}

function localCandidates(value, timeZone) {
  const instant = resolveLocalInstant({ ...value, millisecond: 0 }, timeZone)
  return instant === undefined ? [] : [instant]
}

function dateAfter(value, days) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function wallTime(value) {
  const match = TIME.exec(String(value))
  if (match === null) inputError('invalid_rule', 'Schedule time must use HH:mm:ss.')
  return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] ?? 0), text: `${match[1]}:${match[2]}:${match[3] ?? '00'}` }
}

function recurrence(result) {
  if (result.kind === 'accepted') return result.rule
  const code = result.reason === 'time_zone' ? 'invalid_time_zone' : result.reason === 'density' ? 'frequency_too_high' : 'invalid_rule'
  inputError(code, result.detail)
}

function parseRRule(value) {
  if (typeof value !== 'string') inputError('invalid_rule', 'rrule must be a string.')
  const rule = recurrence(RRule.parse(value, { rejectIneffectiveSetPositions: true }))
  return { rrule: rule.expression, timeZone: rule.timeZone, rule }
}

function parseCron(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'expression') || !Object.hasOwn(value, 'time_zone')) {
    inputError('invalid_rule', 'cron must contain exactly expression and time_zone, with a five-field cron expression.')
  }
  if (typeof value.time_zone !== 'string') inputError('invalid_time_zone', 'time_zone must be a string.')
  const rule = recurrence(Cron.parse(value.expression, value.time_zone))
  return { expression: rule.expression, timeZone: rule.timeZone, rule }
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

function previousWall(timing, before, floor) {
  const zone = timing.timeZone
  const end = zonedParts(before, zone)
  const allowed = timing.kind === 'weekly' ? new Set(timing.weekdays) : undefined
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = dateAfter(end, -offset)
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() || 7
    if (allowed !== undefined && !allowed.has(weekday)) continue
    const candidates = localCandidates({ ...date, hour: timing.hour, minute: timing.minute, second: timing.second }, zone)
    const previous = candidates[0]
    if (previous !== undefined && previous <= before && previous >= floor) return previous
  }
  return floor
}

function latestAt(timing, floor, before) {
  if (timing.kind === 'at') return floor
  if (timing.kind === 'every') {
    const interval = timing.everySeconds * 1_000
    return Math.max(floor, timing.anchor + Math.floor((before - timing.anchor) / interval) * interval)
  }
  if (timing.kind === 'cron') return Date.parse(recurrence(Cron.parse(timing.expression, timing.timeZone)).resolve(new Date(floor).toISOString(), before).occurrenceAt)
  if (timing.kind === 'rrule') return Date.parse(recurrence(RRule.parse(timing.rrule)).resolve(new Date(floor).toISOString(), before).occurrenceAt)
  return previousWall(timing, before, floor)
}

function nextAt(timing, after) {
  if (timing.kind === 'at') return timing.at > after ? timing.at : undefined
  if (timing.kind === 'every') {
    const interval = timing.everySeconds * 1_000
    const elapsed = Math.max(0, after - timing.anchor)
    return timing.anchor + (Math.floor(elapsed / interval) + 1) * interval
  }
  if (timing.kind === 'cron') {
    const next = recurrence(Cron.parse(timing.expression, timing.timeZone)).next(after)
    return next === undefined ? undefined : Date.parse(next)
  }
  if (timing.kind === 'rrule') {
    const next = recurrence(RRule.parse(timing.rrule)).next(after)
    return next === undefined ? undefined : Date.parse(next)
  }
  return nextWall(timing, after)
}

function normalizeTiming(input, now) {
  switch (input?.kind) {
    case 'at': {
      const at = Date.parse(String(input.at ?? ''))
      if (!Number.isFinite(at)) inputError('invalid_rule', 'Schedule time must be a valid RFC 3339 instant.')
      if (at <= now) inputError('not_future', 'Schedule time must be in the future.')
      return { kind: 'at', at }
    }
    case 'every': {
      const everySeconds = Number(input.every_seconds)
      if (!Number.isInteger(everySeconds) || everySeconds < MIN_EVERY_SECONDS) inputError('frequency_too_high', 'Schedule interval must be at least 60 seconds.')
      return { kind: 'every', everySeconds, anchor: now }
    }
    case 'daily': {
      const time = wallTime(input.daily?.time)
      const timeZone = canonicalTimeZone(String(input.daily?.time_zone ?? ''))
      formatter(timeZone)
      return { kind: 'daily', ...time, timeZone }
    }
    case 'weekly': {
      const time = wallTime(input.weekly?.time)
      const timeZone = canonicalTimeZone(String(input.weekly?.time_zone ?? ''))
      formatter(timeZone)
      const weekdays = [...new Set((Array.isArray(input.weekly?.weekdays) ? input.weekly.weekdays : []).map(Number))]
        .filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
        .sort((left, right) => left - right)
      if (weekdays.length === 0) throw new TypeError('Weekly schedules need at least one weekday')
      return { kind: 'weekly', ...time, timeZone, weekdays }
    }
    case 'cron': {
      const cron = parseCron(input.cron)
      return { kind: 'cron', expression: cron.expression, timeZone: cron.timeZone }
    }
    case 'rrule': {
      const recurrence = parseRRule(input.rrule)
      return { kind: 'rrule', rrule: recurrence.rrule, timeZone: recurrence.timeZone }
    }
    default:
      inputError('invalid_rule', `Unsupported schedule timing: ${String(input?.kind)}`)
  }
}

export function nextOwnedScheduleAt(input, after) {
  return nextAt(normalizeTiming(input, after), after)
}

export function resolveOwnedScheduleTiming(timing, scheduledAt, acceptedAt) {
  return { occurrenceAt: latestAt(timing, scheduledAt, acceptedAt), nextAt: nextAt(timing, acceptedAt) }
}

function scheduleText(record, occurrenceAt) {
  return [
    '[SCHEDULE REMINDER]',
    'This is a scheduled message from the user',
    `schedule_id_json: ${JSON.stringify(record.id)}`,
    `occurrence_at: ${new Date(occurrenceAt).toISOString()}`,
    `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}

const revisedAt = (record, now = Date.now()) => new Date(Math.max(now, Date.parse(record.updatedAt ?? 0) + 1)).toISOString()

function publicRecord(record) {
  const base = {
    id: record.id,
    kind: record.timing.kind,
    title: record.title,
    prompt: record.prompt,
    scheduledAt: new Date(record.scheduledAt).toISOString(),
    target: { kind: 'session', sessionId: record.targetSessionId },
    status: record.status,
    updatedAt: record.updatedAt,
    ...(record.lastDelivery === undefined ? {} : { lastDelivery: { ...record.lastDelivery } }),
  }
  if (record.timing.kind === 'every') return { ...base, everySeconds: record.timing.everySeconds }
  if (record.timing.kind === 'daily') return { ...base, time: record.timing.text, timeZone: record.timing.timeZone }
  if (record.timing.kind === 'weekly') return { ...base, time: record.timing.text, timeZone: record.timing.timeZone, weekdays: [...record.timing.weekdays] }
  if (record.timing.kind === 'cron') return { ...base, expression: record.timing.expression, timeZone: record.timing.timeZone }
  if (record.timing.kind === 'rrule') return { ...base, rrule: record.timing.rrule }
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
          if (current !== undefined && current.taskId === runtime.taskId) {
            current.status = 'ended'
            current.updatedAt = revisedAt(current, runtime.now())
          }
          return completed({ delivered: false })
        }, context)
      }
      for (;;) {
        await target.waitForIdle(context)
        try {
          return await runtime.commit(async tx => {
            const schedules = await tx.doc(SchedulesDoc)
            const current = schedules.items[scheduleId]
            if (current === undefined || current.status !== 'active' || current.taskId !== runtime.taskId) return completed({ delivered: false })
            if (current.scheduledAt !== expected) {
              return { status: 'sleeping', until: current.scheduledAt, checkpoint: { phase: 'wait', scheduledAt: current.scheduledAt } }
            }
            const acceptedAt = runtime.now()
            const occurrence = latestAt(current.timing, current.scheduledAt, acceptedAt)
            const requestId = `schedule:${scheduleId}:${occurrence}`
            await target.submit(tx, {
              type: 'input',
              content: [{ type: 'text', text: scheduleText(current, occurrence) }],
              requestId,
              whenBusy: 'reject',
              entry: { kind: INPUT_KIND, data: { source: { kind: 'schedule', scheduleId, occurrenceAt: new Date(occurrence).toISOString(), requestId }, requestId } },
            })
            const deliveredAt = new Date(acceptedAt).toISOString()
            current.lastDelivery = { scheduledAt: new Date(occurrence).toISOString(), deliveredAt, targetSessionId: current.targetSessionId }
            current.updatedAt = revisedAt(current, acceptedAt)
            const next = nextAt(current.timing, acceptedAt)
            if (next === undefined) {
              current.status = 'ended'
              delete current.taskId
              return completed({ delivered: true })
            }
            current.scheduledAt = next
            return { status: 'sleeping', until: next, checkpoint: { phase: 'wait', scheduledAt: next } }
          }, context)
        } catch (error) {
          if (!(error instanceof ConversationBusy)) throw error
        }
      }
    },
  },
  abort: (task, runtime, context) => runtime.commit(async tx => {
    const schedules = await tx.doc(SchedulesDoc)
    const current = schedules.items[task.input.scheduleId]
    if (current !== undefined && current.taskId === runtime.taskId) {
      current.status = 'ended'
      current.updatedAt = revisedAt(current, runtime.now())
      delete current.taskId
    }
    return { status: 'terminal', outcome: { status: 'aborted' } }
  }, context),
})

const ScheduleExtension = defineExtension({ name: 'ds-bot-owned-schedules', tasks: [ScheduleTask] })

class OwnedSchedules {
  ownedToolContract = true

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
    const normalizedTitle = String(title ?? '').trim()
    const normalizedPrompt = String(prompt ?? '').trim()
    if (normalizedTitle === '' || normalizedTitle.length > MAX_TITLE) inputError('invalid_prompt', `title must be non-empty and at most ${MAX_TITLE} characters.`)
    if (normalizedPrompt === '') inputError('invalid_prompt', 'prompt must be non-empty after trimming.')
    const timing = normalizeTiming(input, now)
    const scheduledAt = nextAt(timing, now)
    if (scheduledAt === undefined) inputError('not_future', 'Schedule must contain an occurrence in the future.')
    const { sessionId, numeric } = validTarget(target)
    if (await this.harness.conversation(sessionId) === undefined) throw new TypeError('Schedule target must be an existing session')
    const id = randomUUID()
    const createdAt = new Date(now).toISOString()
    await this.harness.commit(async tx => {
      const schedules = await tx.doc(SchedulesDoc)
      const taskId = await tx.createTask(ScheduleTask, { scheduleId: id, scheduledAt }, {
        ownership: { kind: 'conversation' }, conversationId: numeric, background: true,
      })
      schedules.items[id] = {
        id, title: normalizedTitle, prompt: normalizedPrompt, timing, scheduledAt, targetSessionId: sessionId,
        status: 'active', taskId, createdAt, updatedAt: createdAt,
      }
    })
    return this.view({ id })
  }

  async catalog() {
    const snapshot = await this.harness.snapshot(SchedulesDoc)
    return Object.values(snapshot?.items ?? {})
      .map(publicRecord)
      .sort((left, right) => {
        const status = Number(left.status !== 'active') - Number(right.status !== 'active')
        if (status !== 0) return status
        if (left.status === 'active') return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id)
        return (right.lastDelivery?.deliveredAt ?? right.updatedAt ?? right.scheduledAt)
          .localeCompare(left.lastDelivery?.deliveredAt ?? left.updatedAt ?? left.scheduledAt) || left.id.localeCompare(right.id)
      })
  }

  async list({ active, limit = LIST_LIMIT, offset = 0 } = {}) {
    if (typeof active !== 'undefined' && typeof active !== 'boolean') inputError('invalid_rule', 'active must be a boolean when present.')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
      inputError('invalid_rule', `limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer.`)
    }
    const matching = (await this.catalog()).filter(record => active === undefined || (record.status === 'active') === active)
    const items = matching.slice(offset, offset + limit)
    return { items, shown: items.length, total: matching.length, limit, offset }
  }

  async view({ id }) {
    const record = (await this.catalog()).find(entry => entry.id === id)
    return record ?? { id, code: 'schedule_not_found' }
  }

  async edit(request) {
    const current = (await this.harness.snapshot(SchedulesDoc))?.items?.[request.id]
    if (current === undefined) return { id: request.id, code: 'schedule_not_found' }
    if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
      return { id: request.id, code: 'schedule_conflict' }
    }
    try {
      if (request.action === 'delete') {
        const taskId = await this.harness.commit(async tx => {
          const schedules = await tx.doc(SchedulesDoc)
          const found = schedules.items[request.id]
          if (found === undefined) return undefined
          requireRevision(found, request.expectedUpdatedAt)
          const id = found.taskId
          delete schedules.items[request.id]
          return id
        })
        if (taskId !== undefined) await this.harness.abortTask(taskId)
        return { id: request.id, deleted: true }
      }
      const patch = request.patch ?? {}
      const pause = request.action === 'pause' || (request.action === 'update' && patch.active === false)
      if (pause && Object.keys(patch).every(key => key === 'active')) {
        const taskId = await this.harness.commit(async tx => {
          const found = (await tx.doc(SchedulesDoc)).items[request.id]
          if (found === undefined) return undefined
          requireRevision(found, request.expectedUpdatedAt)
          found.status = 'paused'
          found.updatedAt = revisedAt(found)
          const id = found.taskId
          delete found.taskId
          return id
        })
        if (taskId !== undefined) await this.harness.abortTask(taskId)
        return this.view({ id: request.id })
      }
      if (request.action === 'resume' || (request.action === 'update' && patch.active === true && Object.keys(patch).every(key => key === 'active'))) {
        if (current.status === 'active') {
          await this.harness.commit(async tx => {
            const found = (await tx.doc(SchedulesDoc)).items[request.id]
            if (found !== undefined) requireRevision(found, request.expectedUpdatedAt)
          })
          return this.view({ id: request.id })
        }
        const scheduledAt = nextAt(current.timing, Date.now())
        if (scheduledAt === undefined) inputError('not_future', 'This task has no future occurrence. Set a future schedule before resuming it.')
        await this.#replaceTask(request.id, current.taskId, { status: 'active', scheduledAt }, request.expectedUpdatedAt, true)
        return this.view({ id: request.id })
      }
      if (request.action !== 'update') throw new TypeError(`Unsupported schedule action: ${String(request.action)}`)
      if (Object.keys(patch).length === 0) inputError('invalid_selector', 'update requires at least one changed field.')
      const target = patch.target === undefined ? { sessionId: current.targetSessionId, numeric: Number(current.targetSessionId) } : validTarget(patch.target)
      if (await this.harness.conversation(target.sessionId) === undefined) throw new TypeError('Schedule target must be an existing session')
      const timing = patch.timing === undefined ? current.timing : normalizeTiming(patch.timing, Date.now())
      const rearm = patch.timing !== undefined || (patch.active === true && current.status !== 'active')
      const scheduledAt = rearm ? nextAt(timing, Date.now()) : current.scheduledAt
      if (scheduledAt === undefined) inputError('not_future', 'Schedule must contain an occurrence in the future.')
      const title = patch.title === undefined ? current.title : String(patch.title).trim()
      const prompt = patch.prompt === undefined ? current.prompt : String(patch.prompt).trim()
      if (title === '' || title.length > MAX_TITLE) inputError('invalid_prompt', `title must be non-empty and at most ${MAX_TITLE} characters.`)
      if (prompt === '') inputError('invalid_prompt', 'prompt must be non-empty after trimming.')
      const replacement = {
        title,
        prompt,
        timing,
        scheduledAt,
        targetSessionId: target.sessionId,
        ...(patch.timing === undefined && patch.target === undefined ? {} : { lastDelivery: undefined }),
      }
      if (patch.active === false) {
        const taskId = await this.harness.commit(async tx => {
          const found = (await tx.doc(SchedulesDoc)).items[request.id]
          if (found === undefined) return undefined
          requireRevision(found, request.expectedUpdatedAt)
          Object.assign(found, replacement, { status: 'paused', updatedAt: revisedAt(found) })
          const id = found.taskId
          delete found.taskId
          return id
        })
        if (taskId !== undefined) await this.harness.abortTask(taskId)
      } else if ((current.status === 'active' && (patch.timing !== undefined || patch.target !== undefined))
        || (current.status !== 'active' && (patch.active === true || (current.status === 'ended' && patch.timing !== undefined)))) {
        await this.#replaceTask(request.id, current.taskId, replacement, request.expectedUpdatedAt, true)
      }
      else {
        await this.harness.commit(async tx => {
          const found = (await tx.doc(SchedulesDoc)).items[request.id]
          if (found === undefined) return
          requireRevision(found, request.expectedUpdatedAt)
          Object.assign(found, replacement, { updatedAt: revisedAt(found) })
        })
      }
      return this.view({ id: request.id })
    } catch (error) {
      if (error instanceof OwnedScheduleConflictError) return { id: request.id, code: 'schedule_conflict' }
      throw error
    }
  }

  async #replaceTask(scheduleId, previousTaskId, patch = {}, expectedUpdatedAt, touch = false) {
    const nextTaskId = await this.harness.commit(async tx => {
      const schedules = await tx.doc(SchedulesDoc)
      const current = schedules.items[scheduleId]
      if (current === undefined) return undefined
      requireRevision(current, expectedUpdatedAt)
      if (previousTaskId !== undefined && current.taskId !== previousTaskId) throw new OwnedScheduleConflictError()
      const updatedAt = touch ? revisedAt(current) : undefined
      Object.assign(current, patch)
      if (updatedAt !== undefined) current.updatedAt = updatedAt
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
