import { Hono } from 'hono'
import { join, dirname, basename as pathBasename, isAbsolute } from 'node:path'
import { glob } from 'tinyglobby'
import { parseSourceMemberSkillId, sourceIdentity } from '@loom/core'
import { z } from 'zod'
import { loadProjectionManifest, projectRepository } from '../../projection/workflow.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

// Resolve a local skill path that may be relative (e.g. "./assets/skills/x")
// against the repo root, so SKILL.md reads/writes land in the right place
// regardless of the server's current working directory.
const resolveSkillDir = (localPath: string, repoPath: string) =>
  isAbsolute(localPath) ? localPath : join(repoPath, localPath)

const apiLogger = logger.child('api')
const NonEmptyString = z.string().min(1)
const ProjectBody = z
  .object({
    repo: NonEmptyString,
    scope: z.enum(['skills', 'mcp', 'memory', 'all']).optional(),
  })
  .passthrough()
const RepoQuery = z.object({ repo: NonEmptyString })
const SkillContentQuery = RepoQuery.extend({
  skillId: NonEmptyString,
  sourceUrl: z.string().optional().default(''),
  localPath: z.string().optional().default(''),
})
const SkillContentBody = z.object({
  repo: NonEmptyString,
  skillId: NonEmptyString,
  sourceUrl: z.string().optional(),
  localPath: z.string().optional(),
  content: z.string(),
})

export function createProjectionRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/project', jsonValidator(ProjectBody, { error: projectError }), async (c) => {
    const body = c.req.valid('json')
    const repo = body.repo
    let repoPath: string
    try {
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      apiLogger.error('invalid repository path for projection', { err: e, repo })
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    apiLogger.info('projection started', { repoPath })
    const scope = (body.scope ?? 'all') as 'skills' | 'mcp' | 'memory' | 'all'
    const res = await projectRepository(deps, repoPath, { ...body, scope })
    if (res.ok) {
      apiLogger.info('projection completed', { repoPath })
    } else {
      apiLogger.error('projection failed', {
        repoPath,
        step: res.failure.failedStep,
        err: res.failure.originalError,
      })
    }
    return c.json(res)
  })

  app.get('/manifest', queryValidator(RepoQuery, { error: 'invalid_repo' }), async (c) => {
    const { repo } = c.req.valid('query')
    let repoPath: string
    try {
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      apiLogger.error('invalid repository path for manifest', { err: e, repo })
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    const manifest = await loadProjectionManifest(deps, repoPath)
    return c.json(manifest)
  })

  app.get(
    '/skill/content',
    queryValidator(SkillContentQuery, { error: skillContentQueryError }),
    async (c) => {
      try {
        const { repo, skillId, sourceUrl, localPath } = c.req.valid('query')
        let repoPath: string
        try {
          repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        } catch (e) {
          apiLogger.error('invalid repository path for skill read', { err: e, repo })
          return c.json(
            { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
            400,
          )
        }
        let skillDir: string | null = null
        if (sourceUrl) {
          const identity = sourceIdentity(sourceUrl)
          const repoId = identity.repoId
          const memberName = parseSourceMemberSkillId(skillId, identity)
          const cacheDir = join(repoPath, 'remote-cache', repoId)
          if (await deps.fs.exists(cacheDir)) {
            const requested = sourceSkillDirFromPath(cacheDir, localPath)
            if (requested) {
              skillDir = requested
            } else {
              const matches = await glob('**/SKILL.md', {
                cwd: cacheDir,
                ignore: ['**/.git/**', '**/node_modules/**'],
                onlyFiles: true,
              })
              const found = matches.find((m) => pathBasename(dirname(m)) === memberName)
              if (found) skillDir = join(cacheDir, dirname(found))
            }
          }
        } else if (localPath) {
          skillDir = resolveSkillDir(localPath, repoPath)
        } else {
          // Try ~/.agents/skills/<skillId> first, then fall back to repo assets
          // Repo assets/skills is the canonical home for local skills;
          // ~/.agents/skills is a legacy fallback.
          const assetsDir = join(repoPath, 'assets', 'skills', skillId)
          if (await deps.fs.exists(assetsDir)) {
            skillDir = assetsDir
          } else {
            const agentsDir = join(deps.home, '.agents', 'skills', skillId)
            if (await deps.fs.exists(agentsDir)) skillDir = agentsDir
          }
        }
        if (skillDir) {
          const skillFile = join(skillDir, 'SKILL.md')
          try {
            const content = await deps.fs.readFile(skillFile)
            return c.json({ ok: true, content, path: skillFile })
          } catch (e) {
            apiLogger.error('failed to read skill content file', { err: e, path: skillFile })
          }
        }
        return c.json({
          ok: false,
          error: 'not_found',
          message: `SKILL.md not found for ${skillId}`,
        })
      } catch (e) {
        apiLogger.error('failed to read skill content', { err: e })
        return c.json({
          ok: false,
          error: 'read_failed',
          message: String((e as Error)?.message ?? e),
        })
      }
    },
  )

  app.put(
    '/skill/content',
    jsonValidator(SkillContentBody, { error: skillContentBodyError }),
    async (c) => {
      try {
        const { repo, skillId, sourceUrl, localPath, content } = c.req.valid('json')
        let repoPath: string
        try {
          repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        } catch (e) {
          apiLogger.error('invalid repository path for skill write', { err: e, repo })
          return c.json(
            { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
            400,
          )
        }
        if (sourceUrl)
          return c.json({ ok: false, error: 'read_only', message: 'source skills are read-only' })

        let skillDir: string | null = null
        if (localPath) {
          skillDir = resolveSkillDir(localPath, repoPath)
        } else {
          // Try ~/.agents/skills/<skillId> first, then fall back to repo assets
          // Repo assets/skills is the canonical home for local skills;
          // ~/.agents/skills is a legacy fallback.
          const assetsDir = join(repoPath, 'assets', 'skills', skillId)
          if (await deps.fs.exists(assetsDir)) {
            skillDir = assetsDir
          } else {
            const agentsDir = join(deps.home, '.agents', 'skills', skillId)
            if (await deps.fs.exists(agentsDir)) skillDir = agentsDir
          }
        }
        if (!skillDir) return c.json({ ok: false, error: 'invalid_path' })

        const skillFile = join(skillDir, 'SKILL.md')
        await deps.fs.writeFile(skillFile, content)
        return c.json({ ok: true, path: skillFile })
      } catch (e) {
        apiLogger.error('failed to save skill content', { err: e })
        return c.json({
          ok: false,
          error: 'write_failed',
          message: String((e as Error)?.message ?? e),
        })
      }
    },
  )

  return app
}

function projectError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'scope' ? 'invalid_scope' : 'invalid_repo'
}

function skillContentQueryError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'skillId') return 'invalid_skill_id'
  return 'invalid_repo'
}

function skillContentBodyError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'skillId') return 'invalid_skill_id'
  if (field === 'content') return 'invalid_content'
  return 'invalid_repo'
}

function sourceSkillDirFromPath(cacheDir: string, skillFilePath: string): string | null {
  if (!skillFilePath || isAbsolute(skillFilePath)) return null
  const normalized = skillFilePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..') || /^[A-Za-z]:\//.test(normalized)) {
    return null
  }
  if (normalized !== 'SKILL.md' && !normalized.endsWith('/SKILL.md')) return null
  const dir = dirname(normalized)
  return join(cacheDir, dir === '.' ? '' : dir)
}
