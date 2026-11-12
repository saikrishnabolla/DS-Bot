// Cue's standalone runtime. Every Bot owns a durable conversation; the roster, rooms,
// and Bot-to-Bot exchange log live in one JSON file under Cue's data directory.
import { join } from 'node:path'
import * as diagnostics from './src/host/diagnostics.js'
import * as store from './src/host/store.js'
import * as models from './src/host/models.js'
import * as permissions from './src/host/permissions.js'
import * as turns from './src/host/turns.js'
import * as steer from './src/host/steer.js'
import * as handoffs from './src/host/handoffs.js'
import * as requests from './src/host/requests.js'
import * as delivery from './src/host/delivery.js'
import * as roster from './src/host/roster.js'
import * as folders from './src/host/folders.js'
import * as privacy from './src/host/privacy.js'
import * as agents from './src/host/agents.js'
import * as prompt from './src/host/prompt.js'
import * as timeContext from './src/host/time-context.js'
import * as tools from './src/host/tools.js'
import * as chatIndex from './src/host/chat-index.js'
import * as groups from './src/host/groups.js'
import * as ledger from './src/host/ledger.js'
import * as goals from './src/host/goals.js'
import * as approvals from './src/host/approvals.js'
import * as resume from './src/host/resume.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as images from './src/host/images.js'
import * as avatarLibrary from './src/host/avatar-library.js'
import * as browser from './src/host/browser.js'
import * as browserPlugins from './src/host/browser-plugins.js'
import * as computer from './src/host/computer/index.js'
import * as secrets from './src/host/secrets.js'
import * as connectors from './src/host/connectors/index.js'
import * as capabilities from './src/host/capabilities.js'
import * as learning from './src/host/learning.js'
import * as schedules from './src/host/schedules.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as thinking from './src/host/thinking.js'
import * as channel from './src/host/channel.js'
import * as feed from './src/host/feed.js'
import * as im from './src/host/im/index.js'
import * as officeSkills from './src/host/office-skills.js'
import * as goalSkills from './src/host/goal-skills.js'
import * as localAgents from './src/host/local-agents/index.js'

export { COLORS } from './src/host/constants.js'

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them. privacy checks a
// call before the hooks of tools do, so a closed call never reaches a card they show.
const MODULES = [diagnostics, store, ledger, models, permissions, turns, steer, handoffs, requests, delivery, roster, folders, privacy, agents, prompt, timeContext, tools, chatIndex, groups, goals, approvals, resume, memory, parts, images, avatarLibrary, secrets, connectors, capabilities, learning, schedules, browser, browserPlugins, computer, usage, update, thinking, feed, im, channel, officeSkills, goalSkills, localAgents]

export function createRuntime(ctx, config = {}) {
  const dataDir = config.dataDir ?? (config.home === undefined ? folders.dataRootOf(process.env.CUE_HOME) : config.home)
  const home = config.home ?? join(dataDir, 'bot')
  const rt = {
    ctx,
    config,
    dataDir,
    home,
    statePath: join(home, 'state.json'),
    // The Bot-only tools each module defines; tools.js registers them in each
    // Bot Session's own scope, never globally (see shareBotTools).
    teamTools: [],
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  Object.assign(rt, typeof config.modelBoundary === 'function' ? config.modelBoundary(rt) : config.modelBoundary ?? {})
  for (const module of MODULES) module.install(rt)
  // A live Agent can be scoped before the last module has added its tools (the memory
  // module starts a load during install): complete the scope now that every tool is in.
  rt.syncScopedTools?.()
  // Durable work can survive a runtime restart while the in-memory maps start empty.
  // Adopt it now so Stop, the group view, and a late child result still see the work.
  void rt.adoptLiveWork?.().catch(error => rt.warn?.('ds-bot: adopting the work still running failed: %s', error))
  return rt
}
