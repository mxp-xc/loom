import { Hono } from 'hono'
import { syncPull, applyResolutions } from '../../sync/pull.js'
import { syncPush } from '../../sync/push.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'

const syncLogger = logger.child('sync')

export function createSyncRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/sync/pull', async (c) => {
    try {
      const { repo } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      syncLogger.info('pull started', { repoPath })
      const res = await syncPull(repoPath, deps.git, deps.fs, {
        error: (o, m) => syncLogger.error(m, o as Record<string, unknown>),
        warn: (o, m) => syncLogger.warn(m, o as Record<string, unknown>),
      })
      syncLogger.info('pull completed', { repoPath, clean: res.clean })
      return c.json({ ok: true, ...res })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      syncLogger.error('pull failed', { err: e, repoPath: c.req.path })
      const noRemote =
        /no remote|could not find remote|not a git repository|does not appear to be a git/i.test(
          msg,
        )
      return c.json({ ok: false, error: noRemote ? 'no_remote' : 'other', message: msg })
    }
  })

  app.post('/sync/apply', async (c) => {
    try {
      const { repo, resolutions } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      syncLogger.info('apply resolutions', {
        repoPath,
        count: Object.keys(resolutions ?? {}).length,
      })
      await applyResolutions(repoPath, deps.git, deps.fs, resolutions, {
        error: (o, m) => syncLogger.error(m, o as Record<string, unknown>),
        warn: (o, m) => syncLogger.warn(m, o as Record<string, unknown>),
      })
      syncLogger.info('apply completed', { repoPath })
      return c.json({ ok: true })
    } catch (e) {
      syncLogger.error('apply failed', { err: e })
      const msg = String((e as Error)?.message ?? e)
      return c.json({ ok: false, error: 'apply_failed', message: msg })
    }
  })

  app.post('/sync/push', async (c) => {
    try {
      const { repo } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      syncLogger.info('push started', { repoPath })
      // Auto-commit uncommitted yaml changes before pushing
      const status = await deps.git.status(repoPath)
      if (status.dirty) {
        await deps.git.add(repoPath, ['.'])
        await deps.git.commit(repoPath, 'loom: sync changes')
      }
      const res = await syncPush(repoPath, deps.git)
      syncLogger.info('push completed', { repoPath, ok: res.ok })
      return c.json(res)
    } catch (e) {
      syncLogger.error('push failed', { err: e })
      const msg = String((e as Error)?.message ?? e)
      const noRemote =
        /no remote|could not find remote|not a git repository|does not appear to be a git/i.test(
          msg,
        )
      return c.json({ ok: false, error: noRemote ? 'no_remote' : 'other', message: msg })
    }
  })

  app.post('/sync/remote', async (c) => {
    try {
      const { repo, remoteUrl } = await c.req.json()
      let repoPath: string
      try {
        repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      } catch (e) {
        return c.json(
          { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
          400,
        )
      }
      await deps.git.addOrUpdateRemote(repoPath, remoteUrl)
      return c.json({ ok: true, remoteUrl })
    } catch (e) {
      return c.json({
        ok: false,
        error: 'remote_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.get('/sync/remote', async (c) => {
    const repo = c.req.query('repo')!
    let repoPath: string
    try {
      repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
    } catch (e) {
      return c.json(
        { ok: false, error: 'invalid_repo', message: String((e as Error).message) },
        400,
      )
    }
    const remoteUrl = await deps.git.getRemoteUrl(repoPath)
    return c.json({ remoteUrl })
  })

  return app
}
