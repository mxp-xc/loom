import { Hono } from 'hono'
import { join } from 'node:path'
import { installSkill, isValidGitRepo } from '../../remote/install.js'
import { checkUpdates, performUpdate } from '../../remote/update.js'
import { scanSourceMembers } from '../../projection/scan.js'
import { deriveRepoId, pinSourceCommit } from '@loom/core'
import { readYaml, writeYaml } from '../repo-config.js'
import { resolveRepoPath } from '../repo.js'
import { logger } from '../../lib/logger.js'
import type { RouteDeps } from '../router.js'

const remoteLogger = logger.child('remote')

export function createRemoteRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.post('/install', async (c) => {
    const { url, ref, repo, sourceId } = await c.req.json()
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

  app.post('/update', async (c) => {
    const { sources, repo } = await c.req.json()
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

  app.post('/update/perform', async (c) => {
    const body = await c.req.json()
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
      remoteLogger.info('update completed', { source: body.source?.url, commit: res.pinned_commit })
      return c.json(res)
    } catch (e) {
      remoteLogger.error('update failed', { err: e, source: body.source?.url })
      return c.json({
        ok: false,
        error: 'update_failed',
        message: String((e as Error)?.message ?? e),
      })
    }
  })

  app.post('/sources/scan', async (c) => {
    try {
      const { url, ref, type, scan } = await c.req.json()
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
  })

  // Force re-install a source's remote-cache and re-discover its members.
  // Used by the source row "scan" menu to refresh members after a pull or
  // when the cache is missing/stale.
  app.post('/sources/refresh', async (c) => {
    try {
      const { repo, url, ref, type, scan } = await c.req.json()
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
  })

  app.post('/sources/refs', async (c) => {
    try {
      const { url } = await c.req.json()
      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
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
