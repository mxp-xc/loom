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
import {
  ResourceLeaseCoordinator,
  resourceLeases,
} from '../concurrency/resource-lease-coordinator.js'
import { projectionResourceKeys } from '../concurrency/resource-keys.js'
import { SourceProjectionCatalog } from '../projection/source-catalog.js'
import { deriveRepoId, loadRepoManifest } from '@loom/core'
import { authorizeRepository, listRepos } from './repo.js'
import { readSkillsProjectionFiles } from './repo-config.js'
import { runAuthorizedRepositoryLease } from './repository-lease.js'
import {
  SourceCacheHealthCatalog,
  inspectSourceCacheHealth,
  warmSourceProjectionCatalog,
} from '../remote/source-cache-health.js'

export interface RouteDeps {
  fs: IFileSystem
  git: IGit
  proc: IProcess
  home: string
  leases?: ResourceLeaseCoordinator
  sourceProjectionCatalog?: SourceProjectionCatalog
  sourceCacheHealthCatalog?: SourceCacheHealthCatalog
}

type RegisterRouteDeps = RouteDeps & {
  sync?: SyncSessionManager
  mcpDebug?: McpDebugSessionManagerLike
  externalOpener?: IExternalOpener
}

export type SyncRouteDeps = RouteDeps & { sync: SyncSessionManager }

export type RouteApp = Hono & { dispose(): Promise<void> }

export function registerRoutes(routeDeps?: RegisterRouteDeps): RouteApp {
  const syncLogger = logger.child('sync-session')
  const platformDeps: RegisterRouteDeps =
    routeDeps ??
    (() => {
      const { fs, git, proc, externalOpener } = createNodePlatform()
      const home = process.env.HOME || process.env.USERPROFILE || ''
      return { fs, git, proc, externalOpener, home }
    })()
  if (routeDeps?.sync && !routeDeps.leases) {
    throw new Error('Injected SyncSessionManager requires an explicit lease coordinator')
  }
  const leases = routeDeps
    ? resourceLeases(routeDeps, routeDeps.leases)
    : typeof platformDeps.fs.realPath === 'function'
      ? new ResourceLeaseCoordinator()
      : resourceLeases(platformDeps)
  if (routeDeps?.sync && !routeDeps.sync.usesLeaseCoordinator(leases)) {
    throw new Error('Injected SyncSessionManager must use the route lease coordinator')
  }
  const baseDeps = {
    ...platformDeps,
    leases,
    sourceProjectionCatalog: platformDeps.sourceProjectionCatalog ?? new SourceProjectionCatalog(),
    sourceCacheHealthCatalog:
      platformDeps.sourceCacheHealthCatalog ?? new SourceCacheHealthCatalog(),
  }
  const ownsSync = !baseDeps.sync
  const sync =
    baseDeps.sync ??
    new SyncSessionManager({
      home: baseDeps.home,
      leases,
      leaseKeys: (repoPath, home) => projectionResourceKeys(home, repoPath, home),
      onApplied: async (repoPath, home) => {
        const result = await projectRepository({ ...baseDeps, home }, repoPath, {})
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
  if (ownsSync) sync.startMaintenance()
  let mcpDebug = baseDeps.mcpDebug
  let ownedMcpDebug: ReturnType<typeof createDefaultMcpDebugManager> | null = null
  if (!mcpDebug) {
    const manager = createDefaultMcpDebugManager()
    manager.startMaintenance()
    mcpDebug = manager
    ownedMcpDebug = manager
  }
  const deps = { ...baseDeps, sync, mcpDebug }
  const sourceCacheWarmup = warmManagedSourceCaches(deps).catch((err: unknown) =>
    syncLogger.error('source cache startup validation failed', { err }),
  )

  let disposePromise: Promise<void> | null = null
  const app = Object.assign(new Hono(), {
    dispose: () => {
      if (!disposePromise) {
        const syncDisposal = ownsSync ? sync.dispose() : Promise.resolve()
        const mcpDisposal = ownedMcpDebug?.dispose() ?? Promise.resolve()
        disposePromise = Promise.all([recovery, sourceCacheWarmup, syncDisposal, mcpDisposal]).then(
          () => undefined,
        )
      }
      return disposePromise
    },
  })
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

async function warmManagedSourceCaches(
  deps: RouteDeps & {
    leases: ResourceLeaseCoordinator
    sourceProjectionCatalog: SourceProjectionCatalog
    sourceCacheHealthCatalog: SourceCacheHealthCatalog
  },
): Promise<void> {
  const cacheLogger = logger.child('source-cache-startup')
  const repositories = await listRepos(deps.fs, deps.home)
  await Promise.all(
    repositories.map(async (repo) => {
      try {
        const authorization = await authorizeRepository(deps.fs, repo, deps.home)
        const snapshot = await runAuthorizedRepositoryLease(
          deps,
          authorization,
          'read',
          (repoPath) => [repoPath],
          async (repoPath) => {
            const repoManifest = loadRepoManifest(
              await readSkillsProjectionFiles(deps.fs, repoPath),
            )
            if (repoManifest.loadDiagnostics?.length) {
              throw new Error('Repository skills projection manifest is invalid')
            }
            return {
              repoPath,
              sources: (repoManifest.skills.sources ?? []).map((source) => ({
                source,
                healthRevision: deps.sourceCacheHealthCatalog.revision(repoPath, source.url),
                projectionRevision: deps.sourceProjectionCatalog.revision(repoPath, source.url),
              })),
            }
          },
        )
        await Promise.all(
          snapshot.sources.map(async ({ source, healthRevision, projectionRevision }) => {
            const sourceId = deriveRepoId(source.url)
            try {
              if (
                !deps.sourceCacheHealthCatalog.isCurrent(
                  snapshot.repoPath,
                  source.url,
                  healthRevision,
                ) ||
                !deps.sourceProjectionCatalog.isCurrent(
                  snapshot.repoPath,
                  source.url,
                  projectionRevision,
                )
              ) {
                return
              }
              const health = await deps.sourceCacheHealthCatalog.getOrCheck(
                snapshot.repoPath,
                source,
                () => inspectSourceCacheHealth(deps.fs, deps.git, snapshot.repoPath, source),
                healthRevision,
              )
              if (
                !deps.sourceCacheHealthCatalog.isCurrent(
                  snapshot.repoPath,
                  source.url,
                  healthRevision,
                ) ||
                !deps.sourceProjectionCatalog.isCurrent(
                  snapshot.repoPath,
                  source.url,
                  projectionRevision,
                )
              ) {
                return
              }
              if (!health.healthy) {
                cacheLogger.error('source cache startup validation found an unhealthy cache', {
                  err: health.err ?? new Error(`Source cache is ${health.reason}`),
                  repo,
                  sourceId,
                })
                return
              }
              await warmSourceProjectionCatalog(
                deps.fs,
                deps.git,
                deps.sourceProjectionCatalog,
                snapshot.repoPath,
                source,
                projectionRevision,
              )
            } catch (err) {
              cacheLogger.error('source cache startup validation failed', {
                err,
                repo,
                sourceId,
              })
            }
          }),
        )
      } catch (err) {
        cacheLogger.error('repository source cache startup validation failed', { err, repo })
      }
    }),
  )
}
