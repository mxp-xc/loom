import { Hono } from 'hono'
import { join, dirname, basename as pathBasename, isAbsolute } from 'node:path'
import { glob } from 'tinyglobby'
import { parseSourceMemberSkillId, sourceIdentity } from '@loom/core'
import { loadProjectionManifest, projectRepository } from '../../projection/workflow.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'

// Resolve a local skill path that may be relative (e.g. "./assets/skills/x")
// against the repo root, so SKILL.md reads/writes land in the right place
// regardless of the server's current working directory.
const resolveSkillDir = (localPath: string, repoPath: string) =>
  isAbsolute(localPath) ? localPath : join(repoPath, localPath)

const apiLogger = logger.child('api')

export function createProjectionRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/project', async (c) => {
    const body = await c.req.json()
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

  app.get('/manifest', async (c) => {
    const repo = c.req.query('repo')!
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

  app.get('/skill/content', async (c) => {
    try {
      const repo = c.req.query('repo')!
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
      const skillId = c.req.query('skillId')!
      const sourceUrl = c.req.query('sourceUrl') ?? ''
      const localPath = c.req.query('localPath') ?? ''

      let skillDir: string | null = null
      if (sourceUrl) {
        const identity = sourceIdentity(sourceUrl)
        const repoId = identity.repoId
        const memberName = parseSourceMemberSkillId(skillId, identity)
        const cacheDir = join(repoPath, 'remote-cache', repoId)
        if (await deps.fs.exists(cacheDir)) {
          const matches = await glob('**/SKILL.md', {
            cwd: cacheDir,
            ignore: ['**/.git/**', '**/node_modules/**'],
            onlyFiles: true,
          })
          const found = matches.find((m) => pathBasename(dirname(m)) === memberName)
          if (found) skillDir = join(cacheDir, dirname(found))
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
      return c.json({ ok: false, error: 'not_found', message: `SKILL.md not found for ${skillId}` })
    } catch (e) {
      apiLogger.error('failed to read skill content', { err: e })
      return c.json({
        ok: false,
        error: 'read_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.put('/skill/content', async (c) => {
    try {
      const { repo, skillId, sourceUrl, localPath, content } = await c.req.json()
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
  })

  return app
}
