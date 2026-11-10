import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { Bubbles, ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { ConnectorDock, MailDock } from '../../../ds-bot/src/client/connectors.js'
import { sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { HandoffDock } from '../../../ds-bot/src/client/handoff-card.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon } from '../../../ds-bot/src/client/icons.js'
import { LearningDock } from '../../../ds-bot/src/client/learning-card.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { PendingQuestion } from '../../../ds-bot/src/client/questions.js'
import { SecretDock } from '../../../ds-bot/src/client/secret-card.js'
import { MarkdownText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { thinkingShown } from '../../../ds-bot/src/client/themes.js'
import { WidgetDock } from '../../../ds-bot/src/client/widget-cell.js'
import { approvalsForConversation, chatRequest, feedMatches, stopRequest } from './chat-target.js'
import { transcriptSegments } from './pi-transcript.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const sameItem = (a, b) => (a.entryId !== undefined && b.entryId !== undefined
  ? a.entryId === b.entryId && a.block === b.block
  : a.kind === b.kind && a.time === b.time && a.text === b.text && a.botId === b.botId)

// A Bot's own chat: pages from the `chat` endpoint, new entries and the reply being
// written from the feed. Entries that arrive while the first page loads wait for it.
function useChat(botId, roomId, part, feed) {
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: botId !== undefined || roomId !== undefined, failed: false })
  const [stream, setStream] = useState(null)
  const [pending, setPending] = useState([])
  const ready = useRef(false)
  const early = useRef([])
  const busy = useRef(false)
  const keep = useRef(null)

  const load = useCallback(async (cursor, scroller) => {
    if (busy.current || (botId === undefined && roomId === undefined)) return
    busy.current = true
    if (cursor === undefined) ready.current = false
    setView(current => ({ ...current, loading: true, failed: false }))
    try {
      const page = await call('chat', chatRequest(botId, roomId, cursor))
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
  }, [botId, roomId])

  // A new part starts the chat over.
  useEffect(() => { void load(undefined) }, [load, part])

  useEffect(() => feed.on((event, data) => {
    // The feed came back after a break: entries may have been missed.
    if (event === 'hello') { if (ready.current) void load(undefined); return }
    if (!feedMatches(botId, roomId, data)) return
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
  }), [feed, botId, roomId, load])

  // Shown at once: the message can come back on the feed before the request returns.
  const send = async (text, actions, sessionId) => {
    const entry = { kind: 'user', text, time: Date.now() }
    setPending(list => [...list, entry])
    actions.noteSent(sessionId)
    try {
      await actions.send(sessionId, text)
    } catch (error) {
      setPending(list => list.filter(item => item !== entry))
      throw error
    }
  }
  return { view, stream, pending, load, send, keep }
}

// What the Bot views' voice button asks of a composer (DSH's composer in the plugin):
// where the caret is, and text put in there.
function useInput(field, setText) {
  return useMemo(() => ({
    captureInsertion: () => (field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null),
    insertText: (value, at) => setText((current) => {
      const start = Math.min(at?.start ?? current.length, current.length)
      return current.slice(0, start) + value + current.slice(Math.max(start, at?.end ?? start))
    }),
  }), [field, setText])
}

function Composer({ sessionId, placeholder, disabled, running, onSend, onStop, actions, useUi, useRoster }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const [stopping, setStopping] = useState(false)
  const field = useRef(null)
  const inputActions = useInput(field, setText)
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  useLayoutEffect(() => {
    const node = field.current
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  useEffect(() => { if (!disabled) field.current?.focus() }, [sessionId, disabled])
  const submit = async () => {
    const value = text.trim()
    if (value === '' || disabled) return
    setError(null)
    setText('')
    try {
      await onSend(value)
    } catch (failure) {
      setText(current => (current === '' ? value : current))
      setError(failure.message)
    }
  }
  const stop = async () => {
    if (!running || stopping) return
    setError(null)
    setStopping(true)
    try { await onStop() } catch (failure) { setError(failure.message) } finally { setStopping(false) }
  }
  return h('div', { className: 'dsb-composer-wrap' },
    error ? h('p', { className: 'dsb-composer-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsb-composer', 'data-composer-card': '', 'data-multiline': text.includes('\n') || undefined },
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
          onChange: event => setText(event.target.value),
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
        h('button', { type: 'button', className: 'dsb-send', disabled: disabled || text.trim() === '', 'aria-label': t('Send message'), title: t('Send message'), onClick: () => { void submit() } }, h(ArrowUpIcon)))))
}

function ToolRow({ row }) {
  const label = String(row.name ?? 'tool').replaceAll('_', ' ')
  const argumentsText = row.arguments && Object.keys(row.arguments).length > 0 ? JSON.stringify(row.arguments, null, 2) : ''
  const result = typeof row.result === 'string' ? row.result : row.details === undefined ? '' : JSON.stringify(row.details, null, 2)
  return h('details', { className: 'dsb-tool-row', 'data-error': row.isError || row.error ? '' : undefined },
    h('summary', null, row.result === undefined ? t('Using {name}…', { name: label }) : t('Used {name}', { name: label })),
    argumentsText ? h('pre', null, argumentsText) : null,
    result ? h('pre', null, result) : null,
    row.error ? h('p', { role: 'alert' }, row.error) : null)
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

function Transcript({ items, sessionId, roster, actions, useUi, clock, showReasoning }) {
  return transcriptSegments(items).map((row, index) => {
    const key = rowKey(row, index)
    if (row.kind === 'chat') return h(ChatRows, { key, items: row.items, sessionId, roster, actions, useUi, clock })
    if (row.kind === 'reasoning') return showReasoning ? h('details', { key, className: 'dsb-reasoning' },
      h('summary', null, t('Thought process')), row.redacted ? h('p', null, t('Reasoning was redacted.')) : h(MarkdownText, { text: row.text, variant: 'compact' }))
      : null
    if (row.kind === 'tool') return h(ToolRow, { key, row })
    return row.reason === 'aborted'
      ? h('div', { key, className: 'dsb-stopped' }, t('Stopped'))
      : h('div', { key, className: 'dsb-failure', role: 'alert' }, row.detail || t('This turn failed.'))
  })
}

// One conversation in the main view, drawn with the Bot views' own rows, cards and docks.
export function Chat({ sessionId, team }) {
  const { actions, hooks, chat: feed } = team
  const roster = hooks.useRoster(value => value)
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const name = bot?.name ?? room?.name ?? ''
  const { view, stream, pending, load, send, keep } = useChat(bot?.id, room?.id, sessionId, feed)
  const scroller = useRef(null)
  const follow = useRef(true)
  const question = roster.questions?.[sessionId]
  const botRunning = hooks.useSessionStatus(map => map.get(sessionId)?.running === true)
  const useWork = hooks.useWork ?? (() => false)
  const approvals = useWork(work => approvalsForConversation(work, bot?.id, room?.id))
  const roomRunning = useWork(work => room !== undefined && (work.rooms?.[room.id] ?? []).length > 0)
  const running = botRunning || roomRunning
  const stop = () => {
    const request = stopRequest(bot?.id, room?.id)
    return request.endpoint === 'stop-bot-work'
      ? actions.stopBotWork(request.payload.botId)
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

  return h('div', { className: 'dsb-chat' },
    h('div', { ref: scroller, className: 'dsb-scroll', 'data-conversation-scroll': '', onScroll },
      h('div', { className: 'dsb-column' },
        earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
        h('div', { className: 'dsb-flow', 'data-chat-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': view.loading },
          h(Transcript, { items: view.items, sessionId, roster, actions, useUi: hooks.useUi, clock: true, showReasoning: thinkingShown(roster.prefs) }),
          pending.length ? h('div', { className: 'dsb-pending' }, h(ChatRows, { items: pending, sessionId, roster, actions })) : null,
          stream?.text ? h(Bubbles, { texts: [stream.text], roster, selfId: bot?.id, actions, streaming: true, sessionId }) : null,
          // The Bot views' activity row (from the header pill) draws itself in here.
          h('div', { 'data-chat-running': '' }),
          question ? h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs) }) : null))),
    h('div', { className: 'dsb-composer-root' },
      approvals.length > 0 ? h('div', { className: 'bt-member-cards' }, approvals.map(approval => h(ApprovalCard, {
        key: approval.id,
        approval,
        bot: roster.byId[approval.botId] ?? bot,
        actions,
      }))) : null,
      h(ModelChoiceDock, { sessionId, useRoster: hooks.useRoster, actions }),
      h(WidgetDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(SecretDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(ConnectorDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
      h(MailDock, { sessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }),
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
      h(Composer, {
        sessionId,
        disabled: waiting,
        running,
        placeholder: waiting ? t('Pick a model and {name} can start.', { name }) : name ? t('Message {name}', { name }) : t('Message'),
        onSend: text => send(text, actions, sessionId),
        onStop: stop,
        actions,
        useUi: hooks.useUi,
        useRoster: hooks.useRoster,
      })))
}
