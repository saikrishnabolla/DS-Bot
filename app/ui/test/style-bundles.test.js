import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const main = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8')
const appCss = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')
const materialCss = readFileSync(fileURLToPath(new URL('../../src/material.css', import.meta.url)), 'utf8')
const fontsCss = readFileSync(fileURLToPath(new URL('../../src/fonts.css', import.meta.url)), 'utf8')

const expected = [
  ['shell', ['SHELL_CSS']],
  ['sidebar', ['SIDEBAR_CSS']],
  ['secrets', ['SECRET_CSS', 'CONNECTOR_CSS', 'CONNECTORS_PAGE_CSS']],
  ['providers', ['PROVIDERS_CSS']],
  ['learning', ['LEARNING_CSS']],
  ['models', ['MODEL_CSS', 'FOLDER_CSS', 'BOT_SETTINGS_CSS', 'AGENT_CARDS_CSS', 'GROUP_SETTINGS_CSS', 'AVATAR_LIBRARY_CSS']],
  ['usage', ['USAGE_CSS']],
  ['schedules', ['SCHEDULE_CSS']],
  ['feedback', ['FEEDBACK_CSS']],
  ['about', ['ABOUT_CSS']],
  ['members', ['MEMBER_CSS']],
  ['im', ['IM_CSS']],
  ['goal', ['GOAL_CSS']],
  ['user-messages', ['USER_MESSAGE_CSS']],
  ['widgets', ['WIDGET_CSS']],
  ['handoff', ['HANDOFF_CSS']],
  ['side', ['SIDE_CSS']],
  ['browser', ['BROWSER_CSS']],
  ['conversation', ['CONVERSATION_CSS']],
  ['turn-errors', ['TURN_ERROR_CSS']],
  ['queue', ['QUEUE_CSS']],
  ['computer', ['COMPUTER_CSS']],
]

test('desktop installs every shared Bot view stylesheet once', () => {
  const installed = [...main.matchAll(/\['([^']+)', ([^\]]+)\]/gu)].map(([, tag, expression]) => [
    tag,
    [...expression.matchAll(/\b[A-Z][A-Z_]+_CSS\b/gu)].map(match => match[0]),
  ])
  assert.deepEqual(installed, expected)
  for (const [, names] of expected) {
    for (const name of names) assert.match(main, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`, 'u'))
  }
})

test('desktop frame preserves the original title-band and surface primitives', () => {
  assert.doesNotMatch(materialCss, /\.bt-panel\s*\{[^}]*border-top:/u)
  assert.match(appCss, /--cue-frame-overlay-top:calc\(var\(--dsb-band\) \+ 12px\)/u)
  assert.match(appCss, /text-autospace:normal/u)
  assert.match(appCss, /@supports \(corner-shape:superellipse\(1\.5\)\)\{\*,::before,::after\{corner-shape:superellipse\(1\.5\)\}\}/u)
  assert.match(appCss, /::-webkit-scrollbar\{width:5px;height:5px\}/u)
  assert.match(appCss, /\.dsb-scroll\{[^}]*padding:60px 11px 16px 0\}/u)
  assert.match(fontsCss, /--cue-ui-font-family:\s*var\(--cue-font-family-text-default\)/u)
})
