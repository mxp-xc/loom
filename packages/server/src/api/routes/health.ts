import { Hono } from 'hono'
import { join } from 'node:path'
import { initLoom } from '../../platform/node/init.js'
import { readLocalConfig } from '../repo-config.js'
import type { RouteDeps } from '../router.js'

export function createHealthRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/init', async (c) => {
    await initLoom(deps.home, deps.fs, deps.git)
    const localConfig = await readLocalConfig(deps.fs, deps.home)
    const activeRepo = (localConfig.active_repo as string) ?? 'default'
    return c.json({
      ok: true,
      active_repo: activeRepo,
      repoPath: join(deps.home, '.loom', 'repos', activeRepo),
    })
  })

  app.get('/status', async (c) => {
    const localConfig = await readLocalConfig(deps.fs, deps.home)
    const activeRepo = (localConfig.active_repo as string) ?? 'default'
    return c.json({
      active_repo: activeRepo,
      repoPath: join(deps.home, '.loom', 'repos', activeRepo),
    })
  })

  return app
}
