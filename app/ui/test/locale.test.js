import assert from 'node:assert/strict'
import test from 'node:test'
import { dateLocale, hostText, installLocale, t } from '../../../ds-bot/src/client/i18n.js'
import { createLocale } from '../src/locale.js'

const cases = [
  ['zh-Hant-HK', '設定', 'zh-TW'],
  ['ja-JP', '設定', 'ja-JP'],
  ['ko-KR', '설정', 'ko-KR'],
  ['es-MX', 'Ajustes', 'es-ES'],
  ['fr-CA', 'Paramètres', 'fr-FR'],
  ['de-AT', 'Einstellungen', 'de-DE'],
]

for (const [tag, settings, dates] of cases) {
  test(`desktop locale follows ${tag}`, () => {
    const dispose = installLocale(createLocale(tag))
    try {
      assert.equal(t('Settings'), settings)
      assert.equal(dateLocale(), dates)
      assert.notEqual(hostText('Request failed'), 'Request failed')
    } finally {
      dispose()
    }
  })
}

test('an unsupported desktop locale stays in English', () => {
  const dispose = installLocale(createLocale('pt-BR'))
  try {
    assert.equal(t('Settings'), 'Settings')
    assert.equal(dateLocale(), 'en-US')
    assert.equal(hostText('Request failed'), 'Request failed')
  } finally {
    dispose()
  }
})
