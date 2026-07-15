import { Hono } from 'hono'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { installSkill, isValidGitRepo } from '../../remote/install.js'
import { cacheDirFor } from '../../remote/cache.js'
import { checkUpdates } from '../../remote/update.js'
import { scanSourceTree } from '../../remote/source-tree.js'
import { SkillSourceSchema, deriveRepoId, summarizeSourceTree } from '@loom/core'
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
const SkillSource = SkillSourceSchema
const UpdateCheckBody = z.object({
  sources: z.array(SkillSource),
  repo: z.string().optional(),
})
const PrepareUpdateBody = z
  .object({
    repo: NonEmptyString,
    source: SkillSource,
    newRef: NonEmptyString,
  })
  .strict()
const FinalizeUpdateBody = z.object({
  repo: NonEmptyString,
  sessionId: z.string().uuid(),
  preserve: z.array(NonEmptyString).default([]),
  resourceBoundaryDecisions: z
    .array(
      z.object({
        entry: NonEmptyString,
        action: z.enum(['enable', 'exclude']),
      }),
    )
    .default([]),
})
const ScanSourceBody = z
  .object({
    name: NonEmptyString.optional(),
    url: NonEmptyString,
    ref: z.string().optional(),
    type: SourceType.optional(),
  })
  .strict()
const RefreshSourceBody = ScanSourceBody.extend({
  repo: NonEmptyString,
})
const CachedSourceTreeBody = z
  .object({
    repo: NonEmptyString,
    name: NonEmptyString.optional(),
    url: NonEmptyString,
    pinned_commit: NonEmptyString.optional(),
    ref: NonEmptyString.optional(),
  })
  .strict()
const SourceRefsBody = z.object({
  url: NonEmptyString,
})

export function createRemoteRoutes(deps: RouteDeps): Hono {
  const app = new Hono()
  const updateSessions = new SourceUpdateSessionStore(deps.fs)

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
    // Detect corrupt or missing local caches so the UI can offer a repair update.
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
    jsonValidator(PrepareUpdateBody, { error: prepareUpdateError }),
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
          (body.source.members ?? []).map((member) => ({
            name: member.name,
            entry: member.entry,
            path: member.entry,
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
          resourceBoundaryChanges: session.resourceBoundaryChanges,
          pathMoves: session.pathMoves,
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
      const { repo, sessionId, preserve, resourceBoundaryDecisions } = c.req.valid('json')
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
      if (session.completed) {
        try {
          await updateSessions.discard(sessionId)
        } catch (cleanupError) {
          remoteLogger.warn('completed source update retry cleanup failed', {
            err: cleanupError,
            sessionId,
            stagingDir: session.stagingDir,
          })
        }
        return c.json({
          ok: true,
          pinned_commit: session.pinned_commit,
          changes: session.changes,
          preserved: session.completed.preserved,
          deleted: session.completed.deleted,
        })
      }
      try {
        const recovery = await updateSessions.recoverFinalize(session)
        if (recovery.projectionRequired) {
          const projected = await projectRepository(deps, session.repoPath, { scope: 'skills' })
          if (!projected.ok) throw projected.failure.originalError
        }
        if (session.finalize) await updateSessions.completeFinalizeRecovery(session)
      } catch (e) {
        remoteLogger.error('source update finalize recovery failed', {
          err: e,
          sessionId,
          source: session.source.url,
        })
        return c.json(
          {
            ok: false,
            error: 'update_recovery_failed',
            message: String((e as Error).message),
          },
          500,
        )
      }
      const removable = new Set(session.changes.removed.map(({ name }) => name))
      if (preserve.some((name) => !removable.has(name)))
        return c.json(
          { ok: false, error: 'invalid_preserve_members', message: '保留列表包含无效 skill' },
          400,
        )
      const boundaryEntries = new Set(session.resourceBoundaryChanges.map(({ entry }) => entry))
      const decisionEntries = resourceBoundaryDecisions.map(({ entry }) => entry)
      if (
        new Set(decisionEntries).size !== decisionEntries.length ||
        decisionEntries.some((entry) => !boundaryEntries.has(entry))
      )
        return c.json(
          {
            ok: false,
            error: 'invalid_resource_boundary_confirmation',
            message: '资源边界确认包含无效 bundle',
          },
          400,
        )
      const acceptedBoundaries = new Set(decisionEntries)
      const unconfirmedBoundaries = session.resourceBoundaryChanges.filter(
        ({ entry }) => !acceptedBoundaries.has(entry),
      )
      if (unconfirmedBoundaries.length > 0)
        return c.json(
          {
            ok: false,
            error: 'resource_boundary_confirmation_required',
            message: '更新产生新的 SkillBundle 边界，需要明确确认',
            resourceBoundaryChanges: unconfirmedBoundaries,
          },
          409,
        )
      const liveCacheDir = cacheDirFor(session.repoPath, deriveRepoId(session.source.url))
      const backupCacheDir = join(dirname(session.stagingDir), 'live-backup')
      try {
        const filePath = join(session.repoPath, 'skills.yaml')
        const originalManifest = await deps.fs.readFile(filePath)
        const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
        const hadLiveCache = await deps.fs.exists(liveCacheDir)
        const rollbackProjectionRequired = await isValidGitRepo(deps.fs, liveCacheDir)
        data.sources ??= []
        data.skills ??= []
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
        await updateSessions.beginFinalize(session, {
          manifestPath: filePath,
          originalManifest,
          liveCacheDir,
          backupCacheDir,
          hadLiveCache,
          rollbackProjectionRequired,
          preservedDestinations: preserve.map((name) =>
            join(session.repoPath, 'assets', 'skills', name),
          ),
        })
        const currentSource = data.sources[sourceIndex]
        const nextSource = {
          ...currentSource,
          ref: session.newRef,
          pinned_commit: session.pinned_commit,
          members: persistedMembers(
            currentSource,
            session.newMembers,
            new Set(
              resourceBoundaryDecisions
                .filter(({ action }) => action === 'enable')
                .map(({ entry }) => entry),
            ),
          ),
        }
        data.sources[sourceIndex] = nextSource
        for (const name of preserve) {
          const dest = join(session.repoPath, 'assets', 'skills', name)
          const removed = session.changes.removed.find((member) => member.name === name)
          if (!removed?.previousPath) throw new Error(`Removed skill path not found: ${name}`)
          await deps.fs.copyDir(join(session.stagingDir, dirname(removed.previousPath)), dest)
          data.skills.push({ id: name, ...(removed?.targets ? { targets: removed.targets } : {}) })
        }
        if (hadLiveCache) {
          await deps.fs.move(liveCacheDir, backupCacheDir)
        }
        await deps.fs.move(session.candidateDir, liveCacheDir)
        await writeYaml(deps.fs, filePath, data)
        const projected = await projectRepository(deps, session.repoPath, { scope: 'skills' })
        if (!projected.ok) throw projected.failure.originalError
        const completed = {
          preserved: preserve,
          deleted: session.changes.removed
            .map(({ name }) => name)
            .filter((name) => !preserve.includes(name)),
        }
        await updateSessions.markCompleted(session, completed)
        try {
          await updateSessions.discard(sessionId)
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
          ...completed,
        })
      } catch (e) {
        remoteLogger.error('source update finalize failed', {
          err: e,
          sessionId,
          source: session.source.url,
        })
        try {
          const recovery = await updateSessions.recoverFinalize(session)
          if (recovery.projectionRequired) {
            const rollbackProjection = await projectRepository(deps, session.repoPath, {
              scope: 'skills',
            })
            if (!rollbackProjection.ok) throw rollbackProjection.failure.originalError
          }
          if (session.finalize) await updateSessions.completeFinalizeRecovery(session)
        } catch (rollbackError) {
          remoteLogger.error('source update finalize rollback failed', {
            err: rollbackError,
            sessionId,
            source: session.source.url,
          })
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
    '/sources/tree',
    jsonValidator(CachedSourceTreeBody, { error: cachedSourceTreeError }),
    async (c) => {
      const { repo, name, url, pinned_commit, ref } = c.req.valid('json')
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (err) {
        remoteLogger.error('cached source tree repo resolution failed', { err, repo, url })
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((err as Error).message) },
          400,
        )
      }

      const cacheDir = cacheDirFor(repoPath, deriveRepoId(url))
      if (!(await isValidGitRepo(deps.fs, cacheDir))) {
        const err = new Error(`Source cache is missing or invalid: ${cacheDir}`)
        remoteLogger.error('cached source tree unavailable', { err, repo: repoPath, url, cacheDir })
        return c.json({ ok: false, error: 'source_cache_unavailable', message: err.message }, 404)
      }

      try {
        const tree = await scanSourceTree(deps.git, cacheDir, pinned_commit ?? ref ?? 'HEAD', {
          ...(name ? { name } : {}),
          url,
        })
        return c.json({
          ok: true,
          commit: tree.commit,
          tree,
          summary: summarizeSourceTree(tree.nodes),
          diagnostics: tree.diagnostics,
        })
      } catch (err) {
        remoteLogger.error('cached source tree scan failed', {
          err,
          repo: repoPath,
          url,
          cacheDir,
          ref: pinned_commit ?? ref ?? 'HEAD',
        })
        return c.json(
          {
            ok: false,
            error: 'cached_tree_failed',
            message: String((err as Error)?.message ?? err),
          },
          500,
        )
      }
    },
  )

  app.post(
    '/sources/scan',
    jsonValidator(ScanSourceBody, { error: scanSourceError }),
    async (c) => {
      try {
        const { name, url, ref, type } = c.req.valid('json')
        const { discoverSourceTree } = await import('../../remote/discover.js')
        const tree = await discoverSourceTree(deps.git, {
          ...(name ? { name } : {}),
          url,
          ...(typeof ref === 'string' && ref.trim() ? { ref: ref.trim() } : {}),
          ...(type === 'branch' || type === 'tag' ? { type } : {}),
        })
        return c.json({
          ok: true,
          commit: tree.commit,
          tree,
          summary: summarizeSourceTree(tree.nodes),
          diagnostics: tree.diagnostics,
        })
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
        const { repo, name, url, ref, type } = c.req.valid('json')
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
        // Read the tracked commit tree from the local cache. Clone only when the
        // cache was removed; corrupt caches are repaired through the update flow.
        const cacheDir = join(repoPath, 'remote-cache', sourceId)
        if (!(await deps.fs.exists(cacheDir))) {
          await installSkill(deps.git, deps.fs, url, ref ?? 'main', repoPath, sourceId)
        }
        const tree = await scanSourceTree(deps.git, cacheDir, ref ?? 'HEAD', {
          ...(name ? { name } : {}),
          url,
        })
        return c.json({
          ok: true,
          tree,
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

function updateCheckError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'sources' ? 'invalid_sources' : 'invalid_repo'
}

function prepareUpdateError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'repo') return 'invalid_repo'
  if (field === 'source') return 'invalid_source'
  if (field === 'newRef') return 'invalid_ref'
  return 'invalid_update_request'
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

function cachedSourceTreeError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'repo') return 'invalid_repo'
  if (field === 'pinned_commit' || field === 'ref') return 'invalid_ref'
  if (field === 'url') return 'invalid_url'
  return 'invalid_source_tree_request'
}
