import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { test } from 'node:test'
import { createComputerCursor, cursorHtml, createPointChecker } from '../src/computer-cursor.mjs'
import { EventEmitter } from 'node:events'

function fakeWindow() {
  const win = new EventEmitter()
  win.options = null
  win.bounds = null
  win.url = null
  win.js = []
  win.closed = false
  win.shown = false
  win.alwaysOnTopLevel = null
  win.ignored = null
  win.protected = undefined
  win.loadURL = (url) => { win.url = url; return Promise.resolve() }
  win.setBounds = (b) => { win.bounds = b }
  win.showInactive = () => { win.shown = true }
  win.isVisible = () => win.shown
  win.setAlwaysOnTop = (on, level) => { win.alwaysOnTopLevel = level }
  win.setIgnoreMouseEvents = (on, opts) => { win.ignored = on }
  win.setContentProtection = (on) => { win.protected = on }
  win.setVisibleOnAllWorkspaces = () => {}
  win.close = () => { win.closed = true; win.emit('closed') }
  win.webContents = { executeJavaScript: async code => win.js.push(code) }
  return win
}
function fakeElectron() {
  const windows = []
  class BrowserWindow { constructor(options) { const win = fakeWindow(); win.options = options; windows.push(win); return win } }
  return { windows, BrowserWindow }
}
// A fake point-checker child that answers from a list.
function fakeSpawn(answers = ['y']) {
  return () => {
    const child = new EventEmitter()
    child.stdin = { write: (line) => { const a = answers.length > 1 ? answers.shift() : answers[0]; const id = line.split(' ')[0]; queueMicrotask(() => child.stdout.emit('data', `${id} ${a}\n`)) } }
    child.stdout = new EventEmitter()
    child.kill = () => { child.killed = true; child.emit('exit') }
    queueMicrotask(() => child.stdout.emit('data', 'r\n'))
    return child
  }
}
const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0 } }), dipToScreenPoint: point => point }
const update = (cursor, ev) => cursor.update({ botId: 'w1', x: 100, y: 200, mode: 'point', ripple: true, pid: 9, color: '#22c55e', ...ev })

test('the cursor window is transparent, click-through and floats above apps', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor)
  const win = windows[0]
  assert.equal(win.options.transparent, true)
  assert.equal(win.options.frame, false)
  assert.equal(win.options.focusable, false)
  assert.equal(win.options.skipTaskbar, true)
  assert.equal(win.alwaysOnTopLevel, 'screen-saver')
  assert.equal(win.ignored, true)
  assert.equal(win.protected, undefined)
  cursor.dispose()
})

test('the window sits so the arrow tip lands on the point', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor, { x: 100, y: 200 })
  assert.equal(windows[0].bounds.x, 100 - 7)
  assert.equal(windows[0].bounds.y, 200 - 3)
  cursor.dispose()
})

test('a covered point draws nothing and hides a live cursor', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(['n']), log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows.length, 0)
  // then visible once, then covered again → the window is destroyed
  const cursor2 = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(['y', 'n']), log: { warn: () => {} } })
  await update(cursor2)
  assert.equal(windows.length, 1)
  await update(cursor2, { pid: 5 })
  assert.equal(windows[0].closed, true)
  cursor2.dispose()
})

test('darwin draws unprotected; win32 hides the cursor from captures', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'win32', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows[0].protected, true)
  cursor.dispose()
})

test('linux has no on-screen cursor', async () => {
  const { BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'linux', log: { warn: () => {} } })
  await update(cursor)
  const checker = createPointChecker({ platform: 'linux' })
  assert.equal(await checker.check(10, 10, 1), false)
  cursor.dispose()
})

test('a slow checker answer means do not draw', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const slow = () => { const child = new EventEmitter(); child.stdin = { write: () => {} }; child.stdout = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.stdout.emit('data', 'r\n')); return child }
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: slow, log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows.length, 0)
  cursor.dispose()
})

test('the checker kills its helper on dispose', () => {
  let killed = false
  const spawn = () => { const child = new EventEmitter(); child.stdin = { write: () => {} }; child.stdout = new EventEmitter(); child.kill = () => { killed = true }; queueMicrotask(() => child.stdout.emit('data', 'r\n')); return child }
  const checker = createPointChecker({ platform: 'darwin', spawn, log: { warn: () => {} } })
  void checker.check(1, 2, 3)
  checker.dispose()
  assert.equal(killed, true)
})

test('the first point waits for a cold native helper before using the query timeout', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const delayed = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdin = { write: line => { const id = line.split(' ')[0]; queueMicrotask(() => child.stdout.emit('data', `${id} y\n`)) } }
    child.kill = () => {}
    setTimeout(() => child.stdout.emit('data', 'r\n'), 350)
    return child
  }
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'win32', spawn: delayed, log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows.length, 1)
  cursor.dispose()
})

test('late point answers cannot resolve a newer request', async () => {
  let checks = 0
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => {}
    child.stdin = { write: line => {
      const id = line.split(' ')[0]
      checks++
      if (checks === 1) setTimeout(() => child.stdout.emit('data', `${id} y\n`), 350)
      else setTimeout(() => child.stdout.emit('data', `${id} n\n`), 100)
    } }
    queueMicrotask(() => child.stdout.emit('data', 'r\n'))
    return child
  }
  const checker = createPointChecker({ platform: 'darwin', spawn, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, 9), false)
  assert.equal(await checker.check(10, 20, 9), false)
  checker.dispose()
})

test('win32 checks the physical point while the cursor remains in display-independent coordinates', async () => {
  let written
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => {}
    child.stdin = { write: line => { written = line; const id = line.split(' ')[0]; queueMicrotask(() => child.stdout.emit('data', `${id} y\n`)) } }
    queueMicrotask(() => child.stdout.emit('data', 'r\n'))
    return child
  }
  const checker = createPointChecker({ platform: 'win32', spawn, screen: { dipToScreenPoint: ({ x, y }) => ({ x: x * 2, y: y * 2 }) }, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, 9), true)
  assert.equal(written, '1 20 40 9 0\n')
  checker.dispose()
})

test('native window identity is sent to the visibility helper', async () => {
  let written
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => {}
    child.stdin = { write: line => { written = line; const id = line.split(' ')[0]; queueMicrotask(() => child.stdout.emit('data', `${id} y 42 7001\n`)) } }
    queueMicrotask(() => child.stdout.emit('data', 'r\n'))
    return child
  }
  const checker = createPointChecker({ platform: 'win32', spawn, screen, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, 42, 7001), true)
  assert.equal(written, '1 10 20 42 7001\n')
  checker.dispose()
})

test('window identity works without a pid and invalid window identity falls back to pid', async () => {
  const writes = []
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => {}
    child.stdin = { write: line => { writes.push(line); const id = line.split(' ')[0]; queueMicrotask(() => child.stdout.emit('data', `${id} y\n`)) } }
    queueMicrotask(() => child.stdout.emit('data', 'r\n'))
    return child
  }
  const checker = createPointChecker({ platform: 'win32', spawn, screen, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, undefined, 7001), true)
  assert.equal(await checker.check(30, 40, 42, 0), true)
  assert.equal(await checker.check(50, 60), false)
  assert.deepEqual(writes, ['1 10 20 0 7001\n', '2 30 40 42 0\n'])
  checker.dispose()
})

test('native point helpers warm on supported systems only', () => {
  let starts = 0
  const spawn = () => { starts++; const child = new EventEmitter(); child.stdin = { write: () => {} }; child.stdout = new EventEmitter(); child.kill = () => {}; return child }
  const mac = createPointChecker({ platform: 'darwin', spawn, startMs: 1, log: { warn: () => {} } })
  const windows = createPointChecker({ platform: 'win32', spawn, startMs: 1, log: { warn: () => {} } })
  const linux = createPointChecker({ platform: 'linux', spawn, log: { warn: () => {} } })
  assert.equal(starts, 2)
  mac.dispose(); windows.dispose(); linux.dispose()
})

test('a helper that misses startup is replaced for the next point', async () => {
  let starts = 0
  let firstKilled = false
  const spawn = () => {
    starts++
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => { if (starts === 1) firstKilled = true }
    child.stdin = { write: line => { const id = line.split(' ')[0]; queueMicrotask(() => child.stdout.emit('data', `${id} y\n`)) } }
    if (starts > 1) queueMicrotask(() => child.stdout.emit('data', 'r\n'))
    return child
  }
  const checker = createPointChecker({ platform: 'win32', spawn, startMs: 20, screen, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, 9), false)
  assert.equal(await checker.check(10, 20, 9), true)
  assert.equal(starts, 2)
  assert.equal(firstKilled, true)
  checker.dispose()
})

test('cursorHtml paints the arrow in the Bot color with the avatar and a ripple', () => {
  const page = cursorHtml({ color: '#22c55e', avatar: 'data:image/png;base64,aGk=', ripple: true })
  assert.match(page, /fill="#22c55e"/)
  assert.match(page, /class="ava"/)
  assert.match(page, /class="ring"/)
  const plain = cursorHtml({ color: 'red', ripple: false })
  assert.match(plain, /fill="#4d6bfe"/)
  assert.doesNotMatch(plain, /class="ring"/)
  assert.match(plain, /background:transparent/)
})

test('the Windows helper compares root HWND identity and fails closed on stale handles', { skip: process.platform !== 'win32', timeout: 20_000 }, async (t) => {
  const fixtureScript = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public class FixtureDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][FixtureDpi]::SetProcessDPIAware()
function WindowId([IntPtr]$hwnd) { return [uint64]($hwnd.ToInt64() -band 0xFFFFFFFFL) }
$form = New-Object System.Windows.Forms.Form
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(100, 100)
$form.Size = New-Object System.Drawing.Size(300, 200)
$form.TopMost = $true
$button = New-Object System.Windows.Forms.Button
$button.Location = New-Object System.Drawing.Point(30, 30)
$button.Size = New-Object System.Drawing.Size(120, 60)
$button.Text = 'target'
$form.Controls.Add($button)
$other = New-Object System.Windows.Forms.Form
$other.StartPosition = 'Manual'
$other.Location = New-Object System.Drawing.Point(500, 100)
$other.Size = New-Object System.Drawing.Size(200, 150)
$other.TopMost = $true
$form.Show()
$other.Show()
[System.Windows.Forms.Application]::DoEvents()
$point = $button.PointToScreen((New-Object System.Drawing.Point(10, 10)))
[Console]::Out.WriteLine($PID.ToString() + ' ' + (WindowId $form.Handle) + ' ' + (WindowId $button.Handle) + ' ' + $point.X + ' ' + $point.Y + ' ' + (WindowId $other.Handle))
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
$other.Close()
$form.Close()
`
  const fixture = spawnChild('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(fixtureScript, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const firstLine = await new Promise((resolve, reject) => {
    let buffer = ''
    const onData = chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      fixture.stdout.off('data', onData)
      resolve(buffer.slice(0, newline).trim())
    }
    fixture.stdout.on('data', onData)
    fixture.once('error', reject)
    fixture.once('exit', code => reject(new Error(`the HWND fixture exited before it was ready (${String(code)})`)))
  })
  const [pid, _formId, childId, x, y, otherId] = firstLine.split(/\s+/u).map(Number)
  assert.ok([pid, childId, x, y, otherId].every(Number.isSafeInteger), firstLine)
  const checker = createPointChecker({ platform: 'win32', screen, startMs: 10_000, checkMs: 3_000, log: { warn: () => {} } })
  t.after(() => {
    checker.dispose()
    try { fixture.kill() } catch {}
  })
  assert.equal(await checker.check(x, y, pid, childId), true, 'a child HWND resolves to the root window at the point')
  assert.equal(await checker.check(x, y, pid, otherId), false, 'another top-level HWND from the same process stays distinct')
  assert.equal(await checker.check(x, y, pid, 0x7ffffff0), false, 'a stale HWND never widens to the matching PID')
  assert.equal(await checker.check(x, y, pid, 0), true, 'PID fallback remains available only when no HWND was supplied')
})
