import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry } from '@earendil-works/pi-durable'
import { createRuntime } from '../../index.js'
import { installOwnedApprovals } from './owned-approvals.js'
import { OwnedContext } from './owned-context.js'
import { installOwnedComputerUse } from './owned-computer.js'
import { migrateLegacyTeam } from './legacy-import.js'
import { prepareLegacyModels } from './legacy-model-import.js'
import { installOwnedDesktopTools } from './owned-desktop-tools.js'
import { OwnedModels } from './owned-models.js'
import { clearedModelProxyEnvironment, installProxyFromEnvironment } from './owned-proxy.js'
import { installOwnedSchedules } from './owned-schedules.js'
import { installOwnedStorage } from './owned-storage.js'
import { startOwnedServer } from '../server/owned-server.js'

const GUARDED_CODING_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'write', 'edit'])
function installCodingApprovals(context, runtime) {
  context.effect(() => context.on('tools/pre-execute', async function ownedCodingApproval(exec, next) {
    if (exec.ownedNative !== true || !GUARDED_CODING_TOOLS.has(exec.name)) return next()
    const presets = context.get('permissionPresets')
    const botId = runtime.selfOf(exec.agent?.id)
    const bot = runtime.botOf(botId)
    const group = runtime.groupOwners.get(exec.agent?.id)
    const room = group === undefined ? undefined : runtime.roomOf(group.roomId)
    const preset = room?.permission ?? bot?.permission ?? presets?.get(exec.agent?.session) ?? presets?.catalog().defaultPreset
    if (preset === 'read-only') return { kind: 'deny', reason: 'This conversation has read-only permissions.' }
    if (preset === 'danger-full-access') return next()
    const approval = context.get('approval')
    if (approval === undefined || exec.agent?.session === undefined) {
      return { kind: 'deny', reason: 'This action needs your approval, but approval is not available.' }
    }
    const name = bot?.name ?? 'this Bot'
    const shell = exec.name === 'bash' || exec.name === 'pwsh' || exec.name === 'powershell'
    const reason = shell ? `Allow ${name} to run this shell command?` : `Allow ${name} to change this file?`
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      ...(exec.callId === undefined ? {} : { callId: exec.callId }),
      reason,
      displayReason: {
        en: reason,
        zh: shell ? `允许${name}运行这条 shell 命令吗？` : `允许${name}修改这个文件吗？`,
      },
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
    return outcome === 'allowed-once'
      ? next()
      : { kind: 'deny', reason: outcome === 'cancelled' ? 'The approval was cancelled.' : 'The user did not allow this action.' }
  }, { prepend: true }))
}

export class OwnedHost {
  #context
  #server
  #stopProxy
  #closing

  constructor(context, runtime, models, server, stopProxy) {
    this.#context = context
    this.runtime = runtime
    this.models = models
    this.#server = server
    this.#stopProxy = stopProxy
  }

  static async open({ dataDir, uiDir, workspacePath, host, port, settings, env, models: suppliedModels, registry = createRegistry(), computerUse, platform = process.platform, web } = {}) {
    if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a directory')
    if (typeof uiDir !== 'string' || uiDir === '') throw new TypeError('uiDir must be a directory')
    const stopProxy = await installProxyFromEnvironment(process.env, message => console.warn(`DS Bot proxy: ${message}`))
    let context
    let server
    try {
      await prepareLegacyModels({ dataDir, platform })
      const modelRuntime = suppliedModels ?? await ModelRuntime.create({
        authPath: join(dataDir, 'auth.json'),
        modelsPath: join(dataDir, 'models.json'),
        refreshOnCreate: true,
      })
      const models = await OwnedModels.open(modelRuntime, { configPath: join(dataDir, 'providers.json') })
      context = await OwnedContext.open({ dataDir, models: modelRuntime, registry, settings, env, workspacePath })
      await migrateLegacyTeam({ dataDir, harness: context.harness })
      installOwnedApprovals(context, { dataDir })
      await installOwnedStorage(context, { dataDir })
      installOwnedComputerUse(context, computerUse)
      await installOwnedSchedules(context)
      context.get('shellEnv').register({ resolve: clearedModelProxyEnvironment })
      const ownedWorkspace = context.workspaceRegistry.get('default').path
      const runtime = createRuntime(context, { dataDir, home: join(dataDir, 'bot'), workspace: ownedWorkspace })
      installModelBoundary(runtime, models)
      runtime.teamTools.push(...installOwnedDesktopTools(context, runtime, {
        platform,
        workspacePath: ownedWorkspace,
        models,
        web,
      }))
      installCodingApprovals(context, runtime)
      context.setDispatch(runtime.handle)
      context.installTools(runtime.teamTools, runtime)
      await runtime.load()
      if (runtime.computerEnabled?.()) {
        await runtime.computerEndpoint('provider-retry', {})
        runtime.syncScopedTools?.()
      }
      context.resume()
      const attachments = context.get('attachments')
      server = await startOwnedServer({
        dispatch: runtime.handle,
        upload: (input, signal) => {
          signal?.throwIfAborted()
          return attachments.saveFile(input)
        },
        attachment: reference => attachments.load(reference),
        subscribe: runtime.subscribeFeed,
        revision: () => runtime.state.revision,
        uiDir,
        ...(host === undefined ? {} : { host }),
        ...(port === undefined ? {} : { port }),
      })
      return new OwnedHost(context, runtime, models, server, stopProxy)
    } catch (error) {
      await server?.close().catch(() => undefined)
      await context?.close().catch(() => undefined)
      await stopProxy().catch(() => undefined)
      throw error
    }
  }

  get origin() { return this.#server.origin }
  get launchUrl() { return this.#server.launchUrl }
  get port() { return this.#server.port }

  close() {
    return this.#closing ??= (async () => {
      try {
        await this.#server.close()
      } finally {
        try { await this.#context.close() } finally { await this.#stopProxy() }
      }
    })()
  }
}

function installModelBoundary(runtime, models) {
  runtime.missingKeys = async providers => new Set(providers.filter(provider => !models.runtime.hasConfiguredAuth(provider)))
  runtime.providersView = () => models.providersView()
  runtime.setProviderKey = (...args) => models.setProviderKey(...args).finally(() => runtime.dropCatalog?.())
  runtime.clearProviderKey = (...args) => models.clearProviderKey(...args).finally(() => runtime.dropCatalog?.())
  runtime.addProvider = (...args) => models.addProvider(...args).finally(() => runtime.dropCatalog?.())
  runtime.discoverModels = (...args) => models.discoverModels(...args)
  runtime.removeProvider = (...args) => models.removeProvider(...args).finally(() => runtime.dropCatalog?.())
}
