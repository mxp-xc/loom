import { Hono } from 'hono'
import { AgentIdSchema, SkillMemberOverrideSchema } from '@loom/core'
import { z } from 'zod'
import { SkillsApplication, SkillsApplicationError } from '../../skills/application.js'
import { logger } from '../../lib/logger.js'
import { resolveRepoPath } from '../repo.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

const skillsRouteLogger = logger.child('skills-route')
const RepoField = z.unknown().optional()
const NonEmptyString = z.string().min(1)

const LocalSkillBody = z.object({
  id: NonEmptyString,
  path: z.string().optional(),
  targets: z.array(AgentIdSchema).optional(),
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

const AddSourceBody = z.object({
  repo: RepoField,
  url: NonEmptyString,
  ref: NonEmptyString,
  type: z.enum(['branch', 'tag']).optional(),
  scan: z.string().optional(),
})

const SourceUrlBody = z.object({
  repo: RepoField,
  url: NonEmptyString,
})

const SetSourceMembersBody = SourceUrlBody.extend({
  members: z.array(SkillMemberOverrideSchema).optional(),
})

const UpdateSourceBody = SourceUrlBody.extend({
  ref: z.string().optional(),
  type: z.enum(['branch', 'tag']).optional(),
  scan: z.string().optional(),
})

const DeleteLocalSkillBody = z.object({
  repo: RepoField,
  id: NonEmptyString,
})

const SetSkillTargetsBody = z.object({
  repo: RepoField,
  sourceUrl: NonEmptyString,
  memberName: NonEmptyString,
  targets: z.array(AgentIdSchema),
})

const SetSourceMemberTargetsBody = z.object({
  repo: RepoField,
  sourceUrl: NonEmptyString,
  updates: z.array(
    z.object({
      memberName: NonEmptyString,
      targets: z.array(AgentIdSchema),
    }),
  ),
})

const SetLocalSkillTargetsBody = DeleteLocalSkillBody.extend({
  targets: z.array(AgentIdSchema),
})

export function createSkillsYamlRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const skills = new SkillsApplication(deps.fs, deps.git, deps.home)

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
      const { repo, url, ref, type, scan } = c.req.valid('json')
      const repoPath = await resolveRequestRepo(deps, repo)
      const result = await skills.addSource(repoPath, { url, ref, type, scan })
      return c.json({ ok: true, source: result.source })
    } catch (e) {
      if (isInvalidRepo(e)) return invalidRepo(c, e)
      return c.json(errorBody(e, 'write_failed', 'failed to add source'))
    }
  })

  app.post(
    '/sources/members',
    jsonValidator(SetSourceMembersBody, { error: sourceMembersError }),
    async (c) => {
      try {
        const { repo, url, members } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setSourceMembers(repoPath, url, members)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'write_failed', 'failed to set source members'))
      }
    },
  )

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
    '/sources/update',
    jsonValidator(UpdateSourceBody, { error: 'invalid_url' }),
    async (c) => {
      try {
        const { repo, url, ref, type, scan } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.updateSourceMeta(repoPath, { url, ref, type, scan })
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update source metadata'))
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
    '/skills/targets',
    jsonValidator(SetSkillTargetsBody, { error: skillTargetsError }),
    async (c) => {
      try {
        const { repo, sourceUrl, memberName, targets } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setSkillTargets(repoPath, { sourceUrl, memberName, targets })
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update skill targets'))
      }
    },
  )

  app.post(
    '/skills/source-targets',
    jsonValidator(SetSourceMemberTargetsBody, {
      error: (issues) =>
        issues[0]?.path[0] === 'sourceUrl' ? 'invalid_source_url' : 'invalid_updates',
    }),
    async (c) => {
      try {
        const { repo, sourceUrl, updates } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setSourceMemberTargets(repoPath, sourceUrl, updates)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update source member targets'))
      }
    },
  )

  app.post(
    '/skills/local/targets',
    jsonValidator(SetLocalSkillTargetsBody, { error: localSkillTargetsError }),
    async (c) => {
      try {
        const { repo, id, targets } = c.req.valid('json')
        const repoPath = await resolveRequestRepo(deps, repo)
        await skills.setLocalSkillTargets(repoPath, id, targets)
        return c.json({ ok: true })
      } catch (e) {
        if (isInvalidRepo(e)) return invalidRepo(c, e)
        return c.json(errorBody(e, 'update_failed', 'failed to update local skill targets'))
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
  return issues[0]?.path[0] === 'ref' ? 'invalid_ref' : 'invalid_url'
}

function sourceMembersError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'members' ? 'invalid_members' : 'invalid_url'
}

function skillTargetsError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'sourceUrl') return 'invalid_source_url'
  if (field === 'memberName') return 'invalid_member_name'
  return 'invalid_targets'
}

function localSkillTargetsError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'id' ? 'invalid_id' : 'invalid_targets'
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
