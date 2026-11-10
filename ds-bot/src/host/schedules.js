// Scheduled tasks. Cue's schedule service stores each task with the Session it belongs
// to and, when it is due, sends its prompt to that Session as a new message. This
// module lists the team's tasks for Settings, creates and removes them there, and moves
// a Bot's tasks along when its chat goes on in a fresh part, so the Bot keeps seeing
// them. A group chat's task lives on the group's own Session, so the reminder reaches
// the group like a message from the user (see reminderText). the runtime mounts the service only with its Automation tasks bundle on, so
// the service is optional and every endpoint reports whether it is there.

import { defineTool } from '../engine/tool-definition.js'

const MAX_TITLE = 120
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What a group sees of a due reminder: Cue frames it for one Session's model
// ("[SCHEDULE REMINDER]" with JSON fields); the group gets each prompt as one line.
export function reminderText(text) {
  const prompts = []
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    if (one) prompts.push(JSON.parse(one[1]))
    if (batch) for (const entry of JSON.parse(batch[1])) prompts.push(entry.reminder_prompt)
  } catch {
    // A framing this module cannot read goes to the group as it came.
    return text
  }
  const lines = prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  return lines.length === 0 ? text : lines.map(prompt => `[Scheduled task] ${prompt}`).join('\n')
}

// The create request that gives a stored record its timing again, for a move.
function requestOf(record) {
  const base = { title: record.title, prompt: record.prompt }
  if (record.kind === 'after' || record.kind === 'at') return { ...base, at: record.scheduledAt }
  if (record.kind === 'every') return { ...base, every_seconds: record.everySeconds }
  if (record.kind === 'daily') return { ...base, daily: { time: record.time, time_zone: record.timeZone } }
  if (record.kind === 'weekly') return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
  if (record.kind === 'cron') return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
  return null
}

// the runtime keeps tasks Host-wide, each with a delivery target, and changes them through
// edit(); the runtime keeps them by Session. Both are served.
const hostWide = service => typeof service.edit === 'function'
// The existing Session a task delivers to; a task that opens new Sessions has none.
const sessionOf = entry => entry.target === undefined ? entry.sessionId : entry.target.kind === 'session' ? entry.target.sessionId : undefined
const TIMING_KINDS = { at: 'at', every_seconds: 'every', daily: 'daily', weekly: 'weekly' }
const OWN_TASK_TOOLS = ['schedule_edit', 'schedule_view']
// the runtime's list page: 100 by default, at most 500.
const LIST_PAGE = 100
const LIST_READ_LIMIT = 500
const OTHER_TASK_REFUSAL = 'This task belongs to another chat. A Bot reads and changes only the tasks of its own chat.'
const SCHEDULE_TARGET_REFUSAL = 'A Bot’s scheduled tasks run in its own chat. Use target "this_session".'
const TITLE_HELP = `Task name of at most ${MAX_TITLE} characters in the user's language. Name the action and object; omit timing, status, ids, and bracketed suffixes.`
const RRULE_HELP = 'Use two lines: DTSTART, then RRULE. DTSTART may be in the past; delivery starts at the first occurrence after creation. UTC starts end in Z. Local starts use an IANA TZID and keep their clock time through daylight-saving changes; nonexistent times are skipped and repeated times run once at the earlier instant. Fixed offsets use an Etc/GMT zone with the sign reversed, such as Etc/GMT-5 for UTC+5. Supported frequencies are MINUTELY through YEARLY, not SECONDLY. For one delivery, use FREQ=DAILY;COUNT=1. COUNT is limited to 1000 and cannot be combined with UNTIL; use a UTC UNTIL ending in Z for longer rules. BYSECOND accepts one value. MINUTELY and HOURLY accept no BY parts. BYMONTHDAY and ordinal BYDAY require MONTHLY or YEARLY; BYYEARDAY and BYWEEKNO require YEARLY; ordinal BYDAY cannot combine with BYWEEKNO. BYSETPOS requires another effective BY part and accepts at most 31 values. Each frequency period may produce at most 10080 candidates before BYSETPOS. Example: DTSTART;TZID=Asia/Singapore:20260901T080000 followed by RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1.'
const sameOwner = (a, b) => a !== undefined && b !== undefined && a.botId === b.botId && a.roomId === b.roomId
const timingOf = (selector) => {
  const [key] = Object.keys(selector)
  return { kind: TIMING_KINDS[key], [key]: selector[key] }
}

// The settings form's timing as a create request selector.
function selectorOf(when) {
  const zone = typeof when?.timeZone === 'string' && when.timeZone !== '' ? when.timeZone : 'UTC'
  switch (when?.kind) {
    case 'at': {
      const at = new Date(String(when.at ?? ''))
      if (Number.isNaN(at.getTime())) throw invalid('Pick a date and time')
      if (at.getTime() <= Date.now()) throw invalid('Pick a time in the future')
      return { at: at.toISOString() }
    }
    case 'daily':
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      return { daily: { time: `${when.time}:00`, time_zone: zone } }
    case 'weekly': {
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      const weekdays = [...new Set((Array.isArray(when.weekdays) ? when.weekdays : []).map(Number))].filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort()
      if (weekdays.length === 0) throw invalid('Pick at least one day')
      return { weekly: { time: `${when.time}:00`, time_zone: zone, weekdays } }
    }
    case 'every': {
      const minutes = Number(when.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw invalid('Repeat every 1 minute to 7 days')
      return { every_seconds: minutes * 60 }
    }
    default:
      throw invalid('Pick when it runs')
  }
}

export function install(rt) {
  const { ctx } = rt
  let service = null

  const attach = (sub) => {
    const own = sub.schedule
    service = own
    sub.effect(() => () => { if (service === own) service = null }, 'ds-bot: schedule service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['schedule'], attach)
  else if (ctx.get?.('schedule') !== undefined) attach({ schedule: ctx.get('schedule'), effect: (execute, label) => ctx.effect(execute, label) })

  // The Bot (and group chat) a task's Session speaks for, the group chat for a group's
  // own Session, or nothing for a Session outside the team.
  const ownerOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat }
    const room = rt.roomOf(sessionId)
    if (room !== undefined) return { roomId: room.id }
    return rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
  }
  const known = owner => owner !== undefined && (owner.botId === undefined ? rt.roomOf(owner.roomId) !== undefined : rt.botOf(owner.botId) !== undefined)

  const scheduleZone = task => {
    if (task.kind !== 'rrule') return task.timeZone ?? 'UTC'
    return /^DTSTART;TZID=([^:;]+):/m.exec(task.rrule)?.[1] ?? 'UTC'
  }
  const localTime = task => {
    const at = Date.parse(task.scheduledAt)
    const fields = {}
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: scheduleZone(task), hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    for (const part of format.formatToParts(at)) if (part.type !== 'literal') fields[part.type] = Number(part.value)
    const localSerial = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)
    const offset = Math.round((localSerial - at) / 60_000)
    const sign = offset < 0 ? '-' : '+'
    const absolute = Math.abs(offset)
    const pad = value => String(value).padStart(2, '0')
    return `${String(fields.year).padStart(4, '0')}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  }
  const modelTask = task => ({ ...task, scheduledAtLocal: localTime(task) })
  const renderSchedule = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  const scheduleFailure = error => {
    const exposed = new Set(['invalid_prompt', 'invalid_rule', 'invalid_time_zone', 'not_future', 'frequency_too_high', 'invalid_selector'])
    return exposed.has(error?.code) ? { code: error.code, message: error.message } : { code: 'internal_error', message: 'The schedule operation failed.' }
  }
  const runSchedule = async operation => {
    try { return await operation() } catch (error) { return scheduleFailure(error) }
  }

  function ownedScheduleTools() {
    const ownEntries = async (exec, active) => {
      await rt.load()
      const owner = rt.isBotSession(exec.agent?.id) ? ownerOf(exec.agent.id) : undefined
      if (owner === undefined) return []
      return (await service.catalog()).filter(entry => {
        const target = sessionOf(entry)
        return target !== undefined && sameOwner(owner, ownerOf(target))
          && (active === undefined || (entry.status === 'active') === active)
      })
    }
    const ownsEntry = async (exec, id) => {
      await rt.load()
      const owner = rt.isBotSession(exec.agent?.id) ? ownerOf(exec.agent.id) : undefined
      if (owner === undefined) return false
      const entry = (await service.catalog()).find(task => task.id === id)
      const target = entry === undefined ? undefined : sessionOf(entry)
      return target !== undefined && sameOwner(owner, ownerOf(target))
    }
    return [
      defineTool({
        name: 'schedule_create',
        ownedSchedule: true,
        description: 'Create a scheduled task. At each RRULE occurrence, its prompt is delivered to this chat as a scheduled user message. The result gives the next occurrence in UTC and local time. After downtime, only the latest missed occurrence is delivered; a crash can repeat a delivery.',
        parameters: {
          title: { type: 'string', required: true, description: TITLE_HELP },
          prompt: { type: 'string', required: true, description: 'Instruction delivered at each occurrence.' },
          rrule: { type: 'string', required: true, description: RRULE_HELP },
          target: { type: 'string', required: true, enum: ['this_session'], description: 'Use this_session. Cue keeps scheduled work in the Bot chat.' },
        },
        output: { render: renderSchedule },
        execute: (args, exec) => runSchedule(async () => {
          if (args.target !== 'this_session') throw new Error(SCHEDULE_TARGET_REFUSAL)
          return modelTask(await service.create({
            title: args.title,
            prompt: args.prompt,
            timing: { kind: 'rrule', rrule: args.rrule },
            target: { kind: 'session', sessionId: exec.agent.id },
          }))
        }),
      }),
      defineTool({
        name: 'schedule_list',
        replay: 'safe',
        ownedSchedule: true,
        description: 'List scheduled tasks for this Bot chat. Active tasks come first, ordered by scheduledAt.',
        parameters: {
          active: { type: 'boolean', description: 'true for active tasks; false for paused and ended tasks; omitted for all tasks.' },
          limit: { type: 'integer', description: `Page size from 1 to ${LIST_READ_LIMIT}; defaults to ${LIST_PAGE}.` },
          offset: { type: 'integer', description: 'Number of matching tasks to skip; defaults to 0.' },
        },
        output: { render: renderSchedule },
        execute: (args, exec) => runSchedule(async () => {
          const limit = args.limit ?? LIST_PAGE
          const offset = args.offset ?? 0
          if (args.active !== undefined && typeof args.active !== 'boolean') throw Object.assign(new Error('active must be a boolean when present.'), { code: 'invalid_rule' })
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_READ_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
            throw Object.assign(new Error(`limit must be 1-${LIST_READ_LIMIT} and offset must be a non-negative integer.`), { code: 'invalid_rule' })
          }
          const matching = await ownEntries(exec, args.active)
          const items = matching.slice(offset, offset + limit).map(modelTask)
          return { items, shown: items.length, total: matching.length, limit, offset }
        }),
      }),
      defineTool({
        name: 'schedule_view',
        replay: 'safe',
        ownedSchedule: true,
        description: 'View one scheduled task by id.',
        parameters: { id: { type: 'string', required: true, description: 'Task id.' } },
        output: { render: renderSchedule },
        execute: (args, exec) => runSchedule(async () => {
          if (!await ownsEntry(exec, args.id)) return { id: args.id, code: 'schedule_not_found' }
          const result = await service.view({ id: args.id })
          return result.code === 'schedule_not_found' ? result : modelTask(result)
        }),
      }),
      defineTool({
        name: 'schedule_edit',
        ownedSchedule: true,
        description: 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract a message that was already queued.',
        parameters: {
          id: { type: 'string', required: true, description: 'Task id.' },
          action: { type: 'string', required: true, enum: ['update', 'delete'], description: 'update applies at least one supplied field; delete removes the task.' },
          title: { type: 'string', description: TITLE_HELP },
          prompt: { type: 'string', description: 'New instruction delivered at each occurrence.' },
          rrule: { type: 'string', description: 'New recurrence in the schedule_create rrule format.' },
          target: { type: 'string', enum: ['this_session'], description: 'Bots use this_session so the task stays in their chat.' },
          active: { type: 'boolean', description: 'false pauses the task; true resumes it only when the rule has a future occurrence. Otherwise provide a new rrule.' },
          expectedUpdatedAt: { type: 'string', description: 'updatedAt from the latest result; a later change returns schedule_conflict and nothing changes.' },
        },
        output: { render: renderSchedule },
        execute: (args, exec) => runSchedule(async () => {
          const patchFields = ['title', 'prompt', 'rrule', 'target', 'active']
          if (args.action === 'delete') {
            if (patchFields.some(field => args[field] !== undefined)) throw Object.assign(new Error('delete accepts only id, action, and expectedUpdatedAt.'), { code: 'invalid_selector' })
            if (!await ownsEntry(exec, args.id)) return { id: args.id, code: 'schedule_not_found' }
            return service.edit({ id: args.id, action: 'delete', ...(args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: args.expectedUpdatedAt }) })
          }
          if (args.action !== 'update' || !patchFields.some(field => args[field] !== undefined)) {
            throw Object.assign(new Error('update requires at least one of title, prompt, rrule, target, or active.'), { code: 'invalid_selector' })
          }
          if (args.target !== undefined && args.target !== 'this_session') throw Object.assign(new Error(SCHEDULE_TARGET_REFUSAL), { code: 'invalid_selector' })
          if (!await ownsEntry(exec, args.id)) return { id: args.id, code: 'schedule_not_found' }
          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(args.rrule === undefined ? {} : { timing: { kind: 'rrule', rrule: args.rrule } }),
            ...(args.target === undefined ? {} : { target: { kind: 'session', sessionId: exec.agent.id } }),
            ...(args.active === undefined ? {} : { active: args.active }),
          }
          const result = await service.edit({ id: args.id, action: 'update', patch, ...(args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: args.expectedUpdatedAt }) })
          return result.code === undefined ? modelTask(result) : result
        }),
      }),
    ]
  }

  if (service?.ownedToolContract === true) {
    rt.teamTools.push(...ownedScheduleTools())
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'tool:schedule',
      order: typeof ctx.systemPrompt?.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE') : 0,
      interpolate: false,
      text: context => rt.isBotSession(context?.agent?.id ?? context?.agent?.session?.id)
        ? "Only create or modify scheduled tasks at the user's explicit request; prior explicit user authorization for the running scheduled task remains valid."
        : '',
    }), 'ds-bot: schedule authorization')
  }

  async function schedulesView() {
    if (service === null) return { available: false, tasks: [] }
    const now = Date.now()
    const tasks = []
    for (const entry of await service.catalog()) {
      const sessionId = sessionOf(entry)
      const owner = sessionId === undefined ? undefined : ownerOf(sessionId)
      if (!known(owner)) continue
      // The state Cue derives for its own view: a task past its next firing reads
      // overdue; a paused one stays paused; any other is finished. catalog() carries
      // the status but not this state, so it is derived the same way here.
      const state = entry.status === 'active' ? (now >= Date.parse(entry.scheduledAt) ? 'overdue' : 'scheduled')
        : entry.status === 'paused' ? 'paused' : 'finished'
      tasks.push({ ...entry, sessionId, ...owner, state })
    }
    return { available: true, tasks }
  }

  const endpoints = {
    schedules: () => schedulesView(),
    async 'schedule-create'(body) {
      if (service === null) throw invalid('Automation tasks are not available in this build')
      const bot = rt.botOf(body.target)
      const room = rt.roomOf(body.target)
      if (bot === undefined && room === undefined) throw invalid('No such Bot or group chat')
      const title = String(body.title ?? '').trim()
      const prompt = String(body.prompt ?? '').trim()
      if (title === '') throw invalid('Give the task a name')
      if (title.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
      if (prompt === '') throw invalid('Say what the Bot should do')
      const sessionId = bot ? rt.chatOf(bot.id) : rt.sessionOfRoom(room)
      const selector = selectorOf(body.when)
      if (hostWide(service)) await service.create({ title, prompt, timing: timingOf(selector), target: { kind: 'session', sessionId } })
      else await service.create(sessionId, { title, prompt, ...selector })
      return schedulesView()
    },
    async 'schedule-delete'(body) {
      if (service === null) throw invalid('Automation tasks are not available in this build')
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      if (hostWide(service)) {
        // Ids are Host-wide here, so the task must still deliver to the team Session named.
        const entry = (await service.catalog()).find(task => task.id === body.id)
        if (entry === undefined || sessionOf(entry) !== body.sessionId) throw invalid('No such task')
        await service.edit({ id: body.id, action: 'delete' })
      } else {
        await service.delete({ sessionId: body.sessionId, id: body.id })
      }
      return schedulesView()
    },
  }

  // A fresh part takes over the earlier part's active tasks: each is created again on
  // the fresh Session before the old one goes, so a failure leaves it where it was.
  async function moveSchedules(fromId, toId) {
    if (service === null) return
    // A Host-wide task changes its target in place and keeps its next firing; a
    // paused one moves too, so it resumes in the Bot's current part.
    if (hostWide(service)) {
      for (const entry of await service.catalog()) {
        if (entry.status === 'ended' || sessionOf(entry) !== fromId) continue
        await service.edit({ id: entry.id, action: 'update', patch: { target: { kind: 'session', sessionId: toId } } })
      }
      return
    }
    const records = await service.list({ sessionId: fromId })
    for (const record of records) {
      const request = requestOf(record)
      if (request === null || (request.at !== undefined && Date.parse(request.at) <= Date.now())) continue
      // A failed read or copy must prevent stopActivity from deleting an unmoved
      // task. Equal requests can be separate tasks; copy each source record.
      await service.create(toId, request)
      try {
        await service.delete({ sessionId: fromId, id: record.id })
      } catch (error) {
        // The copy is safe; archiving the earlier part will remove its old task.
        rt.warn('ds-bot: earlier copy of task %s not removed: %s', record.title, error?.message ?? error)
      }
    }
  }

  // the runtime's task ids are Host-wide, so a Bot's schedule tools reach only the tasks
  // that deliver to its own chat, or to the same group place, in any of its parts.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !OWN_TASK_TOOLS.includes(exec.name) || service === null || !hostWide(service) || service.ownedToolContract === true) return decision
    await rt.load()
    const caller = exec.agent?.id
    if (!rt.isBotSession(caller)) return decision
    const entry = (await service.catalog()).find(task => task.id === exec.arguments?.id)
    // An unknown id gets Cue's own not-found result.
    if (entry === undefined) return decision
    const target = sessionOf(entry)
    if (target !== undefined && sameOwner(ownerOf(caller), ownerOf(target))) return decision
    return { kind: 'deny', reason: OTHER_TASK_REFUSAL }
  })
  // schedule_list pages over every Host task and cannot filter by Session, and only the
  // tool formats its items. So the tool is asked for the Host range that holds the
  // caller's page (catalog() keeps list()'s order), and the other chats' tasks in that
  // range are dropped. A page whose tasks span more than one Host page comes back
  // short; total still counts all of the caller's tasks, so the next offset goes on.
  ctx.on('tools/execute', async function listOwnSchedules(exec, next) {
    if (exec.name !== 'schedule_list' || service === null || !hostWide(service)) return next()
    if (service.ownedToolContract === true) return next()
    await rt.load()
    const own = rt.isBotSession(exec.agent?.id) ? ownerOf(exec.agent.id) : undefined
    if (own === undefined) return next()
    const asked = exec.arguments ?? {}
    const limit = asked.limit ?? LIST_PAGE
    const offset = asked.offset ?? 0
    const mine = entry => {
      const target = sessionOf(entry)
      return target !== undefined && sameOwner(own, ownerOf(target))
    }
    // An invalid page gets Cue's own input error; a page it accepts anyway is still narrowed.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_READ_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
      const result = await next()
      if (result.isError || !Array.isArray(result.value?.items)) return result
      const items = result.value.items.filter(mine)
      const total = (await service.catalog()).filter(entry => mine(entry) && (asked.active === undefined || (entry.status === 'active') === asked.active)).length
      return { ...result, value: { ...result.value, items, shown: items.length, total } }
    }
    const pool = (await service.catalog()).filter(entry => asked.active === undefined || (entry.status === 'active') === asked.active)
    const positions = pool.flatMap((entry, at) => (mine(entry) ? [at] : []))
    const page = positions.slice(offset, offset + limit)
    const from = page[0] ?? pool.length
    exec.arguments = { ...asked, offset: from, limit: page.length === 0 ? 1 : Math.min(LIST_READ_LIMIT, page.at(-1) - from + 1) }
    let result
    try {
      result = await next()
    } finally {
      exec.arguments = asked
    }
    if (result.isError || !Array.isArray(result.value?.items)) return result
    const items = result.value.items.filter(mine).slice(0, limit)
    return { ...result, value: { ...result.value, items, shown: items.length, total: positions.length, limit, offset } }
  })

  Object.assign(rt, { scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}), moveSchedules })
}
