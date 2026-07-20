import { Hono, type Context } from 'hono'
import { join } from 'node:path'
import { z } from 'zod'
import { installSkill, isValidGitRepo } from '../../remote/install.js'
import { cacheDirFor } from '../../remote/cache.js'
import { checkUpdates } from '../../remote/update.js'
import { scanSourceTree } from '../../remote/source-tree.js'
import {
  LocalSkillIdSchema,
  SkillSourceSchema,
  deriveRepoId,
  summarizeSourceTree,
  type AgentId,
  type SkillSource,
} from '@loom/core'
import { readSkillsManifest, serializeYaml } from '../repo-config.js'
import { authorizeRepository, type RepositoryAuthorization } from '../repo.js'
import { logger } from '../../lib/logger.js'
import { jsonValidator } from '../request-validation.js'
import type { RouteDeps } from '../router.js'
import { prepareSourceUpdate } from '../../remote/update.js'
import {
  SourceUpdateSessionError,
  SourceUpdateSessionStore,
  SOURCE_UPDATE_PRESERVED_MARKER,
  persistedMembers,
  serializeSourceUpdatePreservedMarker,
  sourceUpdateBaseline,
  type PreservedDestinationOwnership,
} from '../../skills/update-sessions.js'
import { projectRepository } from '../../projection/workflow.js'
import type { ProjectionResult } from '../../projection/executor.js'
import {
  repositoryErrorResponse,
  repositoryResolutionErrorResponse,
} from '../repository-route-error.js'
import {
  LocalSkillBoundaryError,
  preflightBuiltInLocalSkill,
  prepareBuiltInLocalSkill,
  resolveLocalSkillRepositoryRoot,
} from '../../skills/local-paths.js'
import {
  LocalDirectoryTransaction,
  combineLocalTransactionFailure,
  normalizeLocalArchiveFiles,
  readPinnedLocalArchive,
  type LocalArchiveFile,
} from '../../skills/local-directory-transaction.js'
import {
  SourceCacheBoundaryError,
  assertAuthorizedSourceCache,
  resolveSourceCache,
} from '../../remote/cache-boundary.js'
import { homeResourceKey, projectionResourceKeys } from '../../concurrency/resource-keys.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'
import { runAuthorizedRepositoryLease, withRepositoryLease } from '../repository-lease.js'

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
const FinalizeUpdateBody = z
  .object({
    repo: NonEmptyString,
    sessionId: z.string().uuid(),
    preserve: z.array(LocalSkillIdSchema).default([]),
    resourceBoundaryDecisions: z
      .array(
        z
          .object({
            entry: NonEmptyString,
            action: z.enum(['enable', 'exclude']),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
const CancelUpdateBody = z
  .object({
    repo: NonEmptyString,
    sessionId: z.string().uuid(),
  })
  .strict()
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
  const leases = resourceLeases(deps, deps.leases)
  const leaseDeps = { ...deps, leases }
  app.post('/update', jsonValidator(UpdateCheckBody, { error: updateCheckError }), async (c) => {
    const { sources, repo } = c.req.valid('json')
    remoteLogger.info('check updates', { count: sources?.length ?? 0 })
    let authorization: RepositoryAuthorization | undefined
    try {
      if (repo) authorization = await authorizeRepository(deps.fs, repo, deps.home)
    } catch (e) {
      return repositoryResolutionErrorResponse(
        c,
        e,
        remoteLogger,
        'update check repository resolution failed',
        { repo },
      )
    }
    try {
      const updates = await checkUpdates(sources, deps.git)
      if (authorization) {
        await runAuthorizedRepositoryLease(
          leaseDeps,
          authorization,
          'read',
          (repoPath) => [repoPath],
          async (repoPath) => {
            // Detect corrupt or missing local caches so the UI can offer a repair update.
            for (const u of updates) {
              const sourceId = deriveRepoId(u.source.url)
              const cacheDir = join(repoPath, 'remote-cache', sourceId)
              if (!(await isValidGitRepo(deps.fs, cacheDir))) {
                ;(u as any).hasUpdate = true
                ;(u as any).needsRepair = true
              }
            }
          },
        )
      }
      return c.json({ updates })
    } catch (err) {
      const repoFailure = repositoryErrorResponse(
        c,
        err,
        remoteLogger,
        'update check repository authorization failed',
        { repo },
      )
      if (repoFailure) return repoFailure
      remoteLogger.error('source update check failed', { err, repo: authorization?.path })
      return c.json(
        { ok: false, error: 'update_check_failed', message: 'failed to check source updates' },
        500,
      )
    }
  })

  app.post(
    '/update/prepare',
    jsonValidator(PrepareUpdateBody, { error: prepareUpdateError }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        return await withRepositoryLease(
          leaseDeps,
          body.repo,
          'mutation',
          (repoPath) => [repoPath],
          async (repoPath) => {
            await updateSessions.prune(repoPath, 1)
            const manifest = await readSkillsManifest(deps.fs, repoPath)
            const matchingSources = manifest.sources.filter(({ url }) => url === body.source.url)
            if (matchingSources.length === 0) {
              return c.json(
                { ok: false, error: 'source_not_found', message: 'source is not registered' },
                404,
              )
            }
            if (matchingSources.length !== 1) {
              return c.json(
                {
                  ok: false,
                  error: 'invalid_source_manifest',
                  message: 'source manifest contains duplicate identities',
                },
                422,
              )
            }
            const source = matchingSources[0]
            const workspace = await updateSessions.createWorkspace(repoPath, source.url)
            const prepared = await prepareSourceUpdate(
              deps.git,
              deps.fs,
              source,
              body.newRef,
              workspace,
              (source.members ?? []).map((member) => ({
                name: member.name,
                entry: member.entry,
                path: member.entry,
                agents: member.agents,
              })),
            )
            const session = await updateSessions.create({
              workspace,
              source,
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
          },
        )
      } catch (e) {
        const repoFailure = repositoryErrorResponse(
          c,
          e,
          remoteLogger,
          'source update prepare repository authorization failed',
          { repo: body.repo, source: body.source.url },
        )
        if (repoFailure) return repoFailure
        const sessionFailure = sourceUpdateSessionErrorResponse(
          c,
          e,
          remoteLogger,
          'source update prepare session failed',
          { repo: body.repo, source: body.source.url },
        )
        if (sessionFailure) return sessionFailure
        remoteLogger.error('source update prepare failed', { err: e, source: body.source.url })
        return c.json(
          {
            ok: false,
            error: 'update_prepare_failed',
            message: 'failed to prepare source update',
          },
          500,
        )
      }
    },
  )

  app.post(
    '/update/cancel',
    jsonValidator(CancelUpdateBody, { error: 'invalid_update_session' }),
    async (c) => {
      const { repo, sessionId } = c.req.valid('json')
      try {
        return await withRepositoryLease(
          leaseDeps,
          repo,
          'mutation',
          (repoPath) => [repoPath],
          async (repoPath) => {
            let session
            try {
              session = await updateSessions.get(sessionId, repoPath)
            } catch (err) {
              const response = sourceUpdateSessionErrorResponse(
                c,
                err,
                remoteLogger,
                'source update cancel session recovery failed',
                { repo: repoPath, sessionId },
              )
              if (response) return response
              throw err
            }
            if (!session) {
              const err = new Error('source update session is missing or expired')
              remoteLogger.warn('source update cancel session unavailable', {
                err,
                repo: repoPath,
                sessionId,
              })
              return c.json(
                {
                  ok: false,
                  error: 'invalid_update_session',
                  message: 'source update session not found',
                },
                404,
              )
            }

            try {
              await updateSessions.discard(sessionId)
              return c.json({ ok: true })
            } catch (err) {
              remoteLogger.error('source update cancel failed', {
                err,
                repo: repoPath,
                sessionId,
                source: session.source.url,
              })
              return c.json(
                {
                  ok: false,
                  error: 'update_cancel_failed',
                  message: 'failed to cancel source update',
                },
                500,
              )
            }
          },
        )
      } catch (err) {
        const repoFailure = repositoryErrorResponse(
          c,
          err,
          remoteLogger,
          'source update cancel repository authorization failed',
          { repo, sessionId },
        )
        if (repoFailure) return repoFailure
        remoteLogger.error('source update cancel failed', { err, repo, sessionId })
        return c.json(
          {
            ok: false,
            error: 'update_cancel_failed',
            message: 'failed to cancel source update',
          },
          500,
        )
      }
    },
  )

  app.post(
    '/update/finalize',
    jsonValidator(FinalizeUpdateBody, { error: finalizeUpdateError }),
    async (c) => {
      const { repo, sessionId, preserve, resourceBoundaryDecisions } = c.req.valid('json')
      let home: string
      try {
        home = await homeResourceKey(deps.fs, deps.home)
      } catch (e) {
        return repositoryResolutionErrorResponse(
          c,
          e,
          remoteLogger,
          'source update finalize repository resolution failed',
          { repo, sessionId },
        )
      }
      const scopedDeps = { ...deps, home, leases }
      try {
        return await withRepositoryLease(
          scopedDeps,
          repo,
          'mutation',
          (repoPath) => projectionResourceKeys(home, repoPath, home, 'skills'),
          async (repoPath) => {
            let session
            try {
              session = await updateSessions.get(sessionId, repoPath)
            } catch (err) {
              const response = sourceUpdateSessionErrorResponse(
                c,
                err,
                remoteLogger,
                'source update finalize session recovery failed',
                { repo: repoPath, sessionId },
              )
              if (response) return response
              throw err
            }
            if (!session)
              return c.json(
                {
                  ok: false,
                  error: 'invalid_update_session',
                  message: 'source update session not found',
                },
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
            if (new Set(preserve).size !== preserve.length) {
              return c.json(
                {
                  ok: false,
                  error: 'invalid_preserve_members',
                  message: 'preserve list contains duplicate skill ids',
                },
                400,
              )
            }
            try {
              const recovery = await updateSessions.recoverFinalize(session)
              if (recovery.projectionRequired) {
                const projected = await projectRepository(scopedDeps, session.repoPath, {
                  scope: 'skills',
                })
                if (!projected.ok) throw projectionFailureError(projected)
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
                  message: 'failed to recover source update',
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
            const boundaryEntries = new Set(
              session.resourceBoundaryChanges.map(({ entry }) => entry),
            )
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
            let localTransaction: LocalDirectoryTransaction | undefined
            try {
              const filePath = session.manifestPath
              const originalManifest = await deps.fs.readFile(filePath)
              const data = await readSkillsManifest(deps.fs, session.repoPath)
              data.sources ??= []
              data.skills ??= []
              const sourceIndexes = data.sources.flatMap((source, index) =>
                source.url === session.source.url ? [index] : [],
              )
              if (sourceIndexes.length === 0) {
                return c.json(
                  {
                    ok: false,
                    error: 'source_update_stale',
                    message: 'source is no longer registered',
                  },
                  409,
                )
              }
              if (sourceIndexes.length !== 1) {
                return c.json(
                  {
                    ok: false,
                    error: 'invalid_source_manifest',
                    message: 'source manifest contains duplicate identities',
                  },
                  422,
                )
              }
              const sourceIndex = sourceIndexes[0]!
              const currentSource = data.sources[sourceIndex]
              if (sourceUpdateBaseline(currentSource) !== session.sourceBaseline) {
                return c.json(
                  {
                    ok: false,
                    error: 'source_update_stale',
                    message: 'source changed after the update was prepared',
                  },
                  409,
                )
              }
              const preservedArchives: Array<{
                name: string
                agents?: AgentId[]
                files: LocalArchiveFile[]
              }> = []
              const repository =
                preserve.length > 0
                  ? await resolveLocalSkillRepositoryRoot(deps.fs, session.repoPath)
                  : undefined
              for (const name of preserve) {
                if (data.skills.some((skill) => skill.id === name)) {
                  return c.json(
                    {
                      ok: false,
                      error: 'local_skill_exists',
                      message: 'local skill already exists',
                    },
                    409,
                  )
                }
                const removed = session.changes.removed.find((member) => member.name === name)
                if (!removed?.previousPath) {
                  throw new LocalSkillBoundaryError(
                    422,
                    'invalid_member_entry',
                    'Removed source member path is unavailable',
                  )
                }
                const currentMember = currentSource.members?.find(
                  (member) => member.name === name && member.entry === removed.previousPath,
                )
                if (!currentMember) {
                  throw new LocalSkillBoundaryError(
                    422,
                    'invalid_member_entry',
                    'Removed source member identity is unavailable',
                  )
                }
                await preflightBuiltInLocalSkill(deps.fs, session.repoPath, name)
                if (!repository) {
                  throw new LocalSkillBoundaryError(
                    500,
                    'local_skill_repository_unavailable',
                    'Local skill repository root is unavailable',
                  )
                }
                const files = await readPinnedLocalArchive(
                  deps.fs,
                  deps.git,
                  repository,
                  session.source,
                  removed.previousPath,
                )
                preservedArchives.push({
                  name,
                  ...(currentMember.agents ? { agents: currentMember.agents } : {}),
                  files: normalizeLocalArchiveFiles([
                    ...files,
                    {
                      path: SOURCE_UPDATE_PRESERVED_MARKER,
                      content: serializeSourceUpdatePreservedMarker(session, name),
                    },
                  ]),
                })
              }
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
              for (const skill of preservedArchives) {
                data.skills.push({
                  id: skill.name,
                  ...(skill.agents ? { agents: skill.agents } : {}),
                })
              }
              const liveCacheEntry = await deps.fs.inspectEntry(session.liveCacheDir)
              if (liveCacheEntry && liveCacheEntry.kind !== 'directory') {
                throw new Error('live source cache is not a physical directory')
              }
              const rollbackProjectionRequired = liveCacheEntry
                ? await isValidGitRepo(deps.fs, session.liveCacheDir)
                : false
              const hadLiveCache = Boolean(liveCacheEntry)
              const preservedDestinations: PreservedDestinationOwnership[] = []
              if (preservedArchives.length > 0) {
                const destinations = new Map(
                  await Promise.all(
                    preservedArchives.map(
                      async (skill) =>
                        [
                          skill.name,
                          await prepareBuiltInLocalSkill(deps.fs, session.repoPath, skill.name),
                        ] as const,
                    ),
                  ),
                )
                localTransaction = await LocalDirectoryTransaction.openAt(
                  deps.fs,
                  destinations.values().next().value!.root,
                  { path: session.sessionRoot, identity: session.rootIdentity },
                  'preserve-transaction',
                  remoteLogger,
                )
                for (const skill of preservedArchives) {
                  const staged = await localTransaction.stageArchive(
                    destinations.get(skill.name)!,
                    skill.files,
                  )
                  const marker = staged.files.find(
                    (file) => file.relativePath === SOURCE_UPDATE_PRESERVED_MARKER,
                  )
                  if (!marker) {
                    throw new Error('preserved local skill ownership marker is unavailable')
                  }
                  preservedDestinations.push({
                    name: skill.name,
                    ownerToken: session.ownerToken,
                    identity: marker.identity,
                  })
                }
              }
              await updateSessions.beginFinalize(session, {
                originalManifest,
                nextManifest: serializeYaml(data),
                hadLiveCache,
                rollbackProjectionRequired,
                preservedDestinations,
              })
              const finalizeJournal = session.finalize
              if (!finalizeJournal) throw new Error('source update finalize journal is unavailable')
              await localTransaction?.apply()
              if (hadLiveCache) {
                await deps.fs.moveDirectoryAtomic(
                  session.liveCacheDir,
                  session.backupCacheDir,
                  finalizeJournal.liveCacheDirectoryIdentity!,
                )
              }
              await deps.fs.moveDirectoryAtomic(
                session.candidateDir,
                session.liveCacheDir,
                finalizeJournal.candidateDirectoryIdentity!,
              )
              await updateSessions.applyManifest(session)
              const projected = await projectRepository(scopedDeps, session.repoPath, {
                scope: 'skills',
              })
              if (!projected.ok) throw projectionFailureError(projected)
              const completed = {
                preserved: preserve,
                deleted: session.changes.removed
                  .map(({ name }) => name)
                  .filter((name) => !preserve.includes(name)),
              }
              await localTransaction?.complete()
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
              const rollbackFailures = localTransaction ? await localTransaction.rollback() : []
              try {
                const recovery = await updateSessions.recoverFinalize(session)
                if (recovery.projectionRequired) {
                  const rollbackProjection = await projectRepository(scopedDeps, session.repoPath, {
                    scope: 'skills',
                  })
                  if (!rollbackProjection.ok) throw projectionFailureError(rollbackProjection)
                }
                if (
                  session.finalize &&
                  rollbackFailures.length === 0 &&
                  !(e instanceof AggregateError)
                ) {
                  await updateSessions.completeFinalizeRecovery(session)
                }
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError)
              }
              const failure = combineLocalTransactionFailure(e, rollbackFailures)
              remoteLogger.error('source update finalize failed', {
                err: failure,
                sessionId,
                source: session.source.url,
              })
              if (e instanceof LocalSkillBoundaryError && rollbackFailures.length === 0) {
                return c.json(
                  {
                    ok: false,
                    error: e.code,
                    message: 'failed to preserve local skill',
                  },
                  e.status,
                )
              }
              return c.json(
                {
                  ok: false,
                  error: 'update_finalize_failed',
                  message: 'failed to finalize source update',
                },
                500,
              )
            }
          },
        )
      } catch (e) {
        const repoFailure = repositoryErrorResponse(
          c,
          e,
          remoteLogger,
          'source update finalize repository authorization failed',
          { repo, sessionId },
        )
        if (repoFailure) return repoFailure
        remoteLogger.error('source update finalize failed', { err: e, repo, sessionId })
        return c.json(
          {
            ok: false,
            error: 'update_finalize_failed',
            message: 'failed to finalize source update',
          },
          500,
        )
      }
    },
  )

  app.post(
    '/sources/tree',
    jsonValidator(CachedSourceTreeBody, { error: cachedSourceTreeError }),
    async (c) => {
      const { repo, name, url, pinned_commit, ref } = c.req.valid('json')
      try {
        return await withRepositoryLease(
          leaseDeps,
          repo,
          'read',
          (repoPath) => [repoPath],
          async (repoPath) => {
            try {
              const source = await requireRegisteredSource(deps, repoPath, url)
              const sourceName = source.name?.trim()
              if (name !== undefined && name !== sourceName) {
                throw new RegisteredSourceError(
                  409,
                  'source_identity_mismatch',
                  'Source name does not match the registered source',
                )
              }
              const authoritativeRef = source.pinned_commit?.trim() || source.ref
              const requestedRef = pinned_commit ?? ref
              if (requestedRef !== undefined && requestedRef !== authoritativeRef) {
                throw new RegisteredSourceError(
                  409,
                  'source_identity_mismatch',
                  'Source revision does not match the registered source',
                )
              }
              const cache = await resolveSourceCache(deps.fs, repoPath, deriveRepoId(source.url))
              if (!cache) {
                const err = new Error('Registered source cache is missing')
                remoteLogger.error('cached source tree unavailable', {
                  err,
                  repo: repoPath,
                  url: source.url,
                })
                return c.json(
                  {
                    ok: false,
                    error: 'source_cache_unavailable',
                    message: 'source cache is unavailable',
                  },
                  404,
                )
              }
              const tree = await scanSourceTree(
                deps.git,
                cache.directory.path,
                authoritativeRef,
                source,
              )
              await assertAuthorizedSourceCache(deps.fs, cache)
              return c.json({
                ok: true,
                commit: tree.commit,
                tree,
                summary: summarizeSourceTree(tree.nodes),
                diagnostics: tree.diagnostics,
              })
            } catch (err) {
              const authorizationFailure = sourceCacheAuthorizationErrorResponse(
                c,
                err,
                remoteLogger,
                'cached source tree authorization failed',
                { repo: repoPath, url },
              )
              if (authorizationFailure) return authorizationFailure
              remoteLogger.error('cached source tree scan failed', {
                err,
                repo: repoPath,
                url,
                ref: pinned_commit ?? ref ?? 'HEAD',
              })
              return c.json(
                {
                  ok: false,
                  error: 'cached_tree_failed',
                  message: 'failed to read cached source tree',
                },
                500,
              )
            }
          },
        )
      } catch (err) {
        const repoFailure = repositoryErrorResponse(
          c,
          err,
          remoteLogger,
          'cached source tree repository authorization failed',
          { repo, url },
        )
        if (repoFailure) return repoFailure
        remoteLogger.error('cached source tree scan failed', { err, repo, url })
        return c.json(
          {
            ok: false,
            error: 'cached_tree_failed',
            message: 'failed to read cached source tree',
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
        return c.json({ ok: false, error: 'scan_failed', message: 'failed to scan source' }, 500)
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
        return await withRepositoryLease(
          leaseDeps,
          repo,
          'mutation',
          (repoPath) => [repoPath],
          async (repoPath) => {
            const source = await requireRegisteredSource(deps, repoPath, url)
            const sourceId = deriveRepoId(source.url)
            // Read the tracked commit tree from the local cache. Clone only when the
            // cache was removed; corrupt caches are repaired through the update flow.
            let cache = await resolveSourceCache(deps.fs, repoPath, sourceId)
            if (!cache) {
              await installSkill(
                deps.git,
                deps.fs,
                source.url,
                ref ?? source.ref,
                repoPath,
                sourceId,
              )
              cache = await resolveSourceCache(deps.fs, repoPath, sourceId)
            }
            if (!cache) throw new Error('Installed source cache is unavailable')
            const tree = await scanSourceTree(deps.git, cache.directory.path, ref ?? source.ref, {
              ...source,
              ...(name ? { name } : {}),
            })
            await assertAuthorizedSourceCache(deps.fs, cache)
            return c.json({
              ok: true,
              tree,
            })
          },
        )
      } catch (e) {
        const repoFailure = repositoryErrorResponse(
          c,
          e,
          remoteLogger,
          'source refresh repository authorization failed',
        )
        if (repoFailure) return repoFailure
        const authorizationFailure = sourceCacheAuthorizationErrorResponse(
          c,
          e,
          remoteLogger,
          'source refresh authorization failed',
        )
        if (authorizationFailure) return authorizationFailure
        remoteLogger.error('source refresh failed', { err: e })
        return c.json(
          { ok: false, error: 'refresh_failed', message: 'failed to refresh source' },
          500,
        )
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
      return c.json({ ok: false, error: 'refs_failed', message: 'failed to list source refs' }, 500)
    }
  })

  return app
}

function projectionFailureError(result: Extract<ProjectionResult, { ok: false }>): unknown {
  return combineLocalTransactionFailure(
    result.failure.originalError,
    result.failure.rollbackReport.rollbackFailures.map(({ err }) => err),
  )
}

class RegisteredSourceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: 'source_not_found' | 'source_identity_mismatch' | 'invalid_source_manifest',
    message: string,
  ) {
    super(message)
    this.name = 'RegisteredSourceError'
  }
}

async function requireRegisteredSource(
  deps: RouteDeps,
  repoPath: string,
  url: string,
): Promise<SkillSource> {
  const manifest = await readSkillsManifest(deps.fs, repoPath)
  const matches = manifest.sources.filter((source) => source.url === url)
  if (matches.length === 0) {
    throw new RegisteredSourceError(404, 'source_not_found', 'Source is not registered')
  }
  if (matches.length !== 1) {
    throw new RegisteredSourceError(
      422,
      'invalid_source_manifest',
      'Source manifest contains duplicate identities',
    )
  }
  return matches[0]
}

function sourceCacheAuthorizationErrorResponse(
  c: Context,
  error: unknown,
  routeLogger: { error(message: string, context?: Record<string, unknown>): void },
  logMessage: string,
  context: Record<string, unknown> = {},
): Response | null {
  if (error instanceof RegisteredSourceError) {
    routeLogger.error(logMessage, { err: error, ...context })
    return c.json(
      {
        ok: false,
        error: error.code,
        message: registeredSourceMessage(error.code),
      },
      error.status,
    )
  }
  if (error instanceof SourceCacheBoundaryError) {
    routeLogger.error(logMessage, { err: error, ...context })
    return c.json(
      {
        ok: false,
        error: error.code,
        message: sourceCacheMessage(error.code),
      },
      error.status,
    )
  }
  return null
}

function registeredSourceMessage(code: RegisteredSourceError['code']): string {
  if (code === 'source_not_found') return 'source is not registered'
  if (code === 'source_identity_mismatch') {
    return 'source request does not match the registered source'
  }
  return 'source manifest is invalid'
}

function sourceCacheMessage(code: SourceCacheBoundaryError['code']): string {
  if (code === 'source_cache_collision') return 'source cache destination already exists'
  if (code === 'invalid_source_cache') return 'source cache boundary is invalid'
  return 'source cache is unavailable'
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

function finalizeUpdateError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'repo') return 'invalid_repo'
  if (field === 'sessionId') return 'invalid_update_session'
  if (field === 'preserve') return 'invalid_preserve_members'
  if (field === 'resourceBoundaryDecisions') return 'invalid_resource_boundary_confirmation'
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

function sourceUpdateSessionErrorResponse(
  c: Context,
  error: unknown,
  routeLogger: { error(message: string, context?: Record<string, unknown>): void },
  logMessage: string,
  context: Record<string, unknown>,
): Response | null {
  if (!(error instanceof SourceUpdateSessionError)) return null
  routeLogger.error(logMessage, { err: error, ...context })
  return c.json(
    {
      ok: false,
      error: error.code,
      message:
        error.code === 'invalid_update_session_state'
          ? 'source update session state is invalid'
          : 'source update session is unavailable',
    },
    error.status,
  )
}
