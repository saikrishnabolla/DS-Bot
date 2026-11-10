import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const MAX_ENTRIES = 500

const crumbsOf = path => {
  const crumbs = []
  for (let at = path; ; at = dirname(at)) {
    crumbs.unshift({ name: basename(at) || at, path: at })
    if (dirname(at) === at) return crumbs
  }
}

export function ownedDirectoryPicker() {
  return {
    capability: () => ({
      kind: 'browse',
      async list(candidate, signal) {
        signal?.throwIfAborted()
        const home = await realpath(homedir()).catch(() => resolve(homedir()))
        const path = await realpath(candidate === undefined ? home : resolve(candidate))
        const found = await readdir(path, { withFileTypes: true })
        const entries = []
        for (const entry of found) {
          signal?.throwIfAborted()
          if (entry.name.startsWith('.') || entry.name.startsWith('$') || entry.name === 'System Volume Information') continue
          let directory = entry.isDirectory()
          if (entry.isSymbolicLink()) directory = await stat(resolve(path, entry.name)).then(info => info.isDirectory(), () => false)
          if (directory) entries.push({ name: entry.name, path: resolve(path, entry.name) })
        }
        entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
        return { path, home, crumbs: crumbsOf(path), entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES }
      },
    }),
  }
}
