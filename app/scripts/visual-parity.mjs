import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [requestedRoot = '.', requestedOut = 'shots/visual-parity', requestedLabel] = process.argv.slice(2)
const root = resolve(requestedRoot)
const out = resolve(requestedOut)
const label = requestedLabel ?? basename(root)
const electron = createRequire(join(root, 'package.json'))('electron')
const runRoot = await mkdtemp(join(tmpdir(), `cue-visual-${label}-`))
const port = 9600 + (process.pid % 1000)
await mkdir(out, { recursive: true })

const { ELECTRON_RUN_AS_NODE: _runAsNode, ...baseEnv } = process.env
const child = spawn(electron, [root, `--remote-debugging-port=${String(port)}`], {
  stdio: 'inherit',
  env: {
    ...baseEnv,
    DS_BOT_HOME: join(runRoot, 'data'),
    DS_BOT_SHELL_DATA: join(runRoot, 'shell'),
    DS_BOT_WORKSPACE: join(runRoot, 'workspace'),
    DEEPSEEK_BASE_URL: baseEnv.DEEPSEEK_BASE_URL ?? 'http://127.0.0.1:8771/v1',
    DEEPSEEK_API_KEY: baseEnv.DEEPSEEK_API_KEY ?? 'mock-key',
  },
})
const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))

async function pageTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch {
      // Electron has not opened its debugging port yet.
    }
    await sleep(100)
  }
  throw new Error(`${label}: app page did not appear`)
}

function devtools(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = next++
    pending.set(id, { resolve: resolveCall, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => socket.close() }
}

async function closeBrowser() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    socket.close()
  } catch {
    child.kill()
  }
}

let cdp
try {
  const page = await pageTarget(Date.now() + 60_000)
  cdp = devtools(page.webSocketDebuggerUrl)
  await cdp.opened
  await cdp.call('Page.enable')

  const evaluate = async expression => {
    const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(`${label}: ${response.exceptionDetails.text}`)
    return response.result.value
  }
  const waitFor = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`${label}: timed out waiting for ${expression}`)
  }
  const click = async (selector, text) => evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(element => element.textContent.trim() === ${JSON.stringify(text)})
    if (!node) throw new Error(${JSON.stringify(`Missing ${text} in ${selector}`)})
    node.click()
    return true
  })()`)
  const hasText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .some(element => element.textContent.trim() === ${JSON.stringify(text)})`)
  const settle = async () => evaluate(`(() => {
    const node = document.querySelector('.bt-settings') ?? document.querySelector('.bt-panel')
    if (!node) return true
    const finite = node.getAnimations({ subtree: true }).filter(animation =>
      Number.isFinite(animation.effect?.getTiming().iterations ?? Infinity))
    return Promise.race([
      Promise.allSettled(finite.map(animation => animation.finished)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]).then(() => true)
  })()`)
  const capture = async name => {
    await settle()
    await sleep(50)
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(out, `${label}-${name}.png`), Buffer.from(data, 'base64'))
    const metrics = await evaluate(`JSON.stringify((() => {
      const selectors = [
        '.bt-settings-layer', '.bt-settings', '.bt-settings-nav', '.bt-settings-main',
        '.bt-settings-head', '.bt-settings-head h2', '.bt-settings-actions',
        '.bt-settings-scroll', '.bt-settings-page', '.bt-panel', '.bt-ptabs', '.bt-ptab', '.bt-panel-view',
        '.bt-drawer-top', '.bt-drawer-id', '.bt-tabs', '.bt-drawer-body', '.bt-bs',
        '.bt-runmode', '.bt-cli-list',
      ]
      const rect = node => {
        if (!node) return null
        const box = node.getBoundingClientRect()
        const css = getComputedStyle(node)
        return {
          box: [box.x, box.y, box.width, box.height],
          background: css.backgroundColor,
          border: css.borderColor,
          color: css.color,
          font: css.font,
          boxSizing: css.boxSizing,
          display: css.display,
          flex: css.flex,
          position: css.position,
          inset: css.inset,
          margin: css.margin,
          padding: css.padding,
          gap: css.gap,
          width: css.width,
          minWidth: css.minWidth,
          maxWidth: css.maxWidth,
          overflowY: css.overflowY,
          scrollbarWidth: css.scrollbarWidth,
          textAutospace: css.textAutospace,
          cornerShape: css.cornerShape,
          transform: css.transform,
          translate: css.translate,
        }
      }
      const root = getComputedStyle(document.documentElement)
      const panel = document.querySelector('.bt-panel')
      const computed = node => node ? Object.fromEntries([...getComputedStyle(node)].map(name => [name, getComputedStyle(node).getPropertyValue(name)])) : null
      return {
        elements: Object.fromEntries(selectors.map(selector => [selector, rect(document.querySelector(selector))])),
        panelChildren: panel ? [...panel.children].map(node => ({
          tag: node.tagName,
          className: node.className,
          rect: rect(node),
        })) : [],
        panelBefore: panel ? (() => {
          const css = getComputedStyle(panel, '::before')
          return { content: css.content, display: css.display, position: css.position, inset: css.inset, width: css.width, height: css.height }
        })() : null,
        panelComputed: computed(panel),
        panelGripComputed: computed(panel?.querySelector('.bt-panel-grip')),
        panelViewComputed: computed(panel?.querySelector('.bt-panel-view')),
        variables: Object.fromEntries(['--cue-frame-chrome-top', '--cue-frame-overlay-top', '--dsh-frame-chrome-top', '--dsh-frame-overlay-top', '--bt-main', '--bt-sidebar', '--bt-line', '--bt-line-2', '--bt-ink', '--bt-ink-2'].map(name => [name, root.getPropertyValue(name)])),
      }
    })())`)
    await writeFile(join(out, `${label}-${name}.json`), `${metrics}\n`)
  }

  await evaluate('window.resizeTo(1320, 860)')
  await waitFor("document.querySelector('.bt-account') && document.querySelector('[aria-label=\"View conversation details\"]')")
  await sleep(1200)
  await evaluate("document.querySelector('.bt-account').click()")
  await waitFor("document.querySelector('.bt-account-menu')")
  await click('.bt-account-menu button', 'Settings')
  await waitFor("document.querySelector('.bt-settings')")

  if (await hasText('.bt-settings-item', 'Built-in plugins')) {
    await click('.bt-settings-item', 'Built-in plugins')
    await waitFor("document.querySelector('.bt-settings-main input[type=search]')")
    await capture('built-in-plugins')
  }

  if (await hasText('.bt-settings-item', 'Agent presets')) {
    await click('.bt-settings-item', 'Agent presets')
    await capture('agent-presets')
  }

  await click('.bt-settings-item', 'Connectors')
  await waitFor("document.querySelector('.bt-apps')")
  await capture('connectors')

  await click('.bt-settings-item', 'IM')
  await waitFor("document.querySelector('.bt-im-page')")
  await capture('im')

  await evaluate("document.querySelector('.bt-settings-close').click()")
  await waitFor("!document.querySelector('.bt-settings')")
  await evaluate("document.querySelector('[aria-label=\"View conversation details\"]').click()")
  await waitFor("document.querySelector('.bt-panel')")
  await evaluate("document.querySelector('[aria-label=\"Edit Bot\"]').click()")
  await waitFor("document.querySelector('.bt-bs')")
  await click('.bt-bs button', 'Change')
  await waitFor("document.querySelector('.bt-runmode')")
  await click('.bt-runmode button', 'Local agent')
  await waitFor("document.querySelector('.bt-cli-list,.bt-cli-none') && !document.querySelector('.bt-cli-none')?.textContent.includes('Looking for')")
  await capture('runs-on')

  const inventory = await evaluate(`JSON.stringify({
    size: [innerWidth, innerHeight],
    sheets: [...document.querySelectorAll('style[data-cue]')].map(style => [style.dataset.cue, style.sheet?.cssRules.length ?? 0]),
    console: performance.getEntriesByType('resource').map(entry => entry.name),
  })`)
  await writeFile(join(out, `${label}-runtime.json`), `${inventory}\n`)
  console.log(`visual-parity: saved ${label} captures in ${out}`)
} finally {
  cdp?.close()
  await closeBrowser()
  await Promise.race([exited, sleep(10_000)])
  if (child.exitCode === null) child.kill()
  await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
