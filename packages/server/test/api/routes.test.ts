import { afterAll, describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/router'
import { responseJson, validationError } from '../helpers/http.js'
import {
  loadDisplayManifest,
  loadProjectionManifest,
  projectRepository,
} from '../../src/projection/workflow.js'
import { syncForcePush, syncPush } from '../../src/sync/push'
import { SyncSessionError } from '../../src/sync/session-manager.js'
import { ResourceLeaseCoordinator } from '../../src/concurrency/resource-lease-coordinator.js'

const platformGit = vi.hoisted(() => ({
  status: vi.fn(async () => {
    throw new Error('route should delegate push status handling')
  }),
  add: vi.fn(),
  commit: vi.fn(),
  forcePush: vi.fn(),
  addOrUpdateRemote: vi.fn(async () => undefined),
  getRemoteUrl: vi.fn(async () => 'https://example.com/repo.git'),
}))

const syncManager = vi.hoisted(() => ({
  pull: vi.fn(async (repoPath: string, guard?: (path: string) => Promise<void>) => {
    await guard?.(repoPath)
    return { conflicts: [], clean: true }
  }),
  forcePull: vi.fn(async (repoPath: string, guard?: (path: string) => Promise<void>) => {
    await guard?.(repoPath)
    return { conflicts: [], clean: true }
  }),
  getSession: vi.fn(async () => null),
  saveConflict: vi.fn(async () => ({ clean: true, remaining: [] })),
  abort: vi.fn(async () => undefined),
  recover: vi.fn(async () => undefined),
  startMaintenance: vi.fn(),
  dispose: vi.fn(async () => undefined),
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
  loadDisplayManifest: vi.fn(async () => ({
    skills: { sources: [], skills: [] },
    mcp: [],
    vars: { default: {}, active: {} },
    memory: { memories: [], active: null, activeContent: '' },
    config: {},
    errors: [],
  })),
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
  SyncSessionError: class SyncSessionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  SyncSessionManager: class SyncSessionManager {
    pull = syncManager.pull
    forcePull = syncManager.forcePull
    getSession = syncManager.getSession
    saveConflict = syncManager.saveConflict
    abort = syncManager.abort
    recover = syncManager.recover
    startMaintenance = syncManager.startMaintenance
    dispose = syncManager.dispose
  },
}))
vi.mock('../../src/sync/push.js', () => ({
  syncPush: vi.fn(async () => ({ ok: true })),
  syncForcePush: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@loom/core', async () => {
  const actual = await vi.importActual<typeof import('@loom/core')>('@loom/core')
  return {
    ...actual,
    loadRepoManifest: vi.fn(() => ({
      repoConfig: { agents: ['claude-code'] },
      errors: [],
      varsFiles: { default: {} },
    })),
    mergeConfig: vi.fn((repo: Record<string, unknown>) => ({ ...repo, active_repo: 'default' })),
    buildManifest: vi.fn(),
    planProjection: vi.fn(),
  }
})
vi.mock('../../src/platform/node/index.js', () => ({
  createNodePlatform: vi.fn(() => ({
    fs: {
      readFile: vi.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }),
      exists: vi.fn(async () => false),
      readDir: vi.fn(async () => []),
      realPath: vi.fn(async (path: string) => path),
      inspectEntry: vi.fn(async (path: string) =>
        path === '/tmp/r'
          ? { kind: 'directory' as const, identity: 'repo:/tmp/r', linkCount: 2 }
          : null,
      ),
    },
    git: platformGit,
    proc: {},
  })),
}))
vi.mock('../../src/api/repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/repo.js')>()
  return {
    ...actual,
    resolveRepoPath: vi.fn(async (_fs: unknown, repo: string) => repo),
    authorizeRepository: vi.fn(async (_fs: unknown, repo: string) => ({
      name: repo,
      path: repo,
      identity: `repo:${repo}`,
    })),
    revalidateRepositoryAuthorization: vi.fn(async () => undefined),
    listRepos: vi.fn(async () => []),
  }
})

describe('API routes', () => {
  const routes = registerRoutes()
  const app = new Hono().route('/api', routes)
  afterAll(() => routes.dispose())

  it('owns and disposes the default sync manager idempotently', async () => {
    syncManager.startMaintenance.mockClear()
    syncManager.dispose.mockClear()
    const runtime = registerRoutes()
    expect(syncManager.startMaintenance).toHaveBeenCalledTimes(1)
    const first = runtime.dispose()
    const second = runtime.dispose()
    expect(second).toBe(first)
    await first
    expect(syncManager.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not start or dispose an injected sync manager', async () => {
    const leases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const injectedSync = {
      recover: vi.fn(async () => undefined),
      startMaintenance: vi.fn(),
      dispose: vi.fn(async () => undefined),
      usesLeaseCoordinator: vi.fn((candidate) => candidate === leases),
    }
    const runtime = registerRoutes({
      fs: { realPath: vi.fn(async (path: string) => path) } as never,
      git: {} as never,
      proc: {} as never,
      home: '/tmp/injected-home',
      leases,
      sync: injectedSync as never,
      mcpDebug: {
        createSession: vi.fn(),
        callTool: vi.fn(),
        disconnect: vi.fn(),
      } as never,
    })

    expect(injectedSync.recover).toHaveBeenCalledTimes(1)
    await runtime.dispose()
    expect(injectedSync.startMaintenance).not.toHaveBeenCalled()
    expect(injectedSync.dispose).not.toHaveBeenCalled()
  })

  it('rejects an injected sync manager without an explicit route coordinator', () => {
    const injectedSync = {
      recover: vi.fn(async () => undefined),
      usesLeaseCoordinator: vi.fn(() => true),
    }

    expect(() =>
      registerRoutes({
        fs: {} as never,
        git: {} as never,
        proc: {} as never,
        home: '/tmp/injected-home',
        sync: injectedSync as never,
      }),
    ).toThrow('Injected SyncSessionManager requires an explicit lease coordinator')
    expect(injectedSync.recover).not.toHaveBeenCalled()
  })

  it('rejects an injected sync manager using a different route coordinator', () => {
    const managerLeases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const routeLeases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const injectedSync = {
      recover: vi.fn(async () => undefined),
      usesLeaseCoordinator: vi.fn((candidate) => candidate === managerLeases),
    }

    expect(() =>
      registerRoutes({
        fs: {} as never,
        git: {} as never,
        proc: {} as never,
        home: '/tmp/injected-home',
        leases: routeLeases,
        sync: injectedSync as never,
      }),
    ).toThrow('Injected SyncSessionManager must use the route lease coordinator')
    expect(injectedSync.recover).not.toHaveBeenCalled()
  })

  it('waits for the shared repository lease before updating a sync remote', async () => {
    const leases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const run = vi.spyOn(leases, 'run')
    let releaseHolder!: () => void
    let markHeld!: () => void
    const held = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    const holder = leases.runMutation(['/tmp/r'], async () => {
      markHeld()
      await release
    })
    await held

    const injectedSync = {
      ...syncManager,
      usesLeaseCoordinator: vi.fn((candidate) => candidate === leases),
    }
    const runtime = registerRoutes({
      fs: {
        realPath: vi.fn(async (path: string) => path),
        inspectEntry: vi.fn(async () => ({
          kind: 'directory' as const,
          identity: 'repo:/tmp/r',
          linkCount: 2,
        })),
      } as never,
      git: platformGit as never,
      proc: {} as never,
      home: '/tmp/injected-home',
      leases,
      sync: injectedSync as never,
      mcpDebug: {
        createSession: vi.fn(),
        callTool: vi.fn(),
        disconnect: vi.fn(),
      } as never,
    })
    platformGit.addOrUpdateRemote.mockClear()

    let responsePromise: Promise<Response> | undefined
    try {
      const pendingResponse = Promise.resolve(
        runtime.request('/sync/remote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: '/tmp/r', remoteUrl: 'https://example.com/next.git' }),
        }),
      )
      responsePromise = pendingResponse
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      expect(platformGit.addOrUpdateRemote).not.toHaveBeenCalled()

      releaseHolder()
      const response = await pendingResponse
      expect(response.status).toBe(200)
      expect(platformGit.addOrUpdateRemote).toHaveBeenCalledWith(
        '/tmp/r',
        'https://example.com/next.git',
      )
    } finally {
      releaseHolder()
      await holder
      await responsePromise?.catch(() => undefined)
      await runtime.dispose()
    }
  })

  it('POST /api/project passes only the requested scope to the projection workflow', async () => {
    vi.mocked(projectRepository).mockClear()
    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r', scope: 'skills', agent: 'opencode' }),
    })
    expect(res.status).toBe(200)
    expect((await responseJson<{ ok: boolean }>(res)).ok).toBe(true)
    expect(projectRepository).toHaveBeenCalledWith(
      expect.objectContaining({ fs: expect.any(Object), git: expect.any(Object) }),
      '/tmp/r',
      { scope: 'skills', agent: 'opencode' },
    )
  })
  it('POST /api/project serializes a safe projection failure message', async () => {
    vi.mocked(projectRepository).mockResolvedValueOnce({
      ok: false,
      failure: {
        failedStep: 'projection',
        originalError: new Error(
          'refuse to overwrite user-owned source namespace: /private/agent/skills/source',
        ),
        rollbackReport: { undone: 0, rollbackFailures: [] },
      },
    })

    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r', scope: 'skills', agent: 'opencode' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      message: '投影失败：目标位置存在非 Loom 管理的内容',
      failure: {
        failedStep: 'projection',
        originalError: {},
        rollbackReport: { undone: 0, rollbackFailures: [] },
      },
    })
  })
  it.each(['manifest', 'plan', 'varsCtx', 'installedAgents'])(
    'POST /api/project rejects caller-controlled %s input',
    async (field) => {
      vi.mocked(projectRepository).mockClear()

      const res = await app.request('/api/project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: '/tmp/r', [field]: {} }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(validationError('invalid_project_request'))
      expect(projectRepository).not.toHaveBeenCalled()
    },
  )
  it('POST /api/project rejects an unknown target agent', async () => {
    vi.mocked(projectRepository).mockClear()

    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r', scope: 'skills', agent: 'unknown' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_agent'))
    expect(projectRepository).not.toHaveBeenCalled()
  })
  it('POST /api/project rejects a missing repo before projection starts', async () => {
    vi.mocked(projectRepository).mockClear()

    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_repo'))
    expect(projectRepository).not.toHaveBeenCalled()
  })
  it('GET /api/manifest delegates to the fast display manifest workflow', async () => {
    const res = await app.request('/api/manifest?repo=/tmp/r')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skills: { sources: [], skills: [] } })
    expect(loadDisplayManifest).toHaveBeenCalledWith(
      expect.objectContaining({ fs: expect.any(Object), git: expect.any(Object) }),
      '/tmp/r',
    )
    expect(loadProjectionManifest).not.toHaveBeenCalled()
  })
  it('GET /api/skill/content rejects the legacy caller-controlled source shape', async () => {
    vi.mocked(loadDisplayManifest).mockClear()
    vi.mocked(loadProjectionManifest).mockClear()

    const res = await app.request(
      '/api/skill/content?repo=/tmp/r&skillId=skills--selected&sourceUrl=https%3A%2F%2Fexample.test%2Fskills.git',
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_skill_kind'))
    expect(loadDisplayManifest).not.toHaveBeenCalled()
    expect(loadProjectionManifest).not.toHaveBeenCalled()
  })
  it('POST /api/sync/pull returns PullResult', async () => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    const body = await responseJson<{ clean: boolean }>(res)
    expect(body.clean).toBe(true)
  })

  it('returns 503 when sync work starts after manager disposal', async () => {
    syncManager.pull.mockRejectedValueOnce(
      new SyncSessionError('manager_disposed', '同步会话管理器已关闭'),
    )

    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, error: 'manager_disposed' })
  })
  it('POST /api/sync/push delegates to the push workflow and returns its result', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    expect((await responseJson<{ ok: boolean }>(res)).ok).toBe(true)
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
    expect(syncManager.forcePull).toHaveBeenCalledWith('/tmp/r', expect.any(Function))
  })
  it('POST /api/sync/remote only updates origin and does not sync', async () => {
    vi.clearAllMocks()

    const res = await app.request('/api/sync/remote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r',
        remoteUrl: 'https://git.example.test/user/repo.git',
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      remoteUrl: 'https://git.example.test/user/repo.git',
    })
    expect(platformGit.addOrUpdateRemote).toHaveBeenCalledWith(
      '/tmp/r',
      'https://git.example.test/user/repo.git',
    )
    expect(syncPush).not.toHaveBeenCalled()
    expect(syncManager.pull).not.toHaveBeenCalled()
    expect(syncManager.forcePull).not.toHaveBeenCalled()
    expect(platformGit.status).not.toHaveBeenCalled()
    expect(platformGit.add).not.toHaveBeenCalled()
    expect(platformGit.commit).not.toHaveBeenCalled()
  })
  it('POST /api/sync/remote preserves origin while a sync session is active', async () => {
    vi.clearAllMocks()
    syncManager.getSession.mockResolvedValueOnce({ sessionId: 'active' } as never)

    const res = await app.request('/api/sync/remote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r',
        remoteUrl: 'https://git.example.test/user/repo.git',
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, error: 'active_session_exists' })
    expect(platformGit.addOrUpdateRemote).not.toHaveBeenCalled()
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
  it('POST /api/sync/conflicts/save rejects missing path before touching the session', async () => {
    syncManager.saveConflict.mockClear()

    const res = await app.request('/api/sync/conflicts/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', result: 'resolved\n' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_path'))
    expect(syncManager.saveConflict).not.toHaveBeenCalled()
  })
  it('POST /api/sync/conflicts/save preserves typed unsupported conflict failures', async () => {
    syncManager.saveConflict.mockRejectedValueOnce(
      new SyncSessionError('unsupported_conflict_type', '该冲突文件类型不支持文本编辑'),
    )

    const res = await app.request('/api/sync/conflicts/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', path: 'linked', result: 'resolved\n' }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'unsupported_conflict_type',
      message: '该冲突文件类型不支持文本编辑',
    })
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
  it('GET /api/sync/session rejects missing repo query before session lookup', async () => {
    syncManager.getSession.mockClear()

    const res = await app.request('/api/sync/session')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_repo'))
    expect(syncManager.getSession).not.toHaveBeenCalled()
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
    const json = await responseJson<{ profiles: string[] }>(res)
    expect(json.profiles).toBeDefined()
    expect(Array.isArray(json.profiles)).toBe(true)
    expect(json.profiles).toContain('default')
  })
})
