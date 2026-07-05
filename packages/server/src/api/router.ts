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
import { createMemoryRoutes } from './routes/memory.js'
import { SyncSessionManager } from '../sync/session-manager.js'
import { logger } from '../lib/logger.js'
import { createVarsRoutes } from './routes/vars.js'

export interface RouteDeps {
  fs: IFileSystem
  git: IGit
  proc: IProcess
  home: string
}

export interface SyncRouteDeps extends RouteDeps {
  sync: SyncSessionManager
}

type RegisterRouteDeps = RouteDeps & { sync?: SyncSessionManager }

export function registerRoutes(routeDeps?: RegisterRouteDeps): Hono {
  const syncLogger = logger.child('sync-session')
  const baseDeps: RegisterRouteDeps =
    routeDeps ??
    (() => {
      const { fs, git, proc } = createNodePlatform()
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return { fs, git, proc, home }
    })()
  const sync =
    baseDeps.sync ??
    new SyncSessionManager({
      home: baseDeps.home,
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
  const deps: SyncRouteDeps = { ...baseDeps, sync }

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
  app.route('/', createMemoryRoutes(deps))
  app.route('/', createVarsRoutes(deps))
  return app
}
