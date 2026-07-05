import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import * as yaml from 'js-yaml'
import { registerRoutes } from '../../src/api/router'

const memFiles: Record<string, string> = {}

const memFs = {
  readFile: vi.fn(async (p: string) => {
    const n = p.replace(/\\/g, '/')
    if (!(n in memFiles)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return memFiles[n]
  }),
  writeFile: vi.fn(async (p: string, c: string) => {
    memFiles[p.replace(/\\/g, '/')] = c
  }),
  exists: vi.fn(async (p: string) => p.replace(/\\/g, '/') in memFiles),
  readDir: vi.fn(async () => []),
  mkdir: vi.fn(async () => {}),
}

vi.mock('../../src/projection/executor.js', () => ({
  executeProjection: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/sync/pull.js', () => ({
  syncPull: vi.fn(async () => ({ files: [], varsFiles: [], textConflicts: [], clean: true })),
}))
vi.mock('../../src/sync/push.js', () => ({ syncPush: vi.fn(async () => ({ ok: true })) }))
vi.mock('@loom/core', async () => {
  const actual = await vi.importActual<typeof import('@loom/core')>('@loom/core')
  return {
    ...actual,
    loadRepoManifest: vi.fn(() => ({ repoConfig: {}, errors: [] })),
    mergeConfig: vi.fn((repo: Record<string, unknown>) => ({ ...repo })),
    buildManifest: vi.fn(),
    planProjection: vi.fn(),
  }
})
vi.mock('../../src/platform/node/index.js', () => ({
  createNodePlatform: vi.fn(() => ({ fs: memFs, git: {}, proc: {} })),
}))
vi.mock('../../src/platform/node/init.js', () => ({ initLoom: vi.fn() }))
vi.mock('../../src/api/repo.js', () => ({
  resolveRepoPath: vi.fn(async (_fs: unknown, repo: string) => repo),
  listRepos: vi.fn(async () => []),
}))
vi.mock('../../src/remote/discover.js', () => ({
  discoverSkills: vi.fn(async () => [
    {
      name: 'brainstorming',
      description: 'desc',
      path: '/tmp/skills/brainstorming',
      installed: false,
    },
    {
      name: 'test-driven-development',
      description: 'desc2',
      path: '/tmp/skills/tdd',
      installed: true,
    },
  ]),
}))

describe('routes file-init safety', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/skills/local works when skills.yaml does not exist', async () => {
    const res = await app.request('/api/skills/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r1', skill: { id: 'test-skill' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('POST /api/mcp works when mcp.yaml does not exist', async () => {
    delete memFiles['/tmp/r1/mcp.yaml']
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r1',
        server: { id: 'test', type: 'stdio', command: 'echo' },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

describe('DELETE endpoints', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('DELETE /api/sources removes a source by url', async () => {
    memFiles['/tmp/r2/skills.yaml'] =
      'sources:\n  - url: https://github.com/test/repo\n    ref: main\nskills: []\n'
    const res = await app.request('/api/sources', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r2', url: 'https://github.com/test/repo' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r2/skills.yaml']) as any
    expect(parsed.sources).toHaveLength(0)
  })

  it('DELETE /api/skills/local removes a local skill by id', async () => {
    memFiles['/tmp/r3/skills.yaml'] = 'sources: []\nskills:\n  - id: test-skill\n'
    const res = await app.request('/api/skills/local', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r3', id: 'test-skill' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r3/skills.yaml']) as any
    expect(parsed.skills).toHaveLength(0)
  })

  it('DELETE /api/mcp removes a server by id', async () => {
    memFiles['/tmp/r4/mcp.yaml'] = '- id: test\n  type: stdio\n  command: echo\n'
    const res = await app.request('/api/mcp', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r4', id: 'test' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r4/mcp.yaml']) as any
    expect(parsed).toHaveLength(0)
  })
})

describe('source scan', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/sources/scan returns discovered members', async () => {
    const res = await app.request('/api/sources/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/obra/superpowers' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members).toHaveLength(2)
    expect(body.members[0].name).toBe('brainstorming')
  })
})

describe('targets update', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/mcp/targets updates targets for an mcp server', async () => {
    memFiles['/tmp/r5/mcp.yaml'] =
      '- id: srv1\n  type: stdio\n  command: echo\n  targets:\n    - claude-code\n'
    const res = await app.request('/api/mcp/targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r5', id: 'srv1', targets: ['claude-code', 'codex'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r5/mcp.yaml']) as any
    expect(parsed[0].targets).toEqual(['claude-code', 'codex'])
  })

  it('PUT /api/mcp updates an existing server without changing its id', async () => {
    memFiles['/tmp/r5/mcp.yaml'] = '- id: srv1\n  type: stdio\n  command: echo\n'
    const res = await app.request('/api/mcp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r5',
        id: 'srv1',
        server: { id: 'srv1', type: 'http', url: 'https://example.test/mcp' },
      }),
    })

    expect(res.status).toBe(200)
    const parsed = yaml.load(memFiles['/tmp/r5/mcp.yaml']) as any
    expect(parsed).toEqual([{ id: 'srv1', type: 'http', url: 'https://example.test/mcp' }])
  })

  it('PUT /api/mcp rejects stdio servers without a command', async () => {
    memFiles['/tmp/r5/mcp.yaml'] = '- id: srv1\n  type: stdio\n  command: echo\n'
    const res = await app.request('/api/mcp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r5', id: 'srv1', server: { type: 'stdio' } }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_server')
  })
})

describe('PUT /config', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('PUT /api/config updates a repo-level config field', async () => {
    memFiles['/tmp/r6/config.yaml'] = 'profile: local\ntargets:\n  - claude-code\n'
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r6',
        level: 'repo',
        field: 'profile',
        value: 'default',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r6/config.yaml']) as any
    expect(parsed.profile).toBe('default')
  })
})
