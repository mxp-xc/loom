import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/router'
import { loadProjectionManifest, projectRepository } from '../../src/projection/workflow.js'
import { syncForcePush, syncPush } from '../../src/sync/push'

const platformGit = vi.hoisted(() => ({
  status: vi.fn(async () => {
    throw new Error('route should delegate push status handling')
  }),
  add: vi.fn(),
  commit: vi.fn(),
  forcePush: vi.fn(),
}))

const syncManager = vi.hoisted(() => ({
  pull: vi.fn(async () => ({ conflicts: [], clean: true })),
  forcePull: vi.fn(async () => ({ conflicts: [], clean: true })),
  getSession: vi.fn(async () => null),
  saveConflict: vi.fn(async () => ({ clean: true, remaining: [] })),
  abort: vi.fn(async () => undefined),
  recover: vi.fn(async () => undefined),
  startMaintenance: vi.fn(() => () => undefined),
}))

vi.mock('../../src/lib/logger.js', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
    child: () => logger,
  }
  return { logger }
})

vi.mock('../../src/projection/executor.js', () => ({
  executeProjection: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/projection/workflow.js', () => ({
  loadProjectionManifest: vi.fn(async () => ({
    skills: { sources: [], skills: [] },
    mcp: [],
    vars: { default: {}, active: {} },
    memory: { memories: [], active: null, activeContent: '' },
    config: {},
    errors: [],
  })),
  projectRepository: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/sync/session-manager.js', () => ({
  SyncSessionError: class SyncSessionError extends Error {},
  SyncSessionManager: class SyncSessionManager {
    pull = syncManager.pull
    forcePull = syncManager.forcePull
    getSession = syncManager.getSession
    saveConflict = syncManager.saveConflict
    abort = syncManager.abort
    recover = syncManager.recover
    startMaintenance = syncManager.startMaintenance
  },
}))
vi.mock('../../src/sync/push.js', () => ({
  syncPush: vi.fn(async () => ({ ok: true })),
  syncForcePush: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@loom/core', () => ({
  loadRepoManifest: vi.fn(() => ({
    repoConfig: { targets: ['claude-code'] },
    errors: [],
    varsFiles: { default: {} },
  })),
  mergeConfig: vi.fn((repo: Record<string, unknown>) => ({ ...repo, active_repo: 'default' })),
  buildManifest: vi.fn(),
  planProjection: vi.fn(),
}))
vi.mock('../../src/platform/node/index.js', () => ({
  createNodePlatform: vi.fn(() => ({
    fs: {
      readFile: vi.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }),
      exists: vi.fn(async () => false),
      readDir: vi.fn(async () => []),
    },
    git: platformGit,
    proc: {},
  })),
}))
vi.mock('../../src/api/repo.js', () => ({
  resolveRepoPath: vi.fn(async (_fs: unknown, repo: string) => repo),
  listRepos: vi.fn(async () => []),
}))

describe('API routes', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/project calls executeProjection, returns result', async () => {
    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r',
        manifest: {
          skills: { sources: [], skills: [] },
          mcp: [],
          vars: { default: {}, active: {} },
          config: {},
          errors: [],
        },
        varsCtx: { env: {}, activeProfile: {}, defaultProfile: {} },
        plan: { links: [], mcpEntries: [], skippedAgents: [], strategy: 'link' },
        installedAgents: ['claude-code'],
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(projectRepository).toHaveBeenCalledWith(
      expect.objectContaining({ fs: expect.any(Object), git: expect.any(Object) }),
      '/tmp/r',
      expect.objectContaining({
        manifest: expect.objectContaining({ skills: { sources: [], skills: [] } }),
        plan: expect.objectContaining({ links: [] }),
        installedAgents: ['claude-code'],
      }),
    )
  })
  it('GET /api/manifest delegates manifest discovery to projection workflow', async () => {
    const res = await app.request('/api/manifest?repo=/tmp/r')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skills: { sources: [], skills: [] } })
    expect(loadProjectionManifest).toHaveBeenCalledWith(
      expect.objectContaining({ fs: expect.any(Object), git: expect.any(Object) }),
      '/tmp/r',
    )
  })
  it('POST /api/sync/pull returns PullResult', async () => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clean).toBe(true)
  })
  it('POST /api/sync/push delegates to the push workflow and returns its result', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(syncPush).toHaveBeenCalledWith('/tmp/r', platformGit, expect.any(Object))
    expect(platformGit.status).not.toHaveBeenCalled()
    expect(platformGit.add).not.toHaveBeenCalled()
    expect(platformGit.commit).not.toHaveBeenCalled()
  })
  it('POST /api/sync/push returns workflow failure responses unchanged', async () => {
    vi.mocked(syncPush).mockResolvedValueOnce({
      ok: false,
      error: 'no_remote',
      message: 'missing remote',
    })

    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'no_remote',
      message: 'missing remote',
    })
  })
  it('POST /api/sync/force-push delegates to the force push workflow and returns its result', async () => {
    const res = await app.request('/api/sync/force-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(syncForcePush).toHaveBeenCalledWith('/tmp/r', platformGit, expect.any(Object))
    expect(platformGit.forcePush).not.toHaveBeenCalled()
  })

  it('POST /api/sync/force-pull delegates to the sync manager and returns its result', async () => {
    const res = await app.request('/api/sync/force-pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, clean: true, conflicts: [] })
    expect(syncManager.forcePull).toHaveBeenCalledWith('/tmp/r')
  })
  it('POST /api/sync/conflicts/save returns remaining conflicts', async () => {
    const res = await app.request('/api/sync/conflicts/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', path: 'skills.yaml', result: 'resolved\n' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, clean: true, remaining: [] })
  })
  it('POST /api/sync/conflicts/abort returns ok', async () => {
    const res = await app.request('/api/sync/conflicts/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('GET /api/config returns effective + repo + local config', async () => {
    const res = await app.request('/api/config?repo=/tmp/r')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('effective')
    expect(body).toHaveProperty('repo')
    expect(body).toHaveProperty('local')
  })
  it('GET /api/config returns profiles list from vars files', async () => {
    const res = await app.request('/api/config?repo=/tmp/r')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.profiles).toBeDefined()
    expect(Array.isArray(json.profiles)).toBe(true)
    expect(json.profiles).toContain('default')
  })
})
