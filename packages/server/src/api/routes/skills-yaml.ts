import { Hono } from 'hono'
import { AgentIdSchema } from '@loom/core'
import { z } from 'zod'
import { SkillsApplication, SkillsApplicationError } from '../../skills/application.js'
import { logger } from '../../lib/logger.js'
import { resolveRepoPath } from '../repo.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { projectRepository } from '../../projection/workflow.js'

const skillsRouteLogger = logger.child('skills-route')
const RepoField = z.unknown().optional()
const NonEmptyString = z.string().min(1)

const LocalSkillBody = z.object({
  id: NonEmptyString,
  path: z.string().optional(),
  agents: z.array(AgentIdSchema).optional(),
})

const LocalSkillImportItem = z.object({
  name: NonEmptyString,
  path: NonEmptyString,
})

const LocalSkillWriteItem = z.object({
  name: NonEmptyString,
  files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
})

const ScanLocalSkillsBody = z.object({
  repo: RepoField,
  dir: NonEmptyString,
})

const AddLocalSkillBody = z.object({
  repo: RepoField,
  skill: LocalSkillBody,
})

const ImportLocalSkillsBody = z.object({
  repo: RepoField,
  skills: z.array(LocalSkillImportItem),
  mode: z.enum(['move', 'ref']).default('ref'),
})

const WriteLocalSkillsBody = z.object({
  repo: RepoField,
  skills: z.array(LocalSkillWriteItem),
})

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

const DeleteLocalSkillBody = z.object({
  repo: RepoField,
  id: NonEmptyString,
})

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
  const skills = new SkillsApplication(
    deps.fs,
    deps.git,
    deps.home,
    undefined,
    async (repoPath) => {
      const projected = await projectRepository(deps, repoPath, { scope: 'skills' })
      if (!projected.ok) throw projected.failure.originalError
    },
  )

  app.post(
    '/skills/local',
    jsonValidator(AddLocalSkillBody, { error: 'invalid_skill' }),
    async (c) => {
      try {
        const { repo, skill } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.addLocalSkill(repoPath, skill)
        return c.json({ ok: true, skill })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'write_failed', 'failed to add local skill'))
      }
    },
  )

  app.post(
    '/skills/local/scan',
    jsonValidator(ScanLocalSkillsBody, { error: 'invalid_dir' }),
    async (c) => {
      try {
        const { dir, repo } = c.req.valid('json')
        const repoPath = repo ? await resolveRequestRepo(deps, repo) : undefined
        return c.json({ ok: true, skills: await skills.scanLocalSkills({ dir, repoPath }) })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'scan_failed', 'failed to scan local skills'))
      }
    },
  )

  app.post(
    '/skills/local/import',
    jsonValidator(ImportLocalSkillsBody, { error: 'invalid_skills' }),
    async (c) => {
      try {
        const { repo, skills: localSkills, mode } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        const result = await skills.importLocalSkills(repoPath, { skills: localSkills, mode })
        return c.json({ ok: true, count: result.count })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'import_failed', 'failed to import local skills'))
      }
    },
  )

  app.post(
    '/skills/local/write',
    jsonValidator(WriteLocalSkillsBody, { error: 'invalid_skills' }),
    async (c) => {
      try {
        const { repo, skills: localSkills } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        const result = await skills.writeLocalSkills(repoPath, { skills: localSkills })
        return c.json({ ok: true, count: result.count })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'import_failed', 'failed to write local skills'))
      }
    },
  )

  app.post('/sources', jsonValidator(AddSourceBody, { error: sourceError }), async (c) => {
    try {
      const { repo, name, url, ref, type, members, resources } = c.req.valid('json')
      const repoPath = await resolveRequestRepo(deps, repo)
      const result = await skills.addSource(repoPath, {
        name,
        url,
        ref,
        type,
        members,
        resources,
      })
      return c.json({ ok: true, source: result.source })
    } catch (e) {
      if (isInvalidRepo(e)) return invalidRepo(c, e)
      if (e instanceof SkillsApplicationError)
        return c.json(errorBody(e, 'write_failed', 'failed to add source'), e.status)
      return c.json(errorBody(e, 'write_failed', 'failed to add source'))
    }
  })

  app.delete('/sources', jsonValidator(SourceUrlBody, { error: 'invalid_url' }), async (c) => {
    try {
      const { repo, url } = c.req.valid('json')
      const repoPath = await resolveRequestRepo(deps, repo)
      await skills.removeSource(repoPath, url)
      return c.json({ ok: true })
    } catch (e) {
      if (isInvalidRepo(e)) return invalidRepo(c, e)
      return c.json(errorBody(e, 'delete_failed', 'failed to remove source'))
    }
  })

  app.post(
    '/sources/reconcile',
    jsonValidator(ReconcileSourceBody, { error: updateSourceError }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        const repoPath = await resolveRequestRepo(deps, body.repo)
        const result = await skills.reconcileSource(repoPath, body)
        return c.json({ ok: true, ...result })
      } catch (e) {
        skillsRouteLogger.error('source reconciliation failed', { err: e, url: body.url })
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        if (e instanceof SkillsApplicationError)
          return c.json(errorBody(e, 'reconcile_failed', 'failed to reconcile source'), e.status)
        return c.json(errorBody(e, 'reconcile_failed', 'failed to reconcile source'))
      }
    },
  )

  app.delete(
    '/skills/local',
    jsonValidator(DeleteLocalSkillBody, { error: 'invalid_id' }),
    async (c) => {
      try {
        const { repo, id } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.removeLocalSkill(repoPath, id)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'delete_failed', 'failed to remove local skill'))
      }
    },
  )

  app.post(
    '/skills/agents',
    jsonValidator(SetSkillAgentsBody, { error: skillAgentsError }),
    async (c) => {
      try {
        const { repo, sourceUrl, memberEntry, agents } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setSkillAgents(repoPath, { sourceUrl, memberEntry, agents })
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update skill agents'))
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
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setSourceMemberAgents(repoPath, sourceUrl, updates)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update source member agents'))
      }
    },
  )

  app.post(
    '/skills/local/agents',
    jsonValidator(SetLocalSkillAgentsBody, { error: localSkillAgentsError }),
    async (c) => {
      try {
        const { repo, id, agents } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setLocalSkillAgents(repoPath, id, agents)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update local skill agents'))
      }
    },
  )

  app.put(
    '/skills/order',
    jsonValidator(ReorderSkillGroupsBody, { error: 'invalid_order' }),
    async (c) => {
      try {
        const { repo, ids } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        return c.json({ ok: true, ...(await skills.reorderGroups(repoPath, ids)) })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        if (e instanceof SkillsApplicationError)
          return c.json(errorBody(e, 'reorder_failed', 'failed to reorder skill groups'), e.status)
        return c.json(errorBody(e, 'reorder_failed', 'failed to reorder skill groups'), 500)
      }
    },
  )

  return app
}

async function resolveRequestRepo(deps: RouteDeps, repo: unknown): Promise<string> {
  try {
    return await resolveRepoPath(deps.fs, repo as string, deps.home)
  } catch (cause) {
    throw Object.assign(new Error(String((cause as Error).message), { cause }), {
      code: 'invalid_repo',
    })
  }
}

function isInvalidRepo(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid_repo'
  )
}

function invalidRepo(
  c: { json: (body: unknown, status?: 400) => Response },
  error: unknown,
): Response {
  return c.json(
    { ok: false, error: 'invalid_repo', message: String((error as Error).message) },
    400,
  )
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

function errorBody(
  error: unknown,
  fallbackCode: string,
  logMessage: string,
): { ok: false; error: string; message: string } {
  if (error instanceof SkillsApplicationError) {
    return { ok: false, error: error.code, message: error.message }
  }
  skillsRouteLogger.error(logMessage, { err: error })
  return {
    ok: false,
    error: fallbackCode,
    message: String((error as Error)?.message ?? error),
  }
}
