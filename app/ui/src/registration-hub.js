import { SHAPES } from '../../../ds-bot/src/client/characters.js'
import { allThemes, registerShape, registerTheme } from '../../../ds-bot/src/client/themes.js'

export function installRegistrationHub(target, onError = () => {}) {
  const hub = { registerShape, registerTheme, themes: () => Object.keys(allThemes()), shapes: () => Object.keys(SHAPES) }
  const queued = Array.isArray(target.dshBotQueue) ? target.dshBotQueue : []
  target.dshBot = hub
  target.dshBotQueue = {
    push(task) {
      try { task(hub) } catch (error) {
        console.warn('[cue] registration', error)
        onError(error)
      }
    },
  }
  for (const task of queued) target.dshBotQueue.push(task)
  return () => {
    if (target.dshBot === hub) delete target.dshBot
    delete target.dshBotQueue
  }
}
