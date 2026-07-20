import { Hono, type Context } from 'hono'
import { AgentIdSchema, LocalSkillIdSchema, LocalSkillSchema } from '@loom/core'
import { z } from 'zod'
import { SkillsApplication, SkillsApplicationError } from '../../skills/application.js'
import { logger } from '../../lib/logger.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { projectRepository } from '../../projection/workflow.js'
import { LocalSkillBoundaryError } from '../../skills/local-paths.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import { RepoConfigError } from '../repo-config.js'
import { homeResourceKey, projectionResourceKeys } from '../../concurrency/resource-keys.js'
import { withRepositoryLease } from '../repository-lease.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'

const skillsRouteLogger = logger.child('skills-route')
const RepoField = z.unknown().optional()
const NonEmptyString = z.string().min(1)

const LocalSkillBody = LocalSkillSchema

const LocalSkillImportItem = z
  .object({
    name: LocalSkillIdSchema,
    path: NonEmptyString,
  })
  .strict()

const LocalSkillWriteItem = z
  .object({
    name: LocalSkillIdSchema,
    files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).default([]),
  })
  .strict()

const ScanLocalSkillsBody = z.object({
  repo: RepoField,
  dir: NonEmptyString,
})

const AddLocalSkillBody = z.object({ repo: RepoField, skill: LocalSkillBody }).strict()

const ImportLocalSkillsBody = z
  .object({
    repo: RepoField,
    skills: z.array(LocalSkillImportItem),
    mode: z.enum(['move', 'ref']).default('ref'),
  })
  .strict()

const WriteLocalSkillsBody = z
  .object({ repo: RepoField, skills: z.array(LocalSkillWriteItem) })
  .strict()

const SourceMemberBody = z.object({
  name: NonEmptyString,
  entry: NonEmptyString,
})

const SourceResourceRuleBody = z.object({
  path: NonEmptyString,
  kind: z.enum(['file', 'directory']),
})

const SourceResourcesBody = z.object({
  include: z.array(SourceResourceRuleBody),
  exclude: z.array(SourceResourceRuleBody),
})

const AddSourceBody = z
  .object({
    repo: RepoField,
    name: z.string().optional(),
    url: NonEmptyString,
    ref: NonEmptyString,
    type: z.enum(['branch', 'tag']).optional(),
    members: z.array(SourceMemberBody).default([]),
    resources: SourceResourcesBody.optional(),
  })
  .strict()

const SourceUrlBody = z.object({
  repo: RepoField,
  url: NonEmptyString,
})

const UpdateSourceBody = SourceUrlBody.extend({
  name: z.string().optional(),
  ref: z.string().optional(),
  type: z.enum(['branch', 'tag']).optional(),
}).strict()
const ReconcileSourceBody = UpdateSourceBody.extend({
  expected_commit: NonEmptyString.optional(),
  members: z.array(SourceMemberBody),
  resources: SourceResourcesBody.optional(),
  preserve: z.array(NonEmptyString).optional(),
})

const DeleteLocalSkillBody = z.object({ repo: RepoField, id: LocalSkillIdSchema }).strict()

const SetSkillAgentsBody = z.object({
  repo: RepoField,
  sourceUrl: NonEmptyString,
  memberEntry: NonEmptyString,
  agents: z.array(AgentIdSchema),
})

const SetSourceMemberAgentsBody = z.object({
  repo: RepoField,
  sourceUrl: NonEmptyString,
  updates: z.array(
    z.object({
      memberEntry: NonEmptyString,
      agents: z.array(AgentIdSchema),
    }),
  ),
})

const SetLocalSkillAgentsBody = DeleteLocalSkillBody.extend({
  agents: z.array(AgentIdSchema),
})

const ReorderSkillGroupsBody = z.object({
  repo: RepoField,
  ids: z.array(NonEmptyString),
})

export function createSkillsYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)
  const leaseDeps = { ...deps, leases }
  const skills = createSkillsApplication(deps)
  const runRepo = <T>(
    repo: unknown,
    mode: 'read' | 'mutation',
    operation: (repoPath: string) => Promise<T>,
  ) => withRepositoryLease(leaseDeps, repo as string, mode, (repoPath) => [repoPath], operation)

  app.post(
    '/skills/local',
    jsonValidator(AddLocalSkillBody, { error: 'invalid_skill' }),
    async (c) => {
      try {
        const { repo, skill } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) => skills.addLocalSkill(repoPath, skill))
        return c.json({ ok: true, skill })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'write_failed',
          message: 'Failed to add local skill',
          logMessage: 'local skill add failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/scan',
    jsonValidator(ScanLocalSkillsBody, { error: 'invalid_dir' }),
    async (c) => {
      try {
        const { dir, repo } = c.req.valid('json')
        const scanned = repo
          ? await runRepo(repo, 'read', (repoPath) => skills.scanLocalSkills({ dir, repoPath }))
          : await skills.scanLocalSkills({ dir })
        return c.json({ ok: true, skills: scanned })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'scan_failed',
          message: 'Failed to scan local skills',
          logMessage: 'local skill scan failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/import',
    jsonValidator(ImportLocalSkillsBody, { error: 'invalid_skills' }),
    async (c) => {
      try {
        const { repo, skills: localSkills, mode } = c.req.valid('json')
        const result = await runRepo(repo, 'mutation', (repoPath) =>
          skills.importLocalSkills(repoPath, { skills: localSkills, mode }),
        )
        return c.json({ ok: true, count: result.count })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'import_failed',
          message: 'Failed to import local skills',
          logMessage: 'local skill import failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/write',
    jsonValidator(WriteLocalSkillsBody, { error: 'invalid_skills' }),
    async (c) => {
      try {
        const { repo, skills: localSkills } = c.req.valid('json')
        const result = await runRepo(repo, 'mutation', (repoPath) =>
          skills.writeLocalSkills(repoPath, { skills: localSkills }),
        )
        return c.json({ ok: true, count: result.count })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'write_failed',
          message: 'Failed to write local skills',
          logMessage: 'local skill write failed',
        })
      }
    },
  )

  app.post('/sources', jsonValidator(AddSourceBody, { error: sourceError }), async (c) => {
    try {
      const { repo, name, url, ref, type, members, resources } = c.req.valid('json')
      const result = await runRepo(repo, 'mutation', (repoPath) =>
        skills.addSource(repoPath, { name, url, ref, type, members, resources }),
      )
      return c.json({ ok: true, source: result.source })
    } catch (e) {
      return skillsErrorResponse(c, e, {
        code: 'write_failed',
        message: 'Failed to add source',
        logMessage: 'source add failed',
      })
    }
  })

  app.delete('/sources', jsonValidator(SourceUrlBody, { error: 'invalid_url' }), async (c) => {
    try {
      const { repo, url } = c.req.valid('json')
      await runRepo(repo, 'mutation', (repoPath) => skills.removeSource(repoPath, url))
      return c.json({ ok: true })
    } catch (e) {
      return skillsErrorResponse(c, e, {
        code: 'delete_failed',
        message: 'Failed to remove source',
        logMessage: 'source removal failed',
      })
    }
  })

  app.post(
    '/sources/reconcile',
    jsonValidator(ReconcileSourceBody, { error: updateSourceError }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        const home = await homeResourceKey(deps.fs, deps.home)
        const scopedDeps = { ...deps, home, leases }
        const result = await withRepositoryLease(
          scopedDeps,
          body.repo as string,
          'mutation',
          (repoPath) => projectionResourceKeys(home, repoPath, home, 'skills'),
          (repoPath) => createSkillsApplication(scopedDeps).reconcileSource(repoPath, body),
        )
        return c.json({ ok: true, ...result })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'reconcile_failed',
          message: 'Failed to reconcile source',
          logMessage: 'source reconciliation failed',
          context: { url: body.url },
        })
      }
    },
  )

  app.delete(
    '/skills/local',
    jsonValidator(DeleteLocalSkillBody, { error: 'invalid_id' }),
    async (c) => {
      try {
        const { repo, id } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) => skills.removeLocalSkill(repoPath, id))
        return c.json({ ok: true })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'delete_failed',
          message: 'Failed to remove local skill',
          logMessage: 'local skill removal failed',
        })
      }
    },
  )

  app.post(
    '/skills/agents',
    jsonValidator(SetSkillAgentsBody, { error: skillAgentsError }),
    async (c) => {
      try {
        const { repo, sourceUrl, memberEntry, agents } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) =>
          skills.setSkillAgents(repoPath, { sourceUrl, memberEntry, agents }),
        )
        return c.json({ ok: true })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'update_failed',
          message: 'Failed to update skill agents',
          logMessage: 'skill agent update failed',
        })
      }
    },
  )

  app.post(
    '/skills/source-agents',
    jsonValidator(SetSourceMemberAgentsBody, {
      error: (issues) =>
        issues[0]?.path[0] === 'sourceUrl' ? 'invalid_source_url' : 'invalid_updates',
    }),
    async (c) => {
      try {
        const { repo, sourceUrl, updates } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) =>
          skills.setSourceMemberAgents(repoPath, sourceUrl, updates),
        )
        return c.json({ ok: true })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'update_failed',
          message: 'Failed to update source member agents',
          logMessage: 'source member agent update failed',
        })
      }
    },
  )

  app.post(
    '/skills/local/agents',
    jsonValidator(SetLocalSkillAgentsBody, { error: localSkillAgentsError }),
    async (c) => {
      try {
        const { repo, id, agents } = c.req.valid('json')
        await runRepo(repo, 'mutation', (repoPath) =>
          skills.setLocalSkillAgents(repoPath, id, agents),
        )
        return c.json({ ok: true })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'update_failed',
          message: 'Failed to update local skill agents',
          logMessage: 'local skill agent update failed',
        })
      }
    },
  )

  app.put(
    '/skills/order',
    jsonValidator(ReorderSkillGroupsBody, { error: 'invalid_order' }),
    async (c) => {
      try {
        const { repo, ids } = c.req.valid('json')
        const result = await runRepo(repo, 'mutation', (repoPath) =>
          skills.reorderGroups(repoPath, ids),
        )
        return c.json({ ok: true, ...result })
      } catch (e) {
        return skillsErrorResponse(c, e, {
          code: 'reorder_failed',
          message: 'Failed to reorder skill groups',
          logMessage: 'skill group reorder failed',
        })
      }
    },
  )

  return app
}

function createSkillsApplication(deps: RouteDeps): SkillsApplication {
  return new SkillsApplication(deps.fs, deps.git, deps.home, undefined, async (repoPath) => {
    const projected = await projectRepository(deps, repoPath, { scope: 'skills' })
    if (!projected.ok) throw projected.failure.originalError
  })
}

function skillsRepositoryFailure(
  c: Context,
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>,
): Response | null {
  return repositoryErrorResponse(c, error, skillsRouteLogger, logMessage, context)
}

function sourceError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'name') return 'invalid_source_name'
  if (field === 'ref') return 'invalid_ref'
  return 'invalid_url'
}

function updateSourceError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'name') return 'invalid_source_name'
  if (field === 'ref') return 'invalid_ref'
  return 'invalid_url'
}

function skillAgentsError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'sourceUrl') return 'invalid_source_url'
  if (field === 'memberEntry') return 'invalid_member_entry'
  return 'invalid_agents'
}

function localSkillAgentsError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'id' ? 'invalid_id' : 'invalid_agents'
}

type SkillsErrorStatus = 400 | 404 | 409 | 422 | 500

const SKILLS_ERROR_MESSAGES: Record<SkillsErrorStatus, string> = {
  400: 'Invalid skills request',
  404: 'Skill or source not found',
  409: 'Skills state conflict',
  422: 'Skills configuration is invalid',
  500: 'Skills operation failed',
}

function skillsErrorResponse(
  c: Context,
  error: unknown,
  options: {
    code: string
    message: string
    logMessage: string
    context?: Record<string, unknown>
  },
): Response {
  const context = options.context ?? {}
  const repoFailure = skillsRepositoryFailure(c, error, options.logMessage, context)
  if (repoFailure) return repoFailure

  skillsRouteLogger.error(options.logMessage, { err: error, ...context })
  if (error instanceof SkillsApplicationError || error instanceof LocalSkillBoundaryError) {
    return c.json(
      { ok: false, error: error.code, message: SKILLS_ERROR_MESSAGES[error.status] },
      error.status,
    )
  }
  if (error instanceof RepoConfigError) {
    return c.json(
      {
        ok: false,
        error: 'invalid_skills_manifest',
        message: SKILLS_ERROR_MESSAGES[422],
      },
      422,
    )
  }
  return c.json({ ok: false, error: options.code, message: options.message }, 500)
}
