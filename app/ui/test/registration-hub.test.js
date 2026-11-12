import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHAPES } from '../../../ds-bot/src/client/characters.js'
import { allThemes } from '../../../ds-bot/src/client/themes.js'
import { installRegistrationHub } from '../src/registration-hub.js'

const theme = {
  label: 'Test',
  light: { bg: '#ffffff', sidebar: '#f0f0f0', bubble: '#eeeeee', card: '#fafafa', text: '#111111', user: '#222222', userText: '#ffffff', accent: '#3366ff' },
  dark: { bg: '#111111', sidebar: '#181818', bubble: '#282828', card: '#202020', text: '#f5f5f5', user: '#eeeeee', userText: '#111111', accent: '#6699ff' },
}
const shape = { label: 'Test', size: 20, body: paint => `<path fill="${paint}"/>`, eyes: { at: [[5, 8], [13, 8]] } }

test('window.dshBot registers themes and shapes and drains the pre-load queue', (t) => {
  let releaseTheme
  const target = { dshBotQueue: [hub => { releaseTheme = hub.registerTheme('queued-theme', theme) }] }
  const dispose = installRegistrationHub(target)
  const releaseShape = target.dshBot.registerShape('test-shape', shape)
  assert.equal(target.dshBot.themes().includes('queued-theme'), true)
  assert.equal(target.dshBot.shapes().includes('test-shape'), true)
  assert.equal(allThemes()['queued-theme'].label, 'Test')
  assert.equal(SHAPES['test-shape'].label, 'Test')
  releaseShape()
  releaseTheme()
  dispose()
  assert.equal(target.dshBot, undefined)
  assert.equal(target.dshBotQueue, undefined)
})
