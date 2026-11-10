import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_ROOTS = [join(ROOT, 'src', 'client'), join(ROOT, '..', 'app', 'ui', 'src')]
const HANDLERS = [join(ROOT, 'src', 'host', 'channel.js'), join(ROOT, 'src', 'host', 'computer', 'index.js')]
const JS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx'])

async function filesUnder(path) {
  const rows = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) rows.push(...await filesUnder(child))
    else if (entry.isFile() && JS.has(extname(entry.name))) rows.push(child)
  }
  return rows
}

function firstArgument(source, opening) {
  let quote
  let escaped = false
  let lineComment = false
  let blockComment = false
  const stack = []
  for (let index = opening + 1; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1 }; continue }
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '(' || char === '[' || char === '{') { stack.push(char); continue }
    if (char === ')' || char === ']' || char === '}') {
      if (char === ')' && stack.length === 0) return source.slice(opening + 1, index).trim()
      stack.pop()
      continue
    }
    if (char === ',' && stack.length === 0) return source.slice(opening + 1, index).trim()
  }
  throw new Error('Unclosed API call')
}

function stringLiterals(expression) {
  const values = []
  const pattern = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/gu
  for (const match of expression.matchAll(pattern)) {
    try { values.push(JSON.parse(`"${match[2].replace(/"/g, '\\"')}"`)) }
    catch { values.push(match[2]) }
  }
  return values
}

function wrapperBefore(source, index, argument) {
  const head = source.slice(0, index)
  const candidates = []
  for (const pattern of [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/gu,
    /\b([A-Za-z_$][\w$]*)\s*:\s*\(([^)]*)\)\s*=>/gu,
  ]) {
    for (const match of head.matchAll(pattern)) {
      const parameters = String(match[2] ?? match[3] ?? '').split(',').map(value => value.trim())
      if (parameters.includes(argument)) candidates.push({ name: match[1], index: match.index })
    }
  }
  return candidates.sort((left, right) => right.index - left.index)[0]?.name
}

function callOperations(path, source, allSources) {
  const operations = new Set()
  const unresolved = []
  const pattern = /(?<![\w$.])(?:call|post)\s*\(/gu
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(source.lastIndexOf('\n', match.index - 1) + 1, match.index)
    if (line.includes('//')) continue
    const before = source.slice(Math.max(0, match.index - 24), match.index)
    if (/function\s*$/u.test(before)) continue
    const opening = match.index + match[0].lastIndexOf('(')
    const argument = firstArgument(source, opening)
    const literals = stringLiterals(argument)
    if (literals.length > 0 && (/^\s*['"]/u.test(argument) || argument.includes('?'))) {
      for (const value of literals) operations.add(value)
      continue
    }
    if (/^[A-Za-z_$][\w$]*$/u.test(argument)) {
      const wrapper = wrapperBefore(source, match.index, argument)
      if (wrapper !== undefined) {
        const wrapperPattern = new RegExp(`\\b${wrapper}\\s*\\(\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\\\r\\n])*)\\1`, 'gu')
        for (const body of allSources.values()) {
          for (const call of body.matchAll(wrapperPattern)) operations.add(call[2])
        }
        continue
      }
    }
    unresolved.push(`${relative(ROOT, path)}:${source.slice(0, match.index).split('\n').length}: ${argument}`)
  }
  return { operations, unresolved }
}

export async function apiContract() {
  const clientFiles = (await Promise.all(CLIENT_ROOTS.map(filesUnder))).flat()
  const sources = new Map(await Promise.all(clientFiles.map(async path => [path, await readFile(path, 'utf8')])))
  const client = new Set()
  const unresolved = []
  for (const [path, source] of sources) {
    const found = callOperations(path, source, sources)
    for (const operation of found.operations) client.add(operation)
    unresolved.push(...found.unresolved)
  }

  const channel = await readFile(HANDLERS[0], 'utf8')
  const computer = await readFile(HANDLERS[1], 'utf8')
  const handled = new Set([...channel.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/gu)].map(match => match[1]))
  for (const match of computer.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/gu)) handled.add(`computer-${match[1]}`)
  const missing = [...client].filter(operation => !handled.has(operation)).sort()
  const unused = [...handled].filter(operation => !client.has(operation)).sort()
  return { client: [...client].sort(), handled: [...handled].sort(), missing, unused, unresolved }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await apiContract()
  console.log(JSON.stringify({
    clientOperations: result.client.length,
    handledOperations: result.handled.length,
    missing: result.missing,
    unresolved: result.unresolved,
    unused: result.unused,
  }, null, 2))
  if (result.missing.length > 0 || result.unresolved.length > 0) process.exitCode = 1
}
