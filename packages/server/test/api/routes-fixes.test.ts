import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import * as yaml from 'js-yaml'
import { registerRoutes } from '../../src/api/router'

const logFns = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))

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
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: vi.fn(() => logFns),
    error: logFns.error,
    warn: logFns.warn,
    info: logFns.info,
  },
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
      path: 'skills/brainstorming/SKILL.md',
      installed: false,
    },
    {
      name: 'test-driven-development',
      description: 'desc2',
      path: 'skills/tdd/SKILL.md',
      installed: true,
    },
  ]),
}))

describe('routes file-init safety', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/mcp rejects an invalid server body with invalid_server', async () => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r1',
        server: { id: 'broken', type: 'stdio' },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_server' })
  })

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

  it('DELETE /api/mcp rejects a missing id with the existing invalid_id contract', async () => {
    const res = await app.request('/api/mcp', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r4' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_id' })
  })

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

describe('local skill import', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/skills/local/import rejects a non-array skills field', async () => {
    const res = await app.request('/api/skills/local/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r7', mode: 'ref', skills: null }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_skills' })
  })

  it('stores repo assets skills imports as built-in local skills without ref paths', async () => {
    memFiles['/tmp/r7/skills.yaml'] = 'sources: []\nskills: []\n'

    const res = await app.request('/api/skills/local/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r7',
        mode: 'ref',
        skills: [{ name: 'test-qa-skill', path: '/tmp/r7/assets/skills/test-qa-skill' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, count: 1 })
    const parsed = yaml.load(memFiles['/tmp/r7/skills.yaml']) as any
    expect(parsed.skills).toEqual([{ id: 'test-qa-skill' }])
  })
})

describe('source scan', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/sources/scan returns discovered members', async () => {
    const { discoverSkills } = await import('../../src/remote/discover.js')
    vi.mocked(discoverSkills).mockClear()
    const res = await app.request('/api/sources/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/obra/superpowers',
        type: 'tag',
        ref: 'v1.0.1',
        scan: 'skills/engineering/**/SKILL.md',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members).toHaveLength(2)
    expect(body.members[0].name).toBe('brainstorming')
    expect(discoverSkills).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      url: 'https://github.com/obra/superpowers',
      type: 'tag',
      ref: 'v1.0.1',
      scan: 'skills/engineering/**/SKILL.md',
    })
  })

  it('POST /api/sources/scan logs scan failures', async () => {
    logFns.error.mockClear()
    const { discoverSkills } = await import('../../src/remote/discover.js')
    const err = new Error('scan exploded')
    vi.mocked(discoverSkills).mockRejectedValueOnce(err)

    const res = await app.request('/api/sources/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/obra/superpowers' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'scan_failed',
      message: 'scan exploded',
    })
    expect(logFns.error).toHaveBeenCalledWith('source scan failed', { err })
  })

  it('POST /api/sources/refs logs refs failures', async () => {
    logFns.error.mockClear()
    const res = await app.request('/api/sources/refs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/obra/superpowers' }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe('refs_failed')
    expect(logFns.error).toHaveBeenCalledWith(
      'source refs failed',
      expect.objectContaining({ err: expect.any(TypeError) }),
    )
  })
})

describe('source metadata', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/sources rejects a missing url with invalid_url', async () => {
    const res = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r8', ref: 'main' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_url' })
  })

  it('POST /api/sources stores type and custom scan pattern', async () => {
    memFiles['/tmp/r8/skills.yaml'] = 'sources: []\nskills: []\n'

    const res = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r8',
        url: 'https://github.com/mattpocock/skills',
        type: 'tag',
        ref: 'v1.0.1',
        scan: 'skills/engineering/**/SKILL.md',
      }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r8/skills.yaml']) as any
    expect(parsed.sources[0]).toMatchObject({
      url: 'https://github.com/mattpocock/skills',
      type: 'tag',
      ref: 'v1.0.1',
      scan: 'skills/engineering/**/SKILL.md',
    })
  })

  it('POST /api/sources/update updates ref/type and clears empty scan', async () => {
    memFiles['/tmp/r9/skills.yaml'] = [
      'sources:',
      '  - url: https://github.com/mattpocock/skills',
      '    type: tag',
      '    ref: v1.0.1',
      '    scan: skills/engineering/**/SKILL.md',
      'skills: []',
      '',
    ].join('\n')

    const res = await app.request('/api/sources/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r9',
        url: 'https://github.com/mattpocock/skills',
        type: 'branch',
        ref: 'main',
        scan: '',
      }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r9/skills.yaml']) as any
    expect(parsed.sources[0]).toEqual({
      url: 'https://github.com/mattpocock/skills',
      type: 'branch',
      ref: 'main',
    })
  })
})

describe('targets update', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/sources/members accepts selected member names', async () => {
    memFiles['/tmp/r10/skills.yaml'] = [
      'sources:',
      '  - url: https://example.test/skills.git',
      '    ref: main',
      '    members:',
      '      - name: alpha',
      '        targets:',
      '          - codex',
      'skills: []',
      '',
    ].join('\n')

    const res = await app.request('/api/sources/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r10',
        url: 'https://example.test/skills.git',
        members: ['alpha', 'beta'],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const parsed = yaml.load(memFiles['/tmp/r10/skills.yaml']) as any
    expect(parsed.sources[0].members).toEqual([
      { name: 'alpha', targets: ['codex'] },
      { name: 'beta' },
    ])
  })

  it('POST /api/skills/source-targets keeps separate invalid field error codes', async () => {
    const res = await app.request('/api/skills/source-targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r5',
        sourceUrl: 'https://example.test/skills.git',
        updates: null,
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_updates' })
  })

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
