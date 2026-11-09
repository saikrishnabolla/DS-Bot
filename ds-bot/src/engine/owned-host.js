import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry } from '@earendil-works/pi-durable'
import { createRuntime } from '../../index.js'
import { OwnedContext } from './owned-context.js'
import { OwnedModels } from './owned-models.js'
import { startOwnedServer } from '../server/owned-server.js'

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
