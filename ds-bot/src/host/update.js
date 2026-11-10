// Standalone app metadata used by About. Installing updates belongs to the desktop app.
import { readFileSync } from 'node:fs'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
export const FETCH_TIMEOUT_MS = 8000
export const STARS_TTL_MS = 60 * 60_000

export const repoSlug = () =>
  /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(String(PKG.repository?.url ?? PKG.repository ?? ''))?.[1] ?? null

const repoUrl = () => {
  const repo = repoSlug()
  return repo ? `https://github.com/${repo}` : null
}

export const fetchJson = async (url, headers = {}) => {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

export function install(rt) {
  const repository = repoUrl()
  const view = () => ({
    name: 'Cue', current: PKG.version, latest: null, source: 'app',
    notesUrl: repository ? `${repository}/releases` : null, repoUrl: repository,
    enabled: false, checkedAt: 0, phase: 'idle', installed: null, error: null, available: false,
  })

  let stars = { count: null, at: 0 }
  let loadingStars = null
  async function repoStars() {
    const repo = repoSlug()
    if (repo === null) return null
    if (Date.now() - stars.at < STARS_TTL_MS) return stars.count
    loadingStars ??= fetchJson(`https://api.github.com/repos/${repo}`, { 'user-agent': `cue/${PKG.version}` })
      .then((info) => { if (Number.isInteger(info?.stargazers_count)) stars = { count: info.stargazers_count, at: Date.now() } })
      .catch(error => rt.warn('cue: star count failed: %s', error?.message ?? error))
      .finally(() => { loadingStars = null })
    await loadingStars
    return stars.count
  }

  Object.assign(rt, {
    updateCheck: async () => view(),
    updateStart: () => { throw new Error('Cue updates are managed by the desktop app') },
    updateView: view,
    repoStars,
  })
}
