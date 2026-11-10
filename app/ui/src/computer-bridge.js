import { lookOf } from '../../../ds-bot/src/client/characters.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { GRADIENTS, INKS, isHex } from '../../../ds-bot/src/client/inks.js'

const paintOf = color => isHex(color) ? color : GRADIENTS[color]?.[0]?.[1] ?? INKS[color]?.[0] ?? INKS.gray[0]

export function desktopComputerEntries(roster, live) {
  const name = id => roster.byId?.[id]?.name ?? 'a Bot'
  const look = id => lookOf(roster.byId?.[id])
  const rows = (live.leases ?? []).map(entry => ({
    botId: entry.botId,
    name: name(entry.botId),
    app: entry.kind === 'foreground' ? t('In the foreground') : entry.appName,
    label: entry.kind === 'foreground' ? t('{name} · foreground', { name: name(entry.botId) }) : `${name(entry.botId)} · ${entry.appName}`,
    color: paintOf(look(entry.botId).color),
    avatar: look(entry.botId).image,
  }))
  for (const [botId, entry] of Object.entries(live.bots ?? {})) {
    if (entry.waitingFor !== 'user-idle') continue
    rows.push({
      botId,
      waiting: true,
      name: name(botId),
      app: t('waits for the computer'),
      label: t('{name} waits for the computer', { name: name(botId) }),
      color: paintOf(look(botId).color),
      avatar: look(botId).image,
    })
  }
  return { rows, labels: { stop: t('Stop'), stopAll: t('Stop all'), letGo: t('Let it continue') } }
}

export function desktopComputerAction(actions, { kind, botId } = {}) {
  if (kind === 'stop') return actions.computerStop(botId)
  if (kind === 'stopall') return actions.computerStop(null, true)
  if (kind === 'letgo') return actions.computerAllowForeground(botId)
}

export function desktopComputerCursor(roster, event) {
  const look = lookOf(roster.byId?.[event.botId])
  return { ...event, color: paintOf(look.color), avatar: look.image }
}
