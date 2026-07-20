import { Hono, type Context } from 'hono'
import { LocalSkillIdSchema, SkillMemberOverrideSchema } from '@loom/core'
import { z } from 'zod'
import { loadDisplayManifest, projectRepository } from '../../projection/workflow.js'
import {
  repositoryErrorResponse,
  repositoryResolutionErrorResponse,
} from '../repository-route-error.js'
import { logger } from '../../lib/logger.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { homeResourceKey, projectionResourceKeys } from '../../concurrency/resource-keys.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'
import {
  readSkillContent,
  SkillContentError,
  writeLocalSkillContent,
} from '../../skills/content.js'
import { withRepositoryLease } from '../repository-lease.js'

const apiLogger = logger.child('api')
const NonEmptyString = z.string().min(1)
const ProjectBody = z
  .object({
    repo: NonEmptyString,
    scope: z.enum(['skills', 'mcp', 'memory', 'all']).optional(),
  })
  .strict()
const RepoQuery = z.object({ repo: NonEmptyString })
const SkillContentQuery = z.discriminatedUnion('kind', [
  z
    .object({
      repo: NonEmptyString,
      kind: z.literal('local'),
      skillId: LocalSkillIdSchema,
    })
    .strict(),
  z
    .object({
      repo: NonEmptyString,
      kind: z.literal('source'),
      sourceUrl: NonEmptyString,
      memberEntry: SkillMemberOverrideSchema.shape.entry,
    })
    .strict(),
])
const SkillContentBody = z
  .object({
    repo: NonEmptyString,
    skillId: LocalSkillIdSchema,
    content: z.string(),
  })
  .strict()

export function createProjectionRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)
  app.post('/project', jsonValidator(ProjectBody, { error: projectError }), async (c) => {
    const body = c.req.valid('json')
    const repo = body.repo
    let home: string
    try {
      home = await homeResourceKey(deps.fs, deps.home)
    } catch (err) {
      return repositoryResolutionErrorResponse(
        c,
        err,
        apiLogger,
        'projection repository resolution failed',
        { repo },
      )
    }
    const scope = (body.scope ?? 'all') as 'skills' | 'mcp' | 'memory' | 'all'
    try {
      return await withRepositoryLease(
        { ...deps, home, leases },
        repo,
        'mutation',
        (repoPath) => projectionResourceKeys(home, repoPath, home, scope),
        async (repoPath) => {
          apiLogger.info('projection started', { repoPath })
          const result = await projectRepository({ ...deps, home }, repoPath, { scope })
          if (result.ok) {
            apiLogger.info('projection completed', { repoPath })
            if (result.warnings?.length) {
              apiLogger.warn('projection completed with unavailable sources', {
                repoPath,
                warnings: result.warnings,
              })
            }
          } else {
            apiLogger.error('projection failed', {
              repoPath,
              step: result.failure.failedStep,
              err: result.failure.originalError,
            })
          }
          return c.json(result)
        },
      )
    } catch (err) {
      const response = repositoryErrorResponse(
        c,
        err,
        apiLogger,
        'projection repository authorization failed',
        { repo },
      )
      if (response) return response
      apiLogger.error('projection request failed', { err, repo })
      throw err
    }
  })

  app.get('/manifest', queryValidator(RepoQuery, { error: 'invalid_repo' }), async (c) => {
    const { repo } = c.req.valid('query')
    let home: string
    try {
      home = await homeResourceKey(deps.fs, deps.home)
    } catch (err) {
      return repositoryResolutionErrorResponse(
        c,
        err,
        apiLogger,
        'manifest repository resolution failed',
        { repo },
      )
    }
    try {
      return await withRepositoryLease(
        { ...deps, home, leases },
        repo,
        'read',
        (repoPath) => [repoPath, home],
        async (repoPath) => c.json(await loadDisplayManifest({ ...deps, home }, repoPath)),
      )
    } catch (err) {
      const response = repositoryErrorResponse(
        c,
        err,
        apiLogger,
        'manifest repository authorization failed',
        { repo },
      )
      if (response) return response
      apiLogger.error('manifest load failed', { err, repo })
      throw err
    }
  })

  app.get(
    '/skill/content',
    queryValidator(SkillContentQuery, { error: skillContentQueryError }),
    async (c) => {
      const identity = c.req.valid('query')
      const { repo } = identity
      try {
        const result = await withRepositoryLease(
          { ...deps, leases },
          repo,
          'read',
          (repoPath) => [repoPath],
          (repoPath) =>
            readSkillContent(
              deps.fs,
              deps.git,
              repoPath,
              identity.kind === 'local'
                ? { kind: 'local', skillId: identity.skillId }
                : {
                    kind: 'source',
                    sourceUrl: identity.sourceUrl,
                    memberEntry: identity.memberEntry,
                  },
            ),
        )
        return c.json({ ok: true, ...result })
      } catch (err) {
        const response = repositoryErrorResponse(
          c,
          err,
          apiLogger,
          'skill read repository authorization failed',
          { repo },
        )
        if (response) return response
        apiLogger.error('failed to read skill content', { err, identity })
        return skillContentErrorResponse(c, err)
      }
    },
  )

  app.put(
    '/skill/content',
    jsonValidator(SkillContentBody, { error: skillContentBodyError }),
    async (c) => {
      const { repo, skillId, content } = c.req.valid('json')
      try {
        await withRepositoryLease(
          { ...deps, leases },
          repo,
          'mutation',
          (repoPath) => [repoPath],
          (repoPath) => writeLocalSkillContent(deps.fs, repoPath, skillId, content),
        )
        return c.json({ ok: true })
      } catch (err) {
        const response = repositoryErrorResponse(
          c,
          err,
          apiLogger,
          'skill write repository authorization failed',
          { repo, skillId },
        )
        if (response) return response
        apiLogger.error('failed to save skill content', { err, skillId })
        return skillContentErrorResponse(c, err)
      }
    },
  )

  return app
}

function projectError(issues: z.ZodIssue[]): string {
  if (issues[0]?.code === 'unrecognized_keys') return 'invalid_project_request'
  return issues[0]?.path[0] === 'scope' ? 'invalid_scope' : 'invalid_repo'
}

function skillContentQueryError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'skillId') return 'invalid_skill_id'
  if (field === 'memberEntry') return 'invalid_member_entry'
  if (field === 'sourceUrl') return 'invalid_source_url'
  if (field === 'kind') return 'invalid_skill_kind'
  if (issues[0]?.code === 'unrecognized_keys') return 'invalid_skill_identity'
  return 'invalid_repo'
}

function skillContentBodyError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'skillId') return 'invalid_skill_id'
  if (field === 'content') return 'invalid_content'
  if (issues[0]?.code === 'unrecognized_keys') return 'invalid_skill_identity'
  return 'invalid_repo'
}

function skillContentErrorResponse(c: Context, err: unknown) {
  if (err instanceof SkillContentError) {
    return c.json({ ok: false, error: err.code, message: err.message }, err.status)
  }
  return c.json(
    { ok: false, error: 'skill_content_failed', message: 'Skill content unavailable' },
    500,
  )
}
