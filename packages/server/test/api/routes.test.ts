import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/router'

vi.mock('../../src/projection/executor.js', () => ({
  executeProjection: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/sync/session-manager.js', () => ({
  SyncSessionError: class SyncSessionError extends Error {},
  SyncSessionManager: class SyncSessionManager {
    pull = vi.fn(async () => ({ conflicts: [], clean: true }))
    getSession = vi.fn(async () => null)
    saveConflict = vi.fn(async () => ({ clean: true, remaining: [] }))
    abort = vi.fn(async () => undefined)
    recover = vi.fn(async () => undefined)
    startMaintenance = vi.fn(() => () => undefined)
  },
}))
vi.mock('../../src/sync/push.js', () => ({ syncPush: vi.fn(async () => ({ ok: true })) }))
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
    fs: {},
    git: { status: vi.fn(async () => ({ dirty: false })), add: vi.fn(), commit: vi.fn() },
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
  it('POST /api/sync/push returns {ok}', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
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
