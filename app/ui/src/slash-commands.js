export const AGENT_SLASH_COMMANDS = [
  { id: 'file', group: 'add', label: 'File', description: 'Attach files', action: 'file' },
  { id: 'goal', group: 'add', label: 'Goal', description: 'Set or view the goal for a long-running task', action: 'draft', draft: '/goal ' },
  { id: 'plan', group: 'add', label: 'Plan', description: 'Enter or leave plan mode', action: 'run', line: '/plan' },
  { id: 'feedback', group: 'add', label: 'Feedback', description: 'Record feedback about this session', action: 'feedback' },
  { id: 'compact', group: 'commands', label: 'Compact', description: 'Compact older conversation history', action: 'run', line: '/compact' },
  { id: 'permission', group: 'commands', label: 'Permission', description: 'Switch the permission preset (sandbox mode + approval policy)', action: 'draft', draft: '/permission ' },
  { id: 'model', group: 'commands', label: 'Model', description: 'Switch the model', action: 'draft', draft: '/model ' },
  { id: 'export', group: 'commands', label: 'Export', description: 'Download this Session log as a ZIP archive', action: 'run', line: '/export' },
]

export function agentSlashCommands(text, enabled) {
  if (!enabled) return []
  const match = /^\/([^\s/]*)$/u.exec(text)
  if (match === null) return []
  const query = match[1].toLowerCase()
  return AGENT_SLASH_COMMANDS.filter(command => command.id.startsWith(query) || command.label.toLowerCase().includes(query))
}

export function isSlashCommand(text, enabled) {
  return enabled && /^\//u.test(String(text).trimStart())
}

export function downloadCommandResult(result, page = globalThis.document) {
  if (result?.download?.base64 === undefined || page === undefined) return false
  const bytes = Uint8Array.from(globalThis.atob(result.download.base64), value => value.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: result.download.type ?? 'application/octet-stream' }))
  const link = page.createElement('a')
  link.href = url
  link.download = result.download.name ?? 'cue-session.zip'
  link.click()
  URL.revokeObjectURL(url)
  return true
}
