import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, GoalIcon, MicIcon, PaperclipIcon, PeopleIcon, PlusIcon, WaveIcon } from './icons.js'
import { canSetGoal } from './goal.js'
import { BotMark } from './mark.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'
import { insertComposerNewline, sendsOnEnter } from './enter-key.js'
import { enterSteers, steerable } from './enter-steer.js'
import { openCapture, requestPreparation, speechCatalog, transcribeWave } from './speech.js'

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => recognition.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = ({ continuous = true, onEnd } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    engine.lang = navigator.language || 'zh-CN'
    engine.interimResults = true
    engine.continuous = continuous
    engine.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
    }
    engine.onend = () => { setListening(false); recognition.current = null; onEnd?.() }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  return { listening, note, start, stop }
}

export function useRemoteDictation(speech, onText, { capture = openCapture } = {}) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const active = useRef(null)
  const timer = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
  const cancel = () => {
    clearTimeout(timer.current)
    timer.current = null
    active.current?.controller.abort(new Error('Dictation cancelled'))
    active.current?.capture?.cancel()
    active.current = null
    setListening(false)
  }
  useEffect(() => cancel, [])
  useEffect(() => {
    if (!note) return undefined
    const timeout = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timeout)
  }, [note])
  const stop = async () => {
    const held = active.current
    if (held === null) return
    clearTimeout(timer.current)
    timer.current = null
    setListening(false)
    try {
      const wave = await held.capture.finish(held.catalog.maxDurationSeconds)
      const text = wave ? await transcribeWave(speech, held.catalog, wave, held.controller.signal) : ''
      if (active.current !== held) return
      if (text) latest.current(text, true)
    } catch (error) {
      if (active.current === held && !held.controller.signal.aborted) setNote(t(error?.kind === 'too-long' ? 'That was too long to recognize' : "Couldn't hear that"))
    } finally {
      if (active.current === held) active.current = null
    }
  }
  const start = async () => {
    if (!speech || active.current !== null) return false
    const controller = new AbortController()
    const held = { controller, capture: null, catalog: null }
    active.current = held
    try {
      const { catalog, usable } = await speechCatalog(speech)
      if (!usable) {
        await requestPreparation(speech, catalog.selection.providerId)
        setNote(t('Preparing voice input…'))
        if (active.current === held) active.current = null
        return false
      }
      const recording = await capture()
      if (controller.signal.aborted) { recording.cancel(); return false }
      held.capture = recording
      held.catalog = catalog
      setListening(true)
      timer.current = setTimeout(() => { void stop() }, Math.max(1, catalog.maxDurationSeconds - 0.1) * 1000)
      return true
    } catch (error) {
      if (!controller.signal.aborted) setNote(t(error?.kind === 'blocked' ? 'Microphone access is blocked' : "Couldn't start dictation"))
      if (active.current === held) active.current = null
      return false
    }
  }
  return { listening, note, start, stop, cancel }
}

export function ComposerVoice({ sessionId, inputActions, actions, useUi, useRoster }) {
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  const composerRoot = useRef(null)
  useEffect(() => {
    const root = composerRoot.current?.closest('[data-composer-card]')
    if (enterToSend || !inputActions || !root) return undefined
    const onKey = event => insertComposerNewline(event, inputActions)
    root.addEventListener('keydown', onKey, true)
    return () => root.removeEventListener('keydown', onKey, true)
  }, [enterToSend, inputActions])
  const dictation = useDictation((text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  const speech = actions.speech()
  const remoteDictation = useRemoteDictation(speech, (text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  // Reply from a message's hover toolbar quotes it into this composer.
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  useEffect(() => {
    if (!quote || !inputActions) return
    actions.clearQuote(quote.token)
    const excerpt = quote.text.replace(/\s+/g, ' ').trim()
    const line = `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
    inputActions.insertText(line, inputActions.captureInsertion())
    const box = document.querySelector('[data-cue-main] [data-composer-input]')
    if (box instanceof HTMLElement) {
      box.focus()
      box.setSelectionRange?.(box.value?.length ?? 0, box.value?.length ?? 0)
    }
  }, [quote?.token])
  if (sessionId === undefined) return null
  const shownDictation = speech ? remoteDictation : dictation
  return h(Fragment, null,
    h('button', {
      type: 'button', className: 'bt-mic', 'aria-label': shownDictation.listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': shownDictation.listening, title: shownDictation.listening ? t('Stop dictation') : t('Dictate'),
      onMouseDown: keepComposerFocus, onClick: () => (shownDictation.listening ? shownDictation.stop() : shownDictation.start()),
    }, h(MicIcon)),
    h('button', {
      ref: composerRoot, type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      onMouseDown: keepComposerFocus, onClick: () => actions.openVoice(sessionId),
    }, h(WaveIcon, { size: 18 })),
    shownDictation.note ? h('span', { className: 'bt-mic-note', role: 'status' }, shownDictation.note) : null)
}

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu
// does not remount its mark on every keystroke.
export function menuIcons(roster) {
  const marks = new Map()
  return (row) => {
    if (!row.bot) return PeopleIcon
    const id = row.bot.id
    if (!marks.has(id)) marks.set(id, ({ size = 14 }) => h(BotMark, { bot: roster.getSnapshot().byId[id] ?? row.bot, size }))
    return marks.get(id)
  }
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another
// chat, or set a scheduled task for this chat. It stands in for the shell's command
// menu, whose plan, permission, model and compact rows reach past what Cue keeps
// for its Bots; "/" still opens that menu. Files go through the shell's own file
// input beside it.
export function ComposerPlus({ sessionId, inputActions, useInput, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  // The selector runs on every input change, so inputNow stays live for the key
  // handler while `ready` re-renders only when steerability flips.
  const inputNow = useRef(undefined)
  const ready = useInput?.((state) => { inputNow.current = state; return steerable(state) }) === true
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(null) }
    const onKey = (event) => {
      if (stepMenuFocus(menu.current, event, button.current)) return
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(null) }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // No deps: the "+" can mount after this effect first ran, and the card swap on a
  // session switch must pick the placeholder up again.
  useEffect(() => {
    const card = button.current?.closest('[data-composer-card]')
    if (!ready || card === null || card === undefined) return undefined
    card.style.setProperty('--bt-placeholder', JSON.stringify(t('Press Enter to steer queued messages')))
    return () => card.style.removeProperty('--bt-placeholder')
  })
  useEffect(() => {
    let steering = false
    const onKey = (event) => {
      if (steering || event.defaultPrevented || open) return
      const target = event.target
      if (typeof target?.closest !== 'function') return
      const card = button.current?.closest('[data-composer-card]')
      if (card === null || card === undefined || target.closest('[data-composer-card]') !== card) return
      if (target.closest('[contenteditable=true]') === null) return
      if (target.closest('[data-composer-composing]')) return
      if (target.ownerDocument?.querySelector('[role="listbox"]')) return
      if (!enterSteers(event, inputNow.current)) return
      event.preventDefault()
      event.stopPropagation()
      steering = true
      void Promise.resolve(actions.steerQueued(sessionId)).finally(() => { steering = false })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, sessionId])
  // Hooks stay above the early return below: the roster may not know the Bot yet, and a
  // render that skips a hook breaks the composer's slot when the roster arrives.
  // Anchored to the "+" each render: the visible viewport can move (on-screen
  // keyboard) while the menu is open.
  const place = useMemo(() => {
    if (!shown || !button.current) return null
    const rect = button.current.getBoundingClientRect()
    return { left: rect.left, bottom: viewBottom() - rect.top + 8 }
  }, [shown, open, tick])
  const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id
  if (sessionId === undefined || target === undefined) return null
  const fileInput = () => button.current?.closest('[data-composer-card]')?.querySelector('input[type=file]')
  const toggle = () => {
    if (open) { setOpen(null); return }
    // Files go through the composer's own file input; a composer without one takes none.
    setOpen({ files: Boolean(fileInput()) })
  }
  const attach = () => {
    setOpen(null)
    fileInput()?.click()
  }
  const schedule = () => {
    setOpen(null)
    actions.openSettings('schedules', target)
  }
  // The chats open in the shell's "@" menu at the caret, so the pick lands where the
  // user was typing.
  const reference = () => {
    setOpen(null)
    actions.referenceChat(sessionId, inputActions?.captureInsertion?.())
  }
  const canReference = typeof inputActions?.captureInsertion === 'function' && actions.canReferenceChat()
  const room = roster.roomsById?.[sessionId]
  const goal = () => {
    setOpen(null)
    actions.composeGoal(room.id)
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(open), onMouseDown: keepComposerFocus, onClick: toggle,
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-menu-up bt-plus-menu', role: 'menu', 'aria-label': t('Add'),
      style: place ?? {}, 'data-leaving': leaving || undefined,
    },
    shown.files ? h('button', { type: 'button', role: 'menuitem', onClick: attach }, h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))) : null,
    canReference ? h('button', { type: 'button', role: 'menuitem', onMouseDown: keepComposerFocus, onClick: reference }, h(ChatsIcon), h('span', { className: 'bt-menu-label' }, t('Reference a chat'))) : null,
    canSetGoal(room, roster) ? h('button', { type: 'button', role: 'menuitem', onClick: goal }, h(GoalIcon), h('span', { className: 'bt-menu-label' }, t('Set a goal'))) : null,
    h('button', { type: 'button', role: 'menuitem', onClick: schedule }, h(ClockIcon), h('span', { className: 'bt-menu-label' }, t('Scheduled task')))), document.body) : null)
}
