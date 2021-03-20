import fs from 'fs'
import path from 'path'
import { ViteDevServer } from '..'
import { cleanUrl, resolveFrom, unwrapId } from '../utils'
import { ssrRewriteStacktrace } from './ssrStacktrace'
import {
  ssrExportAllKey,
  ssrModuleExportsKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrDynamicImportKey
} from './ssrTransform'
import { transformRequest } from '../server/transformRequest'

interface SSRContext {
  global: NodeJS.Global
}

type SSRModule = Record<string, any>
const pendingModules = new Map<string, Promise<SSRModule>>()

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  url = unwrapId(url)

  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url)

  // Detect cycles and then return with exports object
  // before it is populated
  if (urlStack.includes(url)) return mod.ssrModule!

  const pending = pendingModules.get(url)
  if (pending) return pending
  const modulePromise = instantiateModule(url, server, context, urlStack)
  pendingModules.set(url, modulePromise)
  modulePromise.catch(() => {}).then(() => pendingModules.delete(url))
  return modulePromise
}

export async function instantiateModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url)

  if (mod.ssrModule && Object.isFrozen(mod.ssrModule)) {
    return mod.ssrModule
  }

  const ssrModule = {
    [Symbol.toStringTag]: 'Module'
  }
  Object.defineProperty(ssrModule, '__esModule', { value: true })

  mod.ssrModule = ssrModule

  const result =
    mod.ssrTransformResult ||
    (await transformRequest(url, server, { ssr: true }))
  if (!result) {
    // TODO more info? is this even necessary?
    throw new Error(`failed to load module for ssr: ${url}`)
  }

  const isExternal = (dep: string) => dep[0] !== '.' && dep[0] !== '/'

  // Load things sequentially depth-first to avoid having multiple
  // branches attempt to load the same module, which can lead to
  // havok and mayhem for circular modules
  for (let dep of result.deps!) {
    if (!isExternal(dep)) {
      await ssrLoadModule(dep, server, context, urlStack.concat(url))
    }
  }

  const ssrImportMeta = { url }

  const ssrImport = (dep: string) => {
    if (isExternal(dep)) {
      return nodeRequire(dep, mod.file, server.config.root)
    } else {
      return moduleGraph.urlToModuleMap.get(unwrapId(dep))?.ssrModule
    }
  }

  const ssrDynamicImport = (dep: string) => {
    if (isExternal(dep)) {
      return Promise.resolve(nodeRequire(dep, mod.file, server.config.root))
    } else {
      return ssrLoadModule(dep, server, context, urlStack.concat(url))
    }
  }

  function ssrExportAll(sourceModule: any) {
    for (const key in sourceModule) {
      if (key !== 'default') {
        Object.defineProperty(ssrModule, key, {
          enumerable: true,
          configurable: true,
          get() {
            return sourceModule[key]
          }
        })
      }
    }
  }

  try {
    new Function(
      `global`,
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      result.code + `\n//# sourceURL=${mod.url}`
    )(
      context.global,
      ssrModule,
      ssrImportMeta,
      ssrImport,
      ssrDynamicImport,
      ssrExportAll
    )
  } catch (e) {
    e.stack = ssrRewriteStacktrace(e.stack, moduleGraph)
    server.config.logger.error(
      `Error when evaluating SSR module ${url}:\n${e.stack}`,
      {
        timestamp: true,
        clear: server.config.clearScreen
      }
    )
    throw e
  }

  Object.freeze(ssrModule)
  return ssrModule
}

function nodeRequire(id: string, importer: string | null, root: string) {
  const mod = require(resolve(id, importer, root))
  const defaultExport = mod.__esModule ? mod.default : mod
  // rollup-style default import interop for cjs
  return new Proxy(mod, {
    get(mod, prop) {
      if (prop === 'default') return defaultExport
      return mod[prop]
    }
  })
}

const resolveCache = new Map<string, string>()

function resolve(id: string, importer: string | null, root: string) {
  const key = id + importer + root
  const cached = resolveCache.get(key)
  if (cached) {
    return cached
  }
  const resolveDir =
    importer && fs.existsSync(cleanUrl(importer))
      ? path.dirname(importer)
      : root
  const resolved = resolveFrom(id, resolveDir, true)
  resolveCache.set(key, resolved)
  return resolved
}
