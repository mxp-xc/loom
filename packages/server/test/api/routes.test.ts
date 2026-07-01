import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/routes'

vi.mock('../../src/projection/executor.js', () => ({
  executeProjection: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/sync/pull.js', () => ({
  syncPull: vi.fn(async () => ({ files: [], varsFiles: [], textConflicts: [], clean: true })),
}))
vi.mock('../../src/sync/push.js', () => ({ syncPush: vi.fn(async () => ({ ok: true })) }))
vi.mock('@loom/core', () => ({
  loadRepoManifest: vi.fn(() => ({ repoConfig: { targets: ['claude-code'] }, errors: [] })),
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

describe('API routes', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/project calls executeProjection, returns result', async () => {
    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: '/tmp/r',
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
      body: JSON.stringify({ repoPath: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clean).toBe(true)
  })
  it('POST /api/sync/push returns {ok}', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
  it('GET /api/config returns effective + repo + local config', async () => {
    const res = await app.request('/api/config?repoPath=/tmp/r')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('effective')
    expect(body).toHaveProperty('repo')
    expect(body).toHaveProperty('local')
  })
})
