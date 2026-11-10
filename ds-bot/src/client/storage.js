// Browser storage keys.
export const STORAGE = {
  unread: 'ds-bot:unread',
  reactions: 'ds-bot:reactions',
  seen: 'ds-bot:seen',
  prefs: 'ds-bot:prefs',
  agentSessions: 'ds-bot:agent-sessions',
  browserWidth: 'ds-bot:browser-width',
  sidebar: 'ds-bot:sidebar',
  browsers: 'ds-bot.browser.v2',
}

// The v1 store kept one page per Bot; v2 keeps a tab strip per Bot.
const LEGACY_BROWSER_KEYS = ['ds-bot.browser.v1']
// The saved theme only paints the first frame before the team loads; it follows the
// host's rename of the theme ids.
const LEGACY_THEMES = { grok: 'mono' }

export function legacyKeys(key) {
  if (key === STORAGE.browsers) return LEGACY_BROWSER_KEYS
  return []
}

// One page per Bot becomes one tab per Bot; a v2 store already present wins.
const migrateBrowsers = (storage) => {
  if (storage.getItem(STORAGE.browsers) !== null) {
    for (const key of LEGACY_BROWSER_KEYS) storage.removeItem(key)
    return
  }
  for (const key of LEGACY_BROWSER_KEYS) {
    try {
      const value = storage.getItem(key)
      if (value === null) continue
      const previous = JSON.parse(value) ?? {}
      const tabs = Object.fromEntries(Object.entries(previous)
        .filter(([, page]) => page && typeof page === 'object')
        .map(([botId, page]) => {
          const tab = { id: `v1-${botId}`, url: page.url ?? '', title: page.title ?? '' }
          return [botId, { tabs: [tab], active: tab.id }]
        }))
      storage.setItem(STORAGE.browsers, JSON.stringify(tabs))
      for (const earlier of LEGACY_BROWSER_KEYS) storage.removeItem(earlier)
      return
    } catch { /* unreadable entry: try the older name */ }
  }
}

export function migrateStorage(storage = globalThis.localStorage) {
  try { migrateBrowsers(storage) } catch { /* storage unavailable */ }
  try {
    const prefs = JSON.parse(storage.getItem(STORAGE.prefs) ?? 'null')
    if (prefs && Object.hasOwn(LEGACY_THEMES, prefs.theme ?? '')) {
      storage.setItem(STORAGE.prefs, JSON.stringify({ ...prefs, theme: LEGACY_THEMES[prefs.theme] }))
    }
  } catch { /* storage unavailable or not JSON */ }
}
