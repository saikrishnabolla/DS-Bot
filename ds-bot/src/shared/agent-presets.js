export const AGENT_PRESETS = [
  {
    id: 'standard', name: 'Standard mode', group: 'built-in',
    description: 'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  },
  {
    id: 'ptc', name: 'PTC mode', group: 'built-in',
    description: 'Includes Standard mode capabilities, with tool calls composed in code for filtering, organizing, deduplicating, counting, and summarizing results.',
  },
  {
    id: 'minimal', name: 'Minimal mode', group: 'built-in',
    description: 'Uses a terminal, image input, and automatic context compaction for focused tasks.',
  },
  {
    id: 'creator', name: 'Creator mode', group: 'built-in',
    description: 'Customize Cue through conversation. Add capabilities, tools, prompts, and reusable workflows.',
  },
]

export const AGENT_PRESET_IDS = new Set(AGENT_PRESETS.map(row => row.id))

export function cleanAgentPreset(id) {
  const value = String(id ?? '')
  if (!AGENT_PRESET_IDS.has(value)) throw new Error(`Unknown Agent preset ${JSON.stringify(value)}`)
  return value
}
