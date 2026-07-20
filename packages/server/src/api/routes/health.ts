import { Hono } from 'hono'
import { initLoom } from '../../platform/node/init.js'
import { readLocalConfig } from '../repo-config.js'
import type { RouteDeps } from '../router.js'
import { InvalidRepositoryError, assertRepositoryRoot, resolveRepoPath } from '../repo.js'
import { repositoryResolutionErrorResponse } from '../repository-route-error.js'
import { logger } from '../../lib/logger.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'
import { homeResourceKey } from '../../concurrency/resource-keys.js'

const healthLogger = logger.child('api.health')

export function createHealthRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/init', async (c) => {
    try {
      const canonicalHome = await homeResourceKey(deps.fs, deps.home)
      const scopedDeps = { ...deps, home: canonicalHome, leases }
      const active = await leases.runMutation([canonicalHome], async () => {
        await initLoom(canonicalHome, deps.fs, deps.git)
        return resolveActiveRepository(scopedDeps)
      })
      return c.json({ ok: true, active_repo: active.name, repoPath: active.path })
    } catch (err) {
      return repositoryResolutionErrorResponse(c, err, healthLogger, 'loom initialization failed')
    }
  })

  app.get('/status', async (c) => {
    try {
      const canonicalHome = await homeResourceKey(deps.fs, deps.home)
      const scopedDeps = { ...deps, home: canonicalHome, leases }
      const active = await leases.runRead([canonicalHome], async () =>
        resolveActiveRepository(scopedDeps),
      )
      return c.json({ active_repo: active.name, repoPath: active.path })
    } catch (err) {
      return repositoryResolutionErrorResponse(
        c,
        err,
        healthLogger,
        'loom status resolution failed',
      )
    }
  })

  return app
}

async function resolveActiveRepository(deps: RouteDeps): Promise<{ name: string; path: string }> {
  await assertRepositoryRoot(deps.fs, deps.home)
  const localConfig = await readLocalConfig(deps.fs, deps.home)
  const activeRepo = localConfig.active_repo ?? 'default'
  if (typeof activeRepo !== 'string') throw new InvalidRepositoryError()
  return {
    name: activeRepo,
    path: await resolveRepoPath(deps.fs, activeRepo, deps.home),
  }
}
