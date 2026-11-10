// The locale adapter used by ds-bot/src/client/i18n.js. It registers a dictionary
// and translates through a bound namespace.
import { resolveLanguage } from '../../../ds-bot/src/client/i18n.js'

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

export function createLocale(tag) {
  const active = resolveLanguage(tag)
  const dictionaries = new Map()
  const locales = new Map([['en', { id: 'en', label: 'English' }], ['zh', { id: 'zh', label: '简体中文' }]])
  return {
    getLocale: () => ({ active, locales: [...locales.values()] }),
    addLanguage(definition) {
      locales.set(definition.id, definition)
      return () => { locales.delete(definition.id) }
    },
    register(namespace, language, dictionary) {
      const key = `${namespace}:${language}`
      dictionaries.set(key, dictionary)
      return () => { dictionaries.delete(key) }
    },
    bind: namespace => (key, params) => fill(dictionaries.get(`${namespace}:${active}`)?.[key] ?? key, params),
  }
}
