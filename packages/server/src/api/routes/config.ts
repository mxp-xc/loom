import { Hono } from 'hono'
import { join } from 'node:path'
import { loadRepoManifest, mergeConfig, setConfigField } from '@loom/core'
import { readRepoFiles, readLocalConfig, readYaml, writeYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import type { RouteDeps } from '../router.js'

export function createConfigRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/config', async (c) => {
    const repo = c.req.query('repo')!
    let repoPath: string
    try {
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    const files = await readRepoFiles(deps.fs, repoPath)
    const repoManifest = loadRepoManifest(files)
    const localConfig = await readLocalConfig(deps.fs, deps.home)
    const effective = mergeConfig(repoManifest.repoConfig, localConfig as any)
    const profiles = Object.keys(repoManifest.varsFiles)
    return c.json({ effective, repo: repoManifest.repoConfig, local: localConfig, profiles })
  })

  app.put('/config', async (c) => {
    try {
      const { repo, level, field, value } = await c.req.json()
      let repoPath: string | undefined
      try {
        if (repo) repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
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
        if (!repoPath)
          return c.json(
            { ok: false, error: 'invalid_repo', message: 'repo required for level=repo' },
            400,
          )
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
