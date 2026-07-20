import { Hono } from 'hono'
import { join } from 'node:path'
import { loadRepoManifest, mergeConfig, setConfigField } from '@loom/core'
import { z } from 'zod'
import { readRepoFiles, readLocalConfig, RepoConfigError, writeYaml } from '../repo-config.js'
import { InvalidRepositoryError, assertRepositoryRoot, authorizeRepository } from '../repo.js'
import {
  repositoryErrorResponse,
  repositoryResolutionErrorResponse,
} from '../repository-route-error.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { logger } from '../../lib/logger.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'
import { homeResourceKey } from '../../concurrency/resource-keys.js'
import { routeErrorResponse } from '../route-error.js'
import { withRepositoryLease } from '../repository-lease.js'

const configLogger = logger.child('api.config')
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
  const leases = resourceLeases(deps, deps.leases)

  app.get('/config', queryValidator(ConfigQuery, { error: 'invalid_repo' }), async (c) => {
    const { repo } = c.req.valid('query')
    let home: string
    try {
      home = await homeResourceKey(deps.fs, deps.home)
    } catch (e) {
      return repositoryResolutionErrorResponse(
        c,
        e,
        configLogger,
        'config repository resolution failed',
        { repo },
      )
    }
    try {
      return await withRepositoryLease(
        { ...deps, home, leases },
        repo,
        'read',
        (repoPath) => [repoPath, home],
        async (repoPath) => {
          const files = await readRepoFiles(deps.fs, repoPath)
          const repoManifest = loadRepoManifest(files)
          const invalidConfig = repoManifest.loadDiagnostics?.filter(
            (diagnostic) => diagnostic.file === 'config.yaml',
          )
          if (invalidConfig?.length) {
            throw new RepoConfigError(
              'config_container_invalid',
              'repository config must be an object',
              invalidConfig,
            )
          }
          const localConfig = await readLocalConfig(deps.fs, home)
          const effective = mergeConfig(repoManifest.repoConfig, localConfig as any)
          const profiles = Object.keys(repoManifest.varsFiles)
          return c.json({ effective, repo: repoManifest.repoConfig, local: localConfig, profiles })
        },
      )
    } catch (err) {
      const repositoryFailure = repositoryErrorResponse(
        c,
        err,
        configLogger,
        'config repository authorization failed',
        { repo },
      )
      if (repositoryFailure) return repositoryFailure
      return routeErrorResponse(
        c,
        err,
        configLogger,
        'config read failed',
        (error) =>
          error instanceof RepoConfigError && error.code === 'config_container_invalid'
            ? {
                status: 422,
                code: 'invalid_config',
                message: 'configuration is invalid',
                diagnostics: error.cause,
              }
            : null,
        { status: 500, code: 'config_read_failed', message: 'failed to read configuration' },
        { repo },
      )
    }
  })

  app.put('/config', jsonValidator(ConfigUpdateBody, { error: configUpdateError }), async (c) => {
    const { repo, level, field, value } = c.req.valid('json')
    try {
      const home = await homeResourceKey(deps.fs, deps.home)
      if (level === 'local') {
        await leases.runMutation([home], async () => {
          await assertRepositoryRoot(deps.fs, home)
          if (repo) await authorizeRepository(deps.fs, repo, home)
          if (field === 'active_repo') {
            if (typeof value !== 'string') throw new InvalidRepositoryError()
            await authorizeRepository(deps.fs, value, home)
          }
          const data = await readLocalConfig(deps.fs, home)
          const result = setConfigField(data, field, value)
          if (result.changed) {
            await writeYaml(deps.fs, join(home, '.loom', 'config.yaml'), result.data)
          }
        })
      } else {
        if (!repo)
          return c.json(
            { ok: false, error: 'invalid_repo', message: 'repo required for level=repo' },
            400,
          )
        await withRepositoryLease(
          { ...deps, home, leases },
          repo,
          'mutation',
          (repoPath) => [repoPath],
          async (repoPath) => {
            const repoConfigPath = join(repoPath, 'config.yaml')
            const manifest = loadRepoManifest(await readRepoFiles(deps.fs, repoPath))
            const invalidConfig = manifest.loadDiagnostics?.filter(
              (diagnostic) => diagnostic.file === 'config.yaml',
            )
            if (invalidConfig?.length) {
              throw new RepoConfigError(
                'config_container_invalid',
                'repository config must be an object',
                invalidConfig,
              )
            }
            const data = manifest.repoConfig
            const result = setConfigField(data, field, value)
            if (result.changed) await writeYaml(deps.fs, repoConfigPath, result.data)
          },
        )
      }
      return c.json({ ok: true })
    } catch (e) {
      const repositoryFailure = repositoryErrorResponse(
        c,
        e,
        configLogger,
        'config update repository authorization failed',
        { level, field },
      )
      if (repositoryFailure) return repositoryFailure
      configLogger.error('config update failed', { err: e, level, field })
      const invalid = e instanceof RepoConfigError && e.code === 'config_container_invalid'
      return c.json(
        {
          ok: false,
          error: invalid ? 'invalid_config' : 'config_update_failed',
          message: invalid ? e.message : 'configuration update failed',
        },
        invalid ? 422 : 500,
      )
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
