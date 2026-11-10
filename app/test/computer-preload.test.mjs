import assert from 'node:assert/strict'
import test from 'node:test'
import { computerEntriesOf, cursorEventOf } from '../src/computer-preload.cjs'
import { sanitizeEntry } from '../src/computer-indicator.mjs'
import { cursorHtml } from '../src/computer-cursor.mjs'

test('computer rows keep the identity and app fields through preload and indicator sanitizers', () => {
  const avatar = 'data:image/png;base64,YQ=='
  const bridged = computerEntriesOf({
    rows: [{ botId: 'bot-1', label: 'Builder · Notes', name: 'Builder', app: 'Notes', color: '#8B5CF6', avatar }],
    labels: { stop: 'Stop', stopAll: 'Stop all', letGo: 'Continue' },
  })
  assert.deepEqual(sanitizeEntry(bridged.rows[0]), {
    botId: 'bot-1', label: 'Builder · Notes', name: 'Builder', app: 'Notes', color: '#8B5CF6', avatar,
  })
})

test('cursor paint and avatar survive the complete preload-to-overlay path', () => {
  const avatar = 'data:image/png;base64,YQ=='
  const event = cursorEventOf({ botId: 'bot-1', x: 20, y: 40, color: '#8B5CF6', avatar, ripple: true })
  assert.deepEqual(event, { botId: 'bot-1', x: 20, y: 40, mode: 'window', ripple: true, color: '#8B5CF6', avatar })
  const html = cursorHtml(event)
  assert.match(html, /#8B5CF6/u)
  assert.match(html, /data:image\/png;base64,YQ==/u)
  assert.match(html, /class="ring"/u)
})

test('a near-limit GIF avatar survives every computer overlay boundary', () => {
  const avatar = `data:image/gif;base64,${'A'.repeat(159_976)}`
  const row = computerEntriesOf({ rows: [{ botId: 'bot-1', label: 'Builder', avatar }] }).rows[0]
  assert.equal(sanitizeEntry(row).avatar, avatar)
  const event = cursorEventOf({ botId: 'bot-1', x: 20, y: 40, avatar })
  assert.equal(event.avatar, avatar)
  assert.match(cursorHtml(event), /data:image\/gif;base64,/u)
})
