import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { sessionMention } from '../../../ds-bot/src/client/at-menu.js'
import { Bubbles, ChatRows, Shimmer, ToolCell } from '../../../ds-bot/src/client/cells.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { AppAccessDock, ComputerHandoffDock } from '../../../ds-bot/src/client/computer.js'
import { ConnectorDock, MailDock } from '../../../ds-bot/src/client/connectors.js'
import { sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { HandoffDock } from '../../../ds-bot/src/client/handoff-card.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon, CloseIcon } from '../../../ds-bot/src/client/icons.js'
import { LearningDock } from '../../../ds-bot/src/client/learning-card.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { PendingQuestion } from '../../../ds-bot/src/client/questions.js'
import { QueueDock } from '../../../ds-bot/src/client/queue-dock.js'
import { SecretDock } from '../../../ds-bot/src/client/secret-card.js'
import { MarkdownText } from '../../../ds-bot/src/client/ui-primitives.js'
import { thinkingShown } from '../../../ds-bot/src/client/themes.js'
import { relativeShort } from '../../../ds-bot/src/client/text.js'
import { FailureCell } from '../../../ds-bot/src/client/turn-error.js'
import { WidgetDock } from '../../../ds-bot/src/client/widget-cell.js'
import { approvalsForConversation, chatRequest, feedMatches, stopRequest } from './chat-target.js'
import { transcriptSegments } from './pi-transcript.js'
import { uploadAttachment } from './api.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const ATTACHMENT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const sameItem = (a, b) => (a.entryId !== undefined && b.entryId !== undefined
  ? a.entryId === b.entryId && a.block === b.block
  : a.kind === b.kind && a.time === b.time && a.text === b.text && a.botId === b.botId)

// A Bot's own chat: pages from the `chat` endpoint, new entries and the reply being
// written from the feed. Entries that arrive while the first page loads wait for it.
function useChat(botId, roomId, agentSessionId, part, feed) {
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: botId !== undefined || roomId !== undefined || agentSessionId !== undefined, failed: false })
  const [stream, setStream] = useState(null)
  const [pending, setPending] = useState([])
  const ready = useRef(false)
  const early = useRef([])
  const busy = useRef(false)
  const keep = useRef(null)

  const load = useCallback(async (cursor, scroller) => {
    if (busy.current || (botId === undefined && roomId === undefined && agentSessionId === undefined)) return
    busy.current = true
    if (cursor === undefined) ready.current = false
    setView(current => ({ ...current, loading: true, failed: false }))
    try {
      const page = await call(agentSessionId === undefined ? 'chat' : 'agent-chat', chatRequest(botId, roomId, cursor, agentSessionId))
      if (cursor === undefined) {
        const later = early.current.filter(entry => entry.sessionId === page.sessionId && !page.items.some(item => sameItem(item, entry.item)))
        early.current = []
        ready.current = true
        setView({ sessionId: page.sessionId, items: [...page.items, ...later.map(entry => entry.item)], cursor: page.cursor, loading: false, failed: false })
      } else {
        // Content added above the viewport would push the view down; keep its distance from the end.
        if (scroller) keep.current = scroller.scrollHeight - scroller.scrollTop
        setView(current => ({ ...current, items: [...page.items, ...current.items], cursor: page.cursor, loading: false }))
      }
    } catch {
      ready.current = cursor !== undefined || ready.current
      setView(current => ({ ...current, loading: false, failed: true }))
    } finally {
      busy.current = false
    }
  }, [botId, roomId, agentSessionId])

  // A new part starts the chat over.
  useEffect(() => { void load(undefined) }, [load, part])

  useEffect(() => feed.on((event, data) => {
    // The feed came back after a break: entries may have been missed.
    if (event === 'hello') { if (ready.current) void load(undefined); return }
    if (!feedMatches(botId, roomId, data, agentSessionId)) return
    if (event === 'message') {
      if (!ready.current) { early.current.push(data); return }
      setView(current => (data.sessionId !== current.sessionId || current.items.some(item => sameItem(item, data.item)) ? current : { ...current, items: [...current.items, data.item] }))
      if (data.item.kind === 'user') {
        setPending((list) => {
          const at = list.findIndex(entry => entry.text === data.item.text)
          return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]
        })
      }
      if (data.item.kind === 'bot') setStream(null)
    } else if (event === 'stream') {
      if (data.phase === 'start') setStream({ attemptId: data.attemptId, text: '' })
      else if (data.phase === 'end') setStream(current => (current?.attemptId === data.attemptId ? null : current))
      else setStream(current => (current?.attemptId === data.attemptId ? { ...current, text: current.text + data.text } : current))
    }
  }), [feed, botId, roomId, agentSessionId, load])

  // Shown at once: the message can come back on the feed before the request returns.
  const send = async (text, attachments, references, actions, sessionId, queued = false) => {
    const entry = {
      kind: 'user', text, attachments, images: attachments.filter(item => item.type === 'image').length,
      ...(references.length > 0 ? { referenceLabels: references.map(reference => reference.label) } : {}),
      time: Date.now(),
    }
    if (!queued) setPending(list => [...list, entry])
    actions.noteSent(sessionId)
    try {
      await actions.send(sessionId, text, attachments, references)
    } catch (error) {
      if (!queued) setPending(list => list.filter(item => item !== entry))
      throw error
    }
  }
  return { view, stream, pending, load, send, keep }
}

function useQueue(sessionId, feed) {
  const [inbox, setInbox] = useState({ 'next-turn': [] })
  const load = useCallback(async () => {
    try { setInbox(await call('queue', { sessionId })) } catch { setInbox({ 'next-turn': [] }) }
  }, [sessionId])
  useEffect(() => { void load() }, [load])
  useEffect(() => feed.on((event, data) => {
    if (event === 'hello') { void load(); return }
    if (event === 'queue' && data?.sessionId === sessionId && data.inbox) setInbox(data.inbox)
  }), [feed, load, sessionId])
  const update = useCallback(async (itemId, action) => {
    try {
      await call('queue-update', { sessionId, itemId: String(itemId), action })
      await load()
      return { ok: true }
    } catch (error) {
      await load()
      return { ok: false, error: { code: error?.code ?? 'bot/error', message: error?.message ?? String(error) } }
    }
  }, [load, sessionId])
  return { inbox, update }
}

const loadQueuedImage = async attachment => {
  const id = String(attachment?.attachmentId ?? '')
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Attachment is unavailable')
  return `api/bot/attachment/${id.slice('sha256:'.length)}`
}

// What the Bot views' voice button asks of the composer: the caret position and
// text inserted there.
function useInput(field, setText) {
  return useMemo(() => ({
    captureInsertion: () => (field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null),
    insertText: (value, at) => setText((current) => {
      const start = Math.min(at?.start ?? current.length, current.length)
      return current.slice(0, start) + value + current.slice(Math.max(start, at?.end ?? start))
    }),
  }), [field, setText])
}

const draftChange = (before, after) => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd -= 1; newEnd -= 1 }
  return { start, oldEnd, delta: newEnd - oldEnd }
}

export function rebaseChatReferences(before, after, references) {
  const change = draftChange(before, after)
  return references.flatMap(reference => {
    if (reference.end <= change.start) return [reference]
    if (reference.start >= change.oldEnd) return [{ ...reference, start: reference.start + change.delta, end: reference.end + change.delta }]
    return []
  })
}

function ChatReferencePicker({ sessionId, request, actions, onPick }) {
  const [state, setState] = useState({ loading: true, rows: [], error: null })
  const first = useRef(null)
  const load = useCallback(() => {
    let active = true
    setState({ loading: true, rows: [], error: null })
    void Promise.resolve(actions.referenceChats(sessionId)).then(
      rows => { if (active) setState({ loading: false, rows, error: null }) },
      error => { if (active) setState({ loading: false, rows: [], error: error?.message ?? String(error) }) },
    )
    return () => { active = false }
  }, [actions, sessionId, request?.token])
  useEffect(load, [load])
  useEffect(() => { if (!state.loading) first.current?.focus?.() }, [state.loading])
  const card = document.querySelector?.('[data-composer-card]')
  const rect = card?.querySelector?.('.bt-plus')?.getBoundingClientRect?.()
  const style = rect ? { left: rect.left, bottom: window.innerHeight - rect.top + 8 } : { left: 20, bottom: 80 }
  const close = () => actions.closeReferenceChat()
  const choose = row => { onPick(row, request.span); close() }
  return createPortal(h('div', {
    className: 'bt-menu bt-menu-up', role: 'listbox', 'aria-label': t('Reference a chat'), style,
    onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); close() } },
  },
  state.loading ? h('button', { type: 'button', disabled: true, role: 'option' }, t('Loading…'))
    : state.error ? h('button', { type: 'button', role: 'option', onClick: load }, `${state.error} · ${t('Retry')}`)
      : state.rows.length === 0 ? h('button', { type: 'button', disabled: true, role: 'option' }, t('No conversations'))
        : state.rows.map((row, index) => h('button', {
          ref: index === 0 ? first : undefined, key: row.sessionId, type: 'button', role: 'option', onClick: () => choose(row),
        }, h('span', { className: 'bt-menu-label' }, row.label), row.updatedAt ? h('span', { className: 'bt-menu-hint' }, relativeShort(row.updatedAt)) : null))), document.body)
}

function Composer({ sessionId, placeholder, disabled, running, onSend, onStop, actions, useUi, useRoster }) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [references, setReferences] = useState([])
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const field = useRef(null)
  const inputActions = useInput(field, setText)
  const referenceRequest = useUi(state => state.referenceChat?.sessionId === sessionId ? state.referenceChat : null)
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  useLayoutEffect(() => {
    const node = field.current
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  useEffect(() => { if (!disabled) field.current?.focus() }, [sessionId, disabled])
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(() => () => {
    for (const item of attachmentsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  }, [])
  const addFiles = (files) => {
    const incoming = [...(files ?? [])].filter(file => file instanceof File)
    if (incoming.length === 0) return
    setAttachments(current => [...current, ...incoming.slice(0, Math.max(0, 10 - current.length)).map(file => {
      const image = ATTACHMENT_IMAGE_TYPES.has(file.type)
      return {
        id: `${Date.now()}:${crypto.randomUUID?.() ?? Math.random()}`,
        file,
        type: image ? 'image' : 'file',
        previewUrl: image ? URL.createObjectURL(file) : undefined,
      }
    })])
  }
  const removeAttachment = (id) => setAttachments(current => {
    const removed = current.find(item => item.id === id)
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
    return current.filter(item => item.id !== id)
  })
  const changeText = value => {
    setReferences(current => rebaseChatReferences(text, value, current))
    setText(value)
  }
  const insertReference = (row, at) => {
    const start = Math.min(at?.start ?? text.length, text.length)
    const end = Math.max(start, Math.min(at?.end ?? start, text.length))
    const visible = `@${row.label}`
    const next = `${text.slice(0, start)}${visible} ${text.slice(end)}`
    const kept = rebaseChatReferences(text, next, references)
    const reference = { sessionId: row.sessionId, label: row.label, ref: sessionMention(row.sessionId, row.label), start, end: start + visible.length }
    setText(next)
    setReferences([...kept, reference])
    requestAnimationFrame(() => {
      const caret = reference.end + 1
      field.current?.focus?.()
      field.current?.setSelectionRange?.(caret, caret)
    })
  }
  const submit = async () => {
    const value = text.trim()
    const files = attachments
    const leading = text.length - text.trimStart().length
    const sentReferences = references
      .filter(reference => text.slice(reference.start, reference.end) === `@${reference.label}`)
      .map(({ sessionId: referencedSessionId, label, ref }) => ({ sessionId: referencedSessionId, label, ref }))
    if ((value === '' && files.length === 0) || disabled || sending) return
    setError(null)
    setText('')
    setReferences([])
    setSending(true)
    try {
      const uploaded = await Promise.all(files.map(async item => ({ type: item.type, attachment: await uploadAttachment(item.file) })))
      await onSend(value, uploaded, sentReferences)
      for (const item of files) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      setAttachments(current => current.filter(item => !files.includes(item)))
    } catch (failure) {
      setText(current => (current === '' ? value : current))
      setReferences(current => (current.length === 0 ? references.map(reference => ({ ...reference, start: Math.max(0, reference.start - leading), end: Math.max(0, reference.end - leading) })) : current))
      setError(failure.message)
    } finally { setSending(false) }
  }
  const stop = async () => {
    if (!running || stopping) return
    setError(null)
    setStopping(true)
    try { await onStop() } catch (failure) { setError(failure.message) } finally { setStopping(false) }
  }
  return h('div', { className: 'dsb-composer-wrap' },
    error ? h('p', { className: 'dsb-composer-error', role: 'alert' }, error) : null,
    h('div', {
      className: 'dsb-composer',
      'data-composer-card': '',
      'data-multiline': text.includes('\n') || attachments.length > 0 || undefined,
      onDragOver: event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault() },
      onDrop: event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files) } },
    },
      h('input', { type: 'file', multiple: true, hidden: true, onChange: event => { addFiles(event.target.files); event.target.value = '' } }),
      attachments.length > 0 ? h('div', { className: 'dsb-attachments', 'data-slot': 'conversation.input.attachments' }, attachments.map(item => h('span', { key: item.id, className: 'dsb-attachment' },
        item.previewUrl ? h('img', { src: item.previewUrl, alt: '' }) : h('span', { className: 'dsb-attachment-kind', 'aria-hidden': true }, item.file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'),
        h('span', { className: 'dsb-attachment-name', title: item.file.name }, item.file.name),
        h('button', { type: 'button', 'aria-label': t('Remove {name}', { name: item.file.name }), onClick: () => removeAttachment(item.id) }, h(CloseIcon))))) : null,
      h('div', { className: 'dsb-composer-tools' }, h(ComposerPlus, { sessionId, inputActions, useRoster, actions })),
      h('div', { className: 'dsb-composer-input', 'data-input-scroll': '' },
        h('textarea', {
          ref: field,
          rows: 1,
          value: text,
          disabled,
          placeholder,
          'aria-label': placeholder,
          'data-composer-input': '',
          onChange: event => changeText(event.target.value),
          onPaste: event => { if (event.clipboardData?.files?.length) { event.preventDefault(); addFiles(event.clipboardData.files) } },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && enterToSend && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          },
        })),
      h('div', { className: 'dsb-composer-trailing' },
        running ? h('button', { type: 'button', className: 'dsb-stop', disabled: stopping, onClick: () => { void stop() } }, stopping ? t('Stopping…') : t('Stop')) : null,
        h(ComposerVoice, { sessionId, inputActions, actions, useUi, useRoster }),
        h('button', { type: 'button', className: 'dsb-send', disabled: disabled || sending || (text.trim() === '' && attachments.length === 0), 'aria-label': t('Send message'), title: t('Send message'), onClick: () => { void submit() } }, h(ArrowUpIcon)))),
    referenceRequest ? h(ChatReferencePicker, { sessionId, request: referenceRequest, actions, onPick: insertReference }) : null)
}

function ApprovalCard({ approval, bot, actions }) {
  const [busy, setBusy] = useState(false)
  const answer = (choice) => {
    setBusy(true)
    void Promise.resolve(actions.answerApproval(approval.id, choice))
      .catch(error => actions.reportError(error, 'approval'))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-mw-card', role: 'group', 'aria-label': t('{name} is waiting for your approval', { name: bot.name }) },
    h('div', { className: 'bt-mw-tool' }, approval.tool),
    approval.detail?.text ? h('div', { className: 'bt-mw-text' }, approval.detail.text) : null,
    approval.reason ? h('div', { className: 'bt-mw-reason' }, approval.reason) : null,
    approval.detail?.code ? h('code', { className: 'bt-mw-code', title: approval.detail.code }, approval.detail.code) : null,
    h('div', { className: 'bt-mw-actions' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer('reject') }, t('Reject')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => answer('allow') }, t('Allow once'))))
}

const rowKey = (row, index) => {
  const item = row.kind === 'chat' ? row.items[0] : row
  return item?.entryId === undefined ? `${row.kind}:${row.callId ?? index}` : `${row.kind}:${item.entryId}:${item.block ?? ''}`
}

function Transcript({ items, sessionId, roster, actions, hooks, clock, showReasoning }) {
  return transcriptSegments(items).map((row, index) => {
    const key = rowKey(row, index)
    if (row.kind === 'chat') return h(ChatRows, { key, items: row.items, sessionId, roster, actions, useUi: hooks.useUi, clock })
    if (row.kind === 'reasoning') return showReasoning ? h('details', { key, className: 'dsb-reasoning' },
      h('summary', null, t('Thought process')), row.redacted ? h('p', null, t('Reasoning was redacted.')) : h(MarkdownText, { text: row.text, variant: 'compact' }))
      : null
    if (row.kind === 'tool') {
      const done = row.result !== undefined
      const root = {
        kind: done ? 'tool-result' : 'tool-call',
        name: row.name,
        callId: row.callId,
        argsRaw: JSON.stringify(row.arguments ?? {}),
        content: row.content ?? [],
        isError: row.isError === true,
        ...(row.error === undefined ? {} : { error: { message: row.error } }),
        ...(row.turn === undefined ? {} : { turn: row.turn }),
      }
      return h(ToolCell, {
        key,
        node: { key, data: { root }, ...(row.turn === undefined ? {} : { location: { turn: { turn: row.turn } } }) },
        sessionId,
        useRoster: hooks.useRoster,
        useUi: hooks.useUi,
        useWork: hooks.useWork,
        useHeldCards: hooks.useHeldCards,
        useBrowserHolds: hooks.useBrowserHolds,
        useBrowserTabs: hooks.useBrowserTabs,
        useBrowserPages: hooks.useBrowserPages,
        useComputer: hooks.useComputer,
        actions,
      })
    }
    if (row.reason === 'aborted') return h('div', { key, className: 'dsb-stopped' }, t('Stopped'))
    if (roster.byId?.[sessionId] !== undefined && typeof hooks.useTurnClock === 'function') {
      const code = row.code ?? (row.reason === 'interrupted' ? 'INTERRUPTED' : 'UNKNOWN')
      return h(FailureCell, {
        key,
        node: { data: { kind: 'turn-error', turn: row.turn, code, message: row.detail ?? '' } },
        sessionId,
        useRoster: hooks.useRoster,
        useTurnClock: hooks.useTurnClock,
        actions,
      })
    }
    return h('div', { key, className: 'dsb-failure', role: 'alert' }, row.detail || t('This turn failed.'))
  })
}

// One conversation in the main view, drawn with the Bot views' own rows, cards and docks.
export function Chat({ sessionId, team, pluginSlot = () => null }) {
  const { actions, hooks, chat: feed } = team
  const roster = hooks.useRoster(value => value)
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const agent = roster.agentsById?.[roster.agentOf?.[sessionId]]
  const agentSessionId = agent === undefined ? undefined : sessionId
  const name = bot?.name ?? room?.name ?? agent?.name ?? ''
  const { view, stream, pending, load, send, keep } = useChat(bot?.id, room?.id, agentSessionId, sessionId, feed)
  const queue = useQueue(sessionId, feed)
  const scroller = useRef(null)
  const follow = useRef(true)
  const question = roster.questions?.[sessionId]
  const botRunning = hooks.useSessionStatus(map => map.get(sessionId)?.running === true)
  const useWork = hooks.useWork ?? (() => false)
  const approvals = useWork(work => approvalsForConversation(work, bot?.id, room?.id, agentSessionId))
  const roomRunning = useWork(work => room !== undefined && (work.rooms?.[room.id] ?? []).length > 0)
  const running = botRunning || roomRunning
  const turnAt = useWork(work => work.turns?.[sessionId])
  useEffect(() => actions.noteChat?.(sessionId, view.items, running, turnAt), [actions, sessionId, view.items, running, turnAt])
  const stop = () => {
    const request = stopRequest(bot?.id, room?.id, agentSessionId)
    return request.endpoint === 'stop-bot-work'
      ? actions.stopBotWork(request.payload.botId)
      : request.endpoint === 'stop-agent-work'
        ? actions.stopAgentWork(request.payload.sessionId)
        : actions.stopRoomWork(request.payload.roomId)
  }

  useLayoutEffect(() => {
    const node = scroller.current
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
  }, [view.items, stream, pending, running, question])

  const onScroll = () => {
    const node = scroller.current
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX
  }
  const earlier = view.loading && view.sessionId !== null ? h(Shimmer, null, t('Loading earlier messages…'))
    : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor ?? undefined, scroller.current) }, t('Couldn’t load earlier messages · Retry'))
      : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor, scroller.current) }, t('Load earlier')) : null
  const waiting = bot?.waiting === true
  const useSession = team.sessionHook?.(sessionId) ?? (select => select({ pendingSubmissions: [], running, subagent: null }))

  return h('div', { className: 'dsb-chat' },
    h('div', { ref: scroller, className: 'dsb-scroll', 'data-conversation-scroll': '', onScroll },
      h('div', { className: 'dsb-column' },
        earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
        pluginSlot('conversation.before', { sessionId, roster, bot, room, agent }),
        h('div', { className: 'dsb-flow', 'data-chat-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': view.loading },
          h(Transcript, { items: view.items, sessionId, roster, actions, hooks, clock: true, showReasoning: thinkingShown(roster.prefs) }),
          pending.length ? h('div', { className: 'dsb-pending' }, h(ChatRows, { items: pending, sessionId, roster, actions })) : null,
          stream?.text ? h(Bubbles, { texts: [stream.text], roster, selfId: bot?.id, actions, streaming: true, sessionId }) : null,
          // The Bot views' activity row (from the header pill) draws itself in here.
          h('div', { 'data-chat-running': '' }),
          question ? h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs) }) : null),
        pluginSlot('conversation.after', { sessionId, roster, bot, room, agent }))),
    h('div', { className: 'dsb-composer-root' },
      approvals.length > 0 ? h('div', { className: 'bt-member-cards' }, approvals.map(approval => h(ApprovalCard, {
        key: approval.id,
        approval,
        bot: roster.byId[approval.botId] ?? bot ?? agent ?? { name: t('Agent') },
        actions,
      }))) : null,
      h(ModelChoiceDock, { sessionId, useRoster: hooks.useRoster, actions }),
      h(WidgetDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(SecretDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(ConnectorDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(MailDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(AppAccessDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, useComputer: hooks.useComputer, actions }),
      h(ComputerHandoffDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, useComputer: hooks.useComputer, actions }),
      h(HandoffDock, {
        sessionId,
        useRoster: hooks.useRoster,
        useCards: hooks.useCards,
        useHeldCards: hooks.useHeldCards,
        useBrowserHolds: hooks.useBrowserHolds,
        useBrowserTabs: hooks.useBrowserTabs,
        useBrowserPages: hooks.useBrowserPages,
        actions,
      }),
      h(LearningDock, { sessionId, useRoster: hooks.useRoster, actions }),
      h(QueueDock, {
        useSession,
        useProjection: name => name === 'inbox' ? queue.inbox : undefined,
        updateQueue: queue.update,
        loadImage: loadQueuedImage,
        actions,
      }),
      h(Composer, {
        sessionId,
        disabled: waiting,
        running,
        placeholder: waiting ? t('Pick a model and {name} can start.', { name }) : name ? t('Message {name}', { name }) : t('Message'),
        onSend: (text, attachments, references) => send(text, attachments, references, actions, sessionId, running),
        onStop: stop,
        actions,
        useUi: hooks.useUi,
        useRoster: hooks.useRoster,
      })))
}
