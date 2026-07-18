import { Hono } from 'hono'
import { createNodePlatform } from '../platform/node/index.js'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { IProcess } from '../ports/process.js'
import { createHealthRoutes } from './routes/health.js'
import { createProjectionRoutes } from './routes/projection.js'
import { createSyncRoutes } from './routes/sync.js'
import { createRemoteRoutes } from './routes/remote.js'
import { createConfigRoutes } from './routes/config.js'
import { createSkillsYamlRoutes } from './routes/skills-yaml.js'
import { createMcpYamlRoutes } from './routes/mcp-yaml.js'
import { createMcpImportRoutes } from './routes/mcp-import.js'
import { createDefaultMcpDebugManager, createMcpDebugRoutes } from './routes/mcp-debug.js'
import { createMemoryRoutes } from './routes/memory.js'
import { SyncSessionManager } from '../sync/session-manager.js'
import { logger } from '../lib/logger.js'
import { createVarsRoutes } from './routes/vars.js'
import type { McpDebugSessionManagerLike } from './routes/mcp-debug.js'
import type { IExternalOpener } from '../ports/external-opener.js'
import { NodeExternalOpener } from '../platform/node/external-opener.js'
import { createOpenPathRoutes } from './routes/open-path.js'
import { projectRepository } from '../projection/workflow.js'

export interface RouteDeps {
  fs: IFileSystem
  git: IGit
  proc: IProcess
  home: string
}

type RegisterRouteDeps = RouteDeps & {
  sync?: SyncSessionManager
  mcpDebug?: McpDebugSessionManagerLike
  externalOpener?: IExternalOpener
}

export type SyncRouteDeps = RouteDeps & { sync: SyncSessionManager }

export function registerRoutes(routeDeps?: RegisterRouteDeps): Hono {
  const syncLogger = logger.child('sync-session')
  const baseDeps: RegisterRouteDeps =
    routeDeps ??
    (() => {
      const { fs, git, proc, externalOpener } = createNodePlatform()
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return { fs, git, proc, externalOpener, home }
    })()
  const sync =
    baseDeps.sync ??
    new SyncSessionManager({
      home: baseDeps.home,
      onApplied: async (repoPath) => {
        const result = await projectRepository(baseDeps, repoPath, {})
        if (!result.ok) throw result.failure.originalError
        if (result.warnings?.length) {
          syncLogger.warn('sync projection completed with unavailable sources', {
            repoPath,
            warnings: result.warnings,
          })
        }
      },
      logger: {
        error: (message, context) => syncLogger.error(message, context),
        warn: (message, context) => syncLogger.warn(message, context),
        info: (message, context) => syncLogger.info(message, context),
      },
    })
  const recovery = sync
    .recover()
    .catch((err: unknown) => syncLogger.error('sync recovery failed', { err }))
  sync.startMaintenance()
  let mcpDebug = baseDeps.mcpDebug
  if (!mcpDebug) {
    const manager = createDefaultMcpDebugManager()
    manager.startMaintenance()
    mcpDebug = manager
  }
  const deps = { ...baseDeps, sync, mcpDebug }

  const app = new Hono()
  app.use('*', async (_c, next) => {
    await recovery
    await next()
  })
  app.route('/', createHealthRoutes(deps))
  app.route('/', createProjectionRoutes(deps))
  app.route('/', createSyncRoutes(deps))
  app.route('/', createRemoteRoutes(deps))
  app.route('/', createConfigRoutes(deps))
  app.route('/', createSkillsYamlRoutes(deps))
  app.route('/', createMcpYamlRoutes(deps))
  app.route('/', createMcpImportRoutes(deps))
  app.route('/', createMcpDebugRoutes(deps))
  app.route('/', createMemoryRoutes(deps))
  app.route('/', createVarsRoutes(deps))
  app.route(
    '/',
    createOpenPathRoutes({
      fs: deps.fs,
      home: deps.home,
      externalOpener: deps.externalOpener ?? new NodeExternalOpener(),
    }),
  )
  return app
}
