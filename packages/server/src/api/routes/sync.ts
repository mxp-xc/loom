import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { syncForcePush, syncPush } from '../../sync/push.js'
import { SyncSessionError } from '../../sync/session-manager.js'
import { authorizeRepository, revalidateRepositoryAuthorization } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { SyncRouteDeps } from '../router.js'
import { classifySyncGitError, syncErrorMessage } from '../../sync/errors.js'
import { jsonValidator, queryValidator } from '../request-validation.js'
import { repositoryErrorResponse } from '../repository-route-error.js'
import { resourceLeases } from '../../concurrency/resource-lease-coordinator.js'
import { withRepositoryLease } from '../repository-lease.js'

const syncLogger = logger.child('sync')
const NonEmptyString = z.string().min(1)
const RepoBody = z.object({ repo: NonEmptyString })
const RepoQuery = z.object({ repo: NonEmptyString })
const ConflictSaveBody = z.object({
  sessionId: NonEmptyString,
  path: NonEmptyString,
  result: z.string(),
})
const ConflictAbortBody = z.object({ sessionId: NonEmptyString })
const RemoteBody = RepoBody.extend({ remoteUrl: NonEmptyString })

export function createSyncRoutes(deps: SyncRouteDeps): Hono {
  const app = new Hono()
  const leases = resourceLeases(deps, deps.leases)
  const leaseDeps = { ...deps, leases }

  app.post('/sync/pull', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      const authorization = await authorizeRepository(deps.fs, repo, deps.home)
      repoPath = authorization.path
      syncLogger.info('isolated pull started', { repoPath })
      const result = await deps.sync.pull(repoPath, (lockedRepoPath) =>
        revalidateRepositoryAuthorization(deps.fs, deps.home, authorization, lockedRepoPath),
      )
      syncLogger.info('isolated pull completed', { repoPath, clean: result.clean })
      return c.json({ ok: true, ...result })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'pull' })
    }
  })

  app.get('/sync/session', queryValidator(RepoQuery, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('query')
      const result = await withRepositoryLease(
        leaseDeps,
        repo,
        'read',
        (authorizedRepoPath) => [authorizedRepoPath],
        async (authorizedRepoPath) => {
          repoPath = authorizedRepoPath
          return deps.sync.getSession(authorizedRepoPath)
        },
      )
      return c.json(result ? { ok: true, active: true, ...result } : { ok: true, active: false })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'session restore' })
    }
  })

  app.post(
    '/sync/conflicts/save',
    jsonValidator(ConflictSaveBody, { error: syncConflictSaveError }),
    async (c) => {
      const { sessionId, path, result } = c.req.valid('json')
      try {
        const saved = await deps.sync.saveConflict(sessionId, path, result)
        return c.json({ ok: true, ...saved })
      } catch (err) {
        return syncError(c, err, { sessionId, path, operation: 'conflict save' })
      }
    },
  )

  app.post(
    '/sync/conflicts/abort',
    jsonValidator(ConflictAbortBody, { error: 'invalid_session' }),
    async (c) => {
      const { sessionId } = c.req.valid('json')
      try {
        await deps.sync.abort(sessionId)
        return c.json({ ok: true })
      } catch (err) {
        return syncError(c, err, { sessionId, operation: 'conflict abort' })
      }
    },
  )

  app.post('/sync/push', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      const result = await withRepositoryLease(
        leaseDeps,
        repo,
        'mutation',
        (authorizedRepoPath) => [authorizedRepoPath],
        async (authorizedRepoPath) => {
          repoPath = authorizedRepoPath
          return syncPush(authorizedRepoPath, deps.git, syncLogger)
        },
      )
      return c.json(result)
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'push' })
    }
  })

  app.post('/sync/force-push', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      const result = await withRepositoryLease(
        leaseDeps,
        repo,
        'mutation',
        (authorizedRepoPath) => [authorizedRepoPath],
        async (authorizedRepoPath) => {
          repoPath = authorizedRepoPath
          return syncForcePush(authorizedRepoPath, deps.git, syncLogger)
        },
      )
      return c.json(result)
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'force push' })
    }
  })

  app.post('/sync/force-pull', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      const authorization = await authorizeRepository(deps.fs, repo, deps.home)
      repoPath = authorization.path
      syncLogger.info('force pull requested', { repoPath })
      const result = await deps.sync.forcePull(repoPath, (lockedRepoPath) =>
        revalidateRepositoryAuthorization(deps.fs, deps.home, authorization, lockedRepoPath),
      )
      syncLogger.info('force pull completed', { repoPath, clean: result.clean })
      return c.json({ ok: true, ...result })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'force pull' })
    }
  })

  app.post('/sync/remote', jsonValidator(RemoteBody, { error: syncRemoteError }), async (c) => {
    try {
      const { repo, remoteUrl } = c.req.valid('json')
      await withRepositoryLease(
        leaseDeps,
        repo,
        'mutation',
        (repoPath) => [repoPath],
        async (repoPath) => {
          if (await deps.sync.getSession(repoPath)) {
            throw new SyncSessionError('active_session_exists', '请先解决或放弃当前同步会话')
          }
          await deps.git.addOrUpdateRemote(repoPath, remoteUrl)
        },
      )
      return c.json({ ok: true, remoteUrl })
    } catch (err) {
      const repoFailure = repositoryErrorResponse(
        c,
        err,
        syncLogger,
        'sync remote update repository authorization failed',
      )
      if (repoFailure) return repoFailure
      if (err instanceof SyncSessionError) {
        syncLogger.error('remote update blocked by sync session', { err })
        return c.json(
          { ok: false, error: err.code, message: err.message },
          err.code === 'manager_disposed' ? 503 : 409,
        )
      }
      syncLogger.error('remote update failed', { err })
      return c.json(
        { ok: false, error: 'remote_failed', message: 'failed to update sync remote' },
        500,
      )
    }
  })

  app.get('/sync/remote', queryValidator(RepoQuery, { error: 'invalid_repo' }), async (c) => {
    try {
      const { repo } = c.req.valid('query')
      const remoteUrl = await withRepositoryLease(
        leaseDeps,
        repo,
        'read',
        (repoPath) => [repoPath],
        (repoPath) => deps.git.getRemoteUrl(repoPath),
      )
      return c.json({ remoteUrl })
    } catch (err) {
      const repoFailure = repositoryErrorResponse(
        c,
        err,
        syncLogger,
        'sync remote lookup repository authorization failed',
      )
      if (repoFailure) return repoFailure
      syncLogger.error('remote lookup failed', { err })
      return c.json(
        { ok: false, error: 'remote_failed', message: 'failed to read sync remote' },
        500,
      )
    }
  })

  return app
}

function syncError(c: Context, err: unknown, context: Record<string, unknown>) {
  const repoFailure = repositoryErrorResponse(
    c,
    err,
    syncLogger,
    `${String(context.operation)} repository authorization failed`,
    context,
  )
  if (repoFailure) return repoFailure

  syncLogger.error(`${String(context.operation)} failed`, { err, ...context })
  if (err instanceof SyncSessionError) {
    const status =
      err.code === 'session_not_found'
        ? 404
        : err.code === 'storage_quota_exceeded'
          ? 413
          : err.code === 'manager_disposed'
            ? 503
            : 409
    return c.json({ ok: false, error: err.code, message: err.message }, status)
  }
  const message = syncErrorMessage(err)
  const error = message.includes('未解决的冲突标记')
    ? 'unresolved_markers'
    : classifySyncGitError(message)
  return c.json({ ok: false, error, message: 'sync operation failed' }, 500)
}

function syncConflictSaveError(issues: z.ZodIssue[]): string {
  const field = issues[0]?.path[0]
  if (field === 'sessionId') return 'invalid_session'
  if (field === 'path') return 'invalid_path'
  return 'invalid_result'
}

function syncRemoteError(issues: z.ZodIssue[]): string {
  return issues[0]?.path[0] === 'remoteUrl' ? 'invalid_remote' : 'invalid_repo'
}
