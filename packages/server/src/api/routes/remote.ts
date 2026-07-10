import { Hono } from 'hono'
import { join } from 'node:path'
import { z } from 'zod'
import { installSkill, isValidGitRepo } from '../../remote/install.js'
import { checkUpdates, performUpdate } from '../../remote/update.js'
import { scanSourceMembers } from '../../projection/scan.js'
import { SkillMemberOverrideSchema, deriveRepoId, pinSourceCommit } from '@loom/core'
import { readYaml, writeYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'

const remoteLogger = logger.child('remote')
const NonEmptyString = z.string().min(1)
const SourceType = z.enum(['branch', 'tag'])
const SourceMember = z
  .object({
    name: NonEmptyString,
    path: z.string(),
    relativePath: z.string().optional(),
    frontmatterName: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough()
const SkillSource = z
  .object({
    url: NonEmptyString,
    ref: NonEmptyString,
    type: SourceType.optional(),
    pinned_commit: z.string().optional(),
    scan: z.string().optional(),
    members: z.array(SkillMemberOverrideSchema).optional(),
  })
  .passthrough()
const InstallBody = z.object({
  url: NonEmptyString,
  ref: NonEmptyString,
  repo: NonEmptyString,
  sourceId: NonEmptyString,
})
const UpdateCheckBody = z.object({
  sources: z.array(SkillSource),
  repo: z.string().optional(),
})
const PerformUpdateBody = z.object({
  repo: NonEmptyString,
  source: SkillSource,
  newRef: NonEmptyString,
  sourceId: NonEmptyString,
  oldMembers: z.array(SourceMember).default([]),
})
const ScanSourceBody = z.object({
  url: NonEmptyString,
  ref: z.string().optional(),
  type: SourceType.optional(),
  scan: z.string().optional(),
})
const RefreshSourceBody = ScanSourceBody.extend({
  repo: NonEmptyString,
})
const SourceRefsBody = z.object({
  url: NonEmptyString,
})

export function createRemoteRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/install', jsonValidator(InstallBody, { error: remoteSourceError }), async (c) => {
    const { url, ref, repo, sourceId } = c.req.valid('json')
    let repoPath: string
    try {
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    remoteLogger.info('install skill', { url, ref, repoPath, sourceId })
    try {
      const res = await installSkill(deps.git, deps.fs, url, ref, repoPath, sourceId)
      remoteLogger.info('install completed', { url, sourceId, commit: res.pinned_commit })
      return c.json(res)
    } catch (e) {
      remoteLogger.error('install failed', { err: e, url, sourceId })
      return c.json({
        ok: false,
        error: 'install_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/update', jsonValidator(UpdateCheckBody, { error: updateCheckError }), async (c) => {
    const { sources, repo } = c.req.valid('json')
    remoteLogger.info('check updates', { count: sources?.length ?? 0 })
    let repoPath: string | undefined
    try {
      if (repo) repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    const updates = await checkUpdates(sources, deps.git)
    // Detect corrupt/missing local caches so the UI can surface an update
    // button to repair them (scan only globs files, it won't fix a broken .git).
    if (repoPath) {
      for (const u of updates) {
        const sourceId = deriveRepoId(u.source.url)
        const cacheDir = join(repoPath, 'remote-cache', sourceId)
        if (!(await isValidGitRepo(deps.fs, cacheDir))) {
          ;(u as any).hasUpdate = true
          ;(u as any).needsRepair = true
        }
      }
    }
    return c.json({ updates })
  })

  app.post(
    '/update/perform',
    jsonValidator(PerformUpdateBody, { error: performUpdateError }),
    async (c) => {
      const body = c.req.valid('json')
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, body.repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      remoteLogger.info('perform update', {
        source: body.source?.url,
        newRef: body.newRef,
        repoPath,
      })
      try {
        const res = await performUpdate(
          deps.git,
          deps.fs,
          body.source,
          body.newRef,
          repoPath,
          body.sourceId,
          body.oldMembers,
        )
        // Persist the new pinned_commit (and ref if it changed) back to skills.yaml
        try {
          const filePath = join(repoPath, 'skills.yaml')
          const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
          const result = pinSourceCommit(
            data,
            body.source?.url,
            res.pinned_commit,
            body.newRef || undefined,
          )
          if (result.changed) await writeYaml(deps.fs, filePath, result.data)
        } catch (err) {
          remoteLogger.warn('failed to persist pinned source commit', {
            err,
            source: body.source?.url,
          })
          /* best-effort: cache is updated even if yaml write fails */
        }
        remoteLogger.info('update completed', {
          source: body.source?.url,
          commit: res.pinned_commit,
        })
        return c.json(res)
      } catch (e) {
        remoteLogger.error('update failed', { err: e, source: body.source?.url })
        return c.json({
          ok: false,
          error: 'update_failed',
          message: String((e as Error)?.message ?? e),
        })
      }
    },
  )

  app.post(
    '/sources/scan',
    jsonValidator(ScanSourceBody, { error: scanSourceError }),
    async (c) => {
      try {
        const { url, ref, type, scan } = c.req.valid('json')
        const { discoverSkills } = await import('../../remote/discover.js')
        const members = await discoverSkills(deps.git, deps.fs, {
          url,
          ...(typeof ref === 'string' && ref.trim() ? { ref: ref.trim() } : {}),
          ...(type === 'branch' || type === 'tag' ? { type } : {}),
          ...(typeof scan === 'string' && scan.trim() ? { scan: scan.trim() } : {}),
        })
        return c.json({ members })
      } catch (e) {
        remoteLogger.error('source scan failed', { err: e })
        return c.json({
          ok: false,
          error: 'scan_failed',
          message: String((e as Error)?.message ?? e),
        })
      }
    },
  )

  // Force re-install a source's remote-cache and re-discover its members.
  // Used by the source row "scan" menu to refresh members after a pull or
  // when the cache is missing/stale.
  app.post(
    '/sources/refresh',
    jsonValidator(RefreshSourceBody, { error: refreshSourceError }),
    async (c) => {
      try {
        const { repo, url, ref, type, scan } = c.req.valid('json')
        let repoPath: string
        try {
          repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
        } catch (e) {
          remoteLogger.error('source refresh repo resolution failed', { err: e, repo })
          return c.json(
            { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
            400,
          )
        }
        const sourceId = deriveRepoId(url)
        // Pure-local scan: glob the existing cache for SKILL.md without hitting
        // the network. Only clones as a fallback when the cache directory doesn't
        // exist yet (e.g. user deleted it). Corrupt caches (.git missing) are
        // left as-is and repaired via the "update" button instead.
        const cacheDir = join(repoPath, 'remote-cache', sourceId)
        if (!(await deps.fs.exists(cacheDir))) {
          await installSkill(deps.git, deps.fs, url, ref ?? 'main', repoPath, sourceId)
        }
        const scanned = await scanSourceMembers(cacheDir, {
          url,
          ref: ref ?? 'main',
          ...(type === 'branch' || type === 'tag' ? { type } : {}),
          ...(typeof scan === 'string' && scan.trim() ? { scan: scan.trim() } : {}),
        })
        return c.json({
          ok: true,
          members: scanned.map((m) => ({ name: m.name, path: m.relativePath ?? 'SKILL.md' })),
        })
      } catch (e) {
        remoteLogger.error('source refresh failed', { err: e })
        return c.json({
          ok: false,
          error: 'refresh_failed',
          message: String((e as Error)?.message ?? e),
        })
      }
    },
  )

  app.post('/sources/refs', jsonValidator(SourceRefsBody, { error: 'invalid_url' }), async (c) => {
    try {
      const { url } = c.req.valid('json')
      const result = await deps.git.lsRemote(url)
      return c.json({
        ok: true,
        branches: result.branches,
        tags: Object.keys(result.tags).sort().reverse(),
      })
    } catch (e) {
      remoteLogger.error('source refs failed', { err: e })
      return c.json({
        ok: false,
        error: 'refs_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  return app
}

function remoteSourceError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'repo') return 'invalid_repo'
  if (field === 'ref') return 'invalid_ref'
  if (field === 'sourceId') return 'invalid_source_id'
  return 'invalid_url'
}

function updateCheckError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'sources' ? 'invalid_sources' : 'invalid_repo'
}

function performUpdateError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'repo') return 'invalid_repo'
  if (field === 'source') return 'invalid_source'
  if (field === 'newRef') return 'invalid_ref'
  if (field === 'sourceId') return 'invalid_source_id'
  return 'invalid_members'
}

function scanSourceError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'type' ? 'invalid_type' : 'invalid_url'
}

function refreshSourceError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'repo') return 'invalid_repo'
  if (field === 'type') return 'invalid_type'
  return 'invalid_url'
}
