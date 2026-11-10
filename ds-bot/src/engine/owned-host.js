import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { createRuntime } from '../../index.js'
import { OwnedContext } from './owned-context.js'
import { OwnedModels } from './owned-models.js'
import { startOwnedServer } from '../server/owned-server.js'

const GUARDED_CODING_TOOLS = new Set(['bash', 'powershell', 'write', 'edit'])

function installCodingApprovals(context, runtime) {
  context.effect(() => context.on('tools/pre-execute', async function ownedCodingApproval(exec, next) {
    if (exec.ownedNative !== true || !GUARDED_CODING_TOOLS.has(exec.name)) return next()
    const approval = context.get('approval')
    if (approval === undefined || exec.agent?.session === undefined) {
      return { kind: 'deny', reason: 'This action needs your approval, but approval is not available.' }
    }
    const botId = runtime.selfOf(exec.agent.id)
    const name = runtime.botOf(botId)?.name ?? 'this Bot'
    const shell = exec.name === 'bash' || exec.name === 'powershell'
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
  #closing

  constructor(context, runtime, models, server) {
    this.#context = context
    this.runtime = runtime
    this.models = models
    this.#server = server
  }

  static async open({ dataDir, uiDir, workspacePath, host, port, settings, env, models: suppliedModels, registry = createRegistry() } = {}) {
    if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a directory')
    if (typeof uiDir !== 'string' || uiDir === '') throw new TypeError('uiDir must be a directory')
    const modelRuntime = suppliedModels ?? await ModelRuntime.create({
      authPath: join(dataDir, 'auth.json'),
      modelsPath: join(dataDir, 'models.json'),
      refreshOnCreate: true,
    })
    const models = await OwnedModels.open(modelRuntime, { configPath: join(dataDir, 'providers.json') })
    const context = await OwnedContext.open({ dataDir, models: modelRuntime, registry, settings, env, workspacePath })
    let server
    try {
      const runtime = createRuntime(context, { dataDir, home: join(dataDir, 'bot') })
      installModelBoundary(runtime, models)
      runtime.teamTools.push(...CodingTools.tools.map(tool => ({ ...tool, ownedNative: true })))
      installCodingApprovals(context, runtime)
      context.setDispatch(runtime.handle)
      context.installTools(runtime.teamTools, runtime)
      context.resume()
      server = await startOwnedServer({
        dispatch: runtime.handle,
        subscribe: runtime.subscribeFeed,
        revision: () => runtime.state.revision,
        uiDir,
        ...(host === undefined ? {} : { host }),
        ...(port === undefined ? {} : { port }),
      })
      return new OwnedHost(context, runtime, models, server)
    } catch (error) {
      await server?.close().catch(() => undefined)
      await context.close().catch(() => undefined)
      throw error
    }
  }

  get origin() { return this.#server.origin }
  get launchUrl() { return this.#server.launchUrl }
  get port() { return this.#server.port }

  close() {
    return this.#closing ??= (async () => {
      await this.#server.close()
      await this.#context.close()
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
