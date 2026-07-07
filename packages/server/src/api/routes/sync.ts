import { Hono } from 'hono'
import { syncForcePush, syncPush } from '../../sync/push.js'
import { SyncSessionError } from '../../sync/session-manager.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { SyncRouteDeps } from '../router.js'
import { classifySyncGitError, syncErrorMessage } from '../../sync/errors.js'

const syncLogger = logger.child('sync')

export function createSyncRoutes(deps: SyncRouteDeps): Hono {
  const app = new Hono()

  app.post('/sync/pull', async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = await c.req.json()
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      syncLogger.info('isolated pull started', { repoPath })
      const result = await deps.sync.pull(repoPath)
      syncLogger.info('isolated pull completed', { repoPath, clean: result.clean })
      return c.json({ ok: true, ...result })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'pull' })
    }
  })

  app.get('/sync/session', async (c) => {
    let repoPath: string | undefined
    try {
      repoPath = await resolveRepoPath(deps.fs, c.req.query('repo')!, deps.home)
      const result = await deps.sync.getSession(repoPath)
      return c.json(result ? { ok: true, active: true, ...result } : { ok: true, active: false })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'session restore' })
    }
  })

  app.post('/sync/conflicts/save', async (c) => {
    let context: Record<string, unknown> = {}
    try {
      const { sessionId, path, result } = await c.req.json()
      context = { sessionId, path }
      const saved = await deps.sync.saveConflict(sessionId, path, result)
      return c.json({ ok: true, ...saved })
    } catch (err) {
      return syncError(c, err, { ...context, operation: 'conflict save' })
    }
  })

  app.post('/sync/conflicts/abort', async (c) => {
    let sessionId: string | undefined
    try {
      ;({ sessionId } = await c.req.json())
      await deps.sync.abort(sessionId!)
      return c.json({ ok: true })
    } catch (err) {
      return syncError(c, err, { sessionId, operation: 'conflict abort' })
    }
  })

  app.post('/sync/push', async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = await c.req.json()
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      return c.json(await syncPush(repoPath, deps.git, syncLogger))
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'push' })
    }
  })

  app.post('/sync/force-push', async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = await c.req.json()
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      return c.json(await syncForcePush(repoPath, deps.git, syncLogger))
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'force push' })
    }
  })

  app.post('/sync/force-pull', async (c) => {
    let repoPath: string | undefined
    try {
      const { repo } = await c.req.json()
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      syncLogger.info('force pull requested', { repoPath })
      const result = await deps.sync.forcePull(repoPath)
      syncLogger.info('force pull completed', { repoPath, clean: result.clean })
      return c.json({ ok: true, ...result })
    } catch (err) {
      return syncError(c, err, { repoPath, operation: 'force pull' })
    }
  })

  app.post('/sync/remote', async (c) => {
    try {
      const { repo, remoteUrl } = await c.req.json()
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

  app.get('/sync/remote', async (c) => {
    try {
      const repoPath = await resolveRepoPath(deps.fs, c.req.query('repo')!, deps.home)
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
