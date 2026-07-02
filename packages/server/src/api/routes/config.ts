import { Hono } from 'hono'
import { join } from 'node:path'
import { loadRepoManifest, mergeConfig, setConfigField } from '@loom/core'
import { readRepoFiles, readLocalConfig, readYaml, writeYaml } from '../repo-config.js'
import type { RouteDeps } from '../router.js'

export function createConfigRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/config', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const files = await readRepoFiles(deps.fs, repoPath)
    const repoManifest = loadRepoManifest(files)
    const localConfig = await readLocalConfig(deps.fs, deps.home)
    const effective = mergeConfig(repoManifest.repoConfig, localConfig as any)
    return c.json({ effective, repo: repoManifest.repoConfig, local: localConfig })
  })

  app.put('/config', async (c) => {
    try {
      const { repoPath, level, field, value } = await c.req.json()
      if (level !== 'repo' && level !== 'local')
        return c.json({ ok: false, error: 'invalid_level' }, 400)
      if (!field || typeof field !== 'string')
        return c.json({ ok: false, error: 'invalid_field' }, 400)

      if (level === 'local') {
        const localPath = join(deps.home, '.loom', 'config.yaml')
        const data = (await readYaml(deps.fs, localPath)) ?? {}
        const result = setConfigField(data, field, value)
        if (result.changed) await writeYaml(deps.fs, localPath, result.data)
      } else {
        const repoConfigPath = join(repoPath, 'config.yaml')
        const data = (await readYaml(deps.fs, repoConfigPath)) ?? {}
        const result = setConfigField(data, field, value)
        if (result.changed) await writeYaml(deps.fs, repoConfigPath, result.data)
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'config_update_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  return app
}
