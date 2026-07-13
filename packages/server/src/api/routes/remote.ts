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
import { prepareSourceUpdate } from '../../remote/update.js'
import { SourceUpdateSessionStore, persistedMembers } from '../../skills/update-sessions.js'
import { projectRepository } from '../../projection/workflow.js'

const remoteLogger = logger.child('remote')
const NonEmptyString = z.string().min(1)
const SourceType = z.enum(['branch', 'tag'])
const UpdateOldMember = SkillMemberOverrideSchema.extend({
  path: z.string().optional(),
  description: z.string().optional(),
}).passthrough()
const SkillSource = z
  .object({
    name: z.string().optional(),
    url: NonEmptyString,
    ref: NonEmptyString,
    type: SourceType.optional(),
    pinned_commit: z.string().optional(),
    scan: z.string().optional(),
    members: z.array(UpdateOldMember).optional(),
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
  oldMembers: z.array(UpdateOldMember).default([]),
})
const PrepareUpdateBody = PerformUpdateBody
const FinalizeUpdateBody = z.object({
  repo: NonEmptyString,
  sessionId: z.string().uuid(),
  preserve: z.array(NonEmptyString).default([]),
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
  const updateSessions = new SourceUpdateSessionStore(deps.fs)

  app.post('/install', jsonValidator(InstallBody, { error: remoteSourceError }), async (c) => {
    const { url, ref, repo, sourceId } = c.req.valid('json')
    const cacheId = deriveRepoId(url)
    let repoPath: string
    try {
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    remoteLogger.info('install skill', { url, ref, repoPath, sourceId, cacheId })
    try {
      const res = await installSkill(deps.git, deps.fs, url, ref, repoPath, cacheId)
      remoteLogger.info('install completed', { url, sourceId, cacheId, commit: res.pinned_commit })
      return c.json(res)
    } catch (e) {
      remoteLogger.error('install failed', { err: e, url, sourceId, cacheId })
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
    '/update/prepare',
    jsonValidator(PrepareUpdateBody, { error: performUpdateError }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        await updateSessions.prune()
        const repoPath = await resolveRepoPath(deps.fs, body.repo, deps.home)
        const prepared = await prepareSourceUpdate(
          deps.git,
          deps.fs,
          body.source,
          body.newRef,
          repoPath,
          deriveRepoId(body.source.url),
          (body.source.members ?? []).map((member) => ({
            name: member.name,
            path: member.path ?? `skills/${member.name}/SKILL.md`,
            targets: member.targets,
          })),
        )
        const session = await updateSessions.create({
          repoPath,
          source: body.source,
          newRef: body.newRef,
          prepared,
        })
        return c.json({
          ok: true,
          sessionId: session.id,
          pinned_commit: session.pinned_commit,
          changes: {
            added: session.changes.added,
            updated: session.changes.updated,
            removed: session.changes.removed,
          },
        })
      } catch (e) {
        remoteLogger.error('source update prepare failed', { err: e, source: body.source.url })
        return c.json({
          ok: false,
          error: 'update_prepare_failed',
          message: String((e as Error).message),
        })
      }
    },
  )

  app.post(
    '/update/finalize',
    jsonValidator(FinalizeUpdateBody, { error: 'invalid_update_session' }),
    async (c) => {
      const { repo, sessionId, preserve } = c.req.valid('json')
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        remoteLogger.error('source update finalize repo resolution failed', { err: e, repo })
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      const session = await updateSessions.get(sessionId, repoPath)
      if (!session)
        return c.json(
          { ok: false, error: 'invalid_update_session', message: '更新会话不存在或已过期' },
          404,
        )
      const removable = new Set(session.changes.removed.map(({ name }) => name))
      if (preserve.some((name) => !removable.has(name)))
        return c.json(
          { ok: false, error: 'invalid_preserve_members', message: '保留列表包含无效 skill' },
          400,
        )
      const copied: string[] = []
      let originalData: any
      let manifestWritten = false
      try {
        const filePath = join(session.repoPath, 'skills.yaml')
        const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
        data.sources ??= []
        data.skills ??= []
        originalData = structuredClone(data)
        const sourceIndex = data.sources.findIndex((item: any) => item.url === session.source.url)
        if (sourceIndex < 0) throw new Error(`Source not found: ${session.source.url}`)
        for (const name of preserve) {
          const dest = join(session.repoPath, 'assets', 'skills', name)
          if (data.skills.some((skill: any) => skill.id === name) || (await deps.fs.exists(dest))) {
            return c.json(
              {
                ok: false,
                error: 'local_skill_exists',
                message: `Local skill already exists: ${name}`,
              },
              409,
            )
          }
        }
        const nextSource = {
          ...data.sources[sourceIndex],
          ref: session.newRef,
          pinned_commit: session.pinned_commit,
          members: persistedMembers(session.source, session.newMembers),
        }
        data.sources[sourceIndex] = nextSource
        for (const name of preserve) {
          const dest = join(session.repoPath, 'assets', 'skills', name)
          await deps.fs.copyDir(join(session.stagingDir, name), dest)
          copied.push(dest)
          const removed = session.changes.removed.find((member) => member.name === name)
          data.skills.push({ id: name, ...(removed?.targets ? { targets: removed.targets } : {}) })
        }
        await writeYaml(deps.fs, filePath, data)
        manifestWritten = true
        const projected = await projectRepository(deps, session.repoPath, { scope: 'skills' })
        if (!projected.ok) throw projected.failure.originalError
        updateSessions.delete(sessionId)
        try {
          await deps.fs.removeDir(session.stagingDir)
          await deps.fs.removeFile(
            join(session.repoPath, 'temp', 'source-updates', `${sessionId}.json`),
          )
        } catch (cleanupError) {
          remoteLogger.warn('completed source update cleanup failed', {
            err: cleanupError,
            sessionId,
            stagingDir: session.stagingDir,
          })
        }
        return c.json({
          ok: true,
          pinned_commit: session.pinned_commit,
          changes: session.changes,
          preserved: preserve,
          deleted: session.changes.removed
            .map(({ name }) => name)
            .filter((name) => !preserve.includes(name)),
        })
      } catch (e) {
        remoteLogger.error('source update finalize failed', {
          err: e,
          sessionId,
          source: session.source.url,
        })
        for (const path of copied) {
          try {
            await deps.fs.removeDir(path)
          } catch (cleanupError) {
            remoteLogger.error('source update local rollback failed', {
              err: cleanupError,
              sessionId,
              path,
            })
          }
        }
        if (manifestWritten && originalData) {
          try {
            await writeYaml(deps.fs, join(session.repoPath, 'skills.yaml'), originalData)
            const rollbackProjection = await projectRepository(deps, session.repoPath, {
              scope: 'skills',
            })
            if (!rollbackProjection.ok) throw rollbackProjection.failure.originalError
          } catch (rollbackError) {
            remoteLogger.error('source update manifest rollback failed', {
              err: rollbackError,
              sessionId,
              source: session.source.url,
            })
          }
        }
        return c.json({
          ok: false,
          error: 'update_finalize_failed',
          message: String((e as Error).message),
        })
      }
    },
  )

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
        const sourceId = deriveRepoId(body.source.url)
        const res = await performUpdate(
          deps.git,
          deps.fs,
          body.source,
          body.newRef,
          repoPath,
          sourceId,
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
