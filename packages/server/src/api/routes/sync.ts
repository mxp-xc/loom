import { Hono } from 'hono'
import { z } from 'zod'
import { syncForcePush, syncPush } from '../../sync/push.js'
import { SyncSessionError } from '../../sync/session-manager.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { SyncRouteDeps } from '../router.js'
import { classifySyncGitError, syncErrorMessage } from '../../sync/errors.js'
import { jsonValidator, queryValidator } from '../request-validation.js'

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

  app.post('/sync/pull', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      syncLogger.info('isolated pull started', { repoPath })
      const result = await deps.sync.pull(repoPath)
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
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const result = await deps.sync.getSession(repoPath)
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
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      return c.json(await syncPush(repoPath, deps.git, syncLogger))
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'push' })
    }
  })

  app.post('/sync/force-push', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      return c.json(await syncForcePush(repoPath, deps.git, syncLogger))
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'force push' })
    }
  })

  app.post('/sync/force-pull', jsonValidator(RepoBody, { error: 'invalid_repo' }), async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = c.req.valid('json')
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      syncLogger.info('force pull requested', { repoPath })
      const result = await deps.sync.forcePull(repoPath)
      syncLogger.info('force pull completed', { repoPath, clean: result.clean })
      return c.json({ ok: true, ...result })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'force pull' })
    }
  })

  app.post('/sync/remote', jsonValidator(RemoteBody, { error: syncRemoteError }), async (c) => {
    try {
      const { repo, remoteUrl } = c.req.valid('json')
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      await deps.git.addOrUpdateRemote(repoPath, remoteUrl)
      return c.json({ ok: true, remoteUrl })
    } catch (err) {
      syncLogger.error('remote update failed', { err })
      return c.json({
        ok: false,
        error: 'remote_failed',
        message: String((err as Error)?.message ?? err),
      })
    }
  })

  app.get('/sync/remote', queryValidator(RepoQuery, { error: 'invalid_repo' }), async (c) => {
    try {
      const { repo } = c.req.valid('query')
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      return c.json({ remoteUrl: await deps.git.getRemoteUrl(repoPath) })
    } catch (err) {
      syncLogger.error('remote lookup failed', { err })
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((err as Error).message) },
        400,
      )
    }
  })

  return app
}

function syncError(c: any, err: unknown, context: Record<string, unknown>) {
  syncLogger.error(`${String(context.operation)} failed`, { err, ...context })
  const message = syncErrorMessage(err)
  const error =
    err instanceof SyncSessionError
      ? err.code
      : message.includes('未解决的冲突标记')
        ? 'unresolved_markers'
        : classifySyncGitError(message)
  return c.json({ ok: false, error, message }, error === 'invalid_repo' ? 400 : 200)
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
