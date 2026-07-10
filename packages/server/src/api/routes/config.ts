import { Hono } from 'hono'
import { join } from 'node:path'
import { loadRepoManifest, mergeConfig, setConfigField } from '@loom/core'
import { z } from 'zod'
import { readRepoFiles, readLocalConfig, readYaml, writeYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

const NonEmptyString = z.string().min(1)
const ConfigQuery = z.object({ repo: NonEmptyString })
const ConfigUpdateBody = z.object({
  repo: z.string().optional(),
  level: z.enum(['repo', 'local']),
  field: NonEmptyString,
  value: z.unknown(),
})

export function createConfigRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/config', queryValidator(ConfigQuery, { error: 'invalid_repo' }), async (c) => {
    const { repo } = c.req.valid('query')
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

  app.put('/config', jsonValidator(ConfigUpdateBody, { error: configUpdateError }), async (c) => {
    const { repo, level, field, value } = c.req.valid('json')
    try {
      let repoPath: string | undefined
      try {
        if (repo) repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
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

function configUpdateError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'level') return 'invalid_level'
  if (field === 'field') return 'invalid_field'
  return 'invalid_request'
}
