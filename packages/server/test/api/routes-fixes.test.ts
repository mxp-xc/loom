import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import * as yaml from 'js-yaml'
import { registerRoutes } from '../../src/api/router'

const logFns = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))
const projectRepositoryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
const platformGit = vi.hoisted(() => ({
  clone: vi.fn(async () => {}),
  checkout: vi.fn(async () => {}),
  fetch: vi.fn(async () => {}),
  revParseHead: vi.fn(async () => 'installed-commit'),
  revParse: vi.fn(async (_repoPath: string, ref: string) =>
    ref.endsWith('^{tree}') ? 'root-tree' : 'installed-commit',
  ),
  readTree: vi.fn(async () => [
    { mode: '040000', type: 'tree' as const, oid: 'skills-tree', path: 'skills' },
    {
      mode: '040000',
      type: 'tree' as const,
      oid: 'review-tree',
      path: 'skills/review',
    },
    {
      mode: '100644',
      type: 'blob' as const,
      oid: 'review-skill',
      path: 'skills/review/SKILL.md',
    },
    { mode: '040000', type: 'tree' as const, oid: 'shared-tree', path: 'shared' },
    {
      mode: '100644',
      type: 'blob' as const,
      oid: 'private-resource',
      path: 'shared/private.md',
    },
  ]),
  show: vi.fn(async () => '# Review'),
  lsRemote: vi.fn(async () => {
    throw new TypeError('remote unavailable')
  }),
}))
const prepareSourceUpdateMock = vi.hoisted(() =>
  vi.fn(async () => ({
    pinned_commit: 'next-commit',
    stagingDir: '/tmp/source-update/temp/source-updates/staged',
    candidateDir: '/tmp/source-update/temp/source-updates/candidate',
    newMembers: [{ name: 'next-skill', entry: 'skills/next-skill/SKILL.md' }],
    resourceBoundaryChanges: [] as Array<{ name: string; entry: string; path: string }>,
    pathMoves: [],
    changes: {
      added: [{ name: 'next-skill' }],
      updated: [],
      removed: [
        {
          name: 'old-skill',
          previousPath: 'skills/old-skill/SKILL.md',
          targets: ['codex'],
        },
      ],
      unchanged: [],
    },
  })),
)

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
  copyDir: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async (p: string) => {
    delete memFiles[p.replace(/\\/g, '/')]
  }),
  replaceFile: vi.fn(async (tempPath: string, targetPath: string) => {
    const temp = tempPath.replace(/\\/g, '/')
    const target = targetPath.replace(/\\/g, '/')
    memFiles[target] = memFiles[temp]
    delete memFiles[temp]
  }),
}

vi.mock('../../src/projection/workflow.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/projection/workflow.js')>(
    '../../src/projection/workflow.js',
  )
  return { ...actual, projectRepository: projectRepositoryMock }
})

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
  createNodePlatform: vi.fn(() => ({
    fs: memFs,
    git: platformGit,
    proc: {},
  })),
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
  discoverSourceTree: vi.fn(async () => ({
    commit: 'commit-oid',
    nodes: [
      {
        kind: 'bundle',
        name: 'brainstorming',
        path: 'skills/brainstorming',
        entry: 'skills/brainstorming/SKILL.md',
        mode: '040000',
        oid: 'bundle-oid',
        description: 'desc',
      },
    ],
    diagnostics: [],
  })),
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
vi.mock('../../src/remote/update.js', () => ({
  checkUpdates: vi.fn(async () => []),
  prepareSourceUpdate: prepareSourceUpdateMock,
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

describe('reorder endpoints', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('normalizes Skills order without projection and maps duplicate or malformed entities', async () => {
    const repo = '/tmp/reorder-skills'
    memFiles[`${repo}/skills.yaml`] = [
      'sources:',
      '  - url: https://example.test/a',
      '    ref: main',
      '  - url: https://example.test/b',
      '    ref: main',
      'skills:',
      '  - id: local',
      '',
    ].join('\n')
    projectRepositoryMock.mockClear()

    const reordered = await app.request('/api/skills/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, ids: ['local', 'unknown', 'local'] }),
    })
    expect(await reordered.json()).toEqual({
      ok: true,
      ids: ['local', 'source:https://example.test/a', 'source:https://example.test/b'],
    })
    expect(projectRepositoryMock).not.toHaveBeenCalled()

    memFiles[`${repo}/skills.yaml`] =
      'sources:\n  - url: duplicate\n  - url: duplicate\nskills: []\n'
    expect(
      (
        await app.request('/api/skills/order', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo, ids: [] }),
        })
      ).status,
    ).toBe(409)

    memFiles[`${repo}/skills.yaml`] = 'sources: {}\nskills: []\n'
    expect(
      (
        await app.request('/api/skills/order', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo, ids: [] }),
        })
      ).status,
    ).toBe(422)
  })

  it('normalizes MCP order without projection and maps duplicate or malformed entities', async () => {
    const repo = '/tmp/reorder-mcp'
    memFiles[`${repo}/mcp.yaml`] =
      '- id: a\n  type: stdio\n  command: a\n- id: b\n  type: stdio\n  command: b\n'
    projectRepositoryMock.mockClear()

    const reordered = await app.request('/api/mcp/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, ids: ['b', 'missing', 'b'] }),
    })
    expect(await reordered.json()).toEqual({ ok: true, ids: ['b', 'a'] })
    expect(projectRepositoryMock).not.toHaveBeenCalled()

    memFiles[`${repo}/mcp.yaml`] =
      '- id: duplicate\n  type: stdio\n  command: a\n- id: duplicate\n  type: stdio\n  command: b\n'
    expect(
      (
        await app.request('/api/mcp/order', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo, ids: [] }),
        })
      ).status,
    ).toBe(409)

    memFiles[`${repo}/mcp.yaml`] = 'servers: []\n'
    expect(
      (
        await app.request('/api/mcp/order', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo, ids: [] }),
        })
      ).status,
    ).toBe(422)
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

  it('POST /api/sources/scan returns the source commit tree', async () => {
    const { discoverSourceTree } = await import('../../src/remote/discover.js')
    vi.mocked(discoverSourceTree).mockClear()
    const res = await app.request('/api/sources/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'custom-source',
        url: 'https://github.com/obra/superpowers',
        type: 'tag',
        ref: 'v1.0.1',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      commit: 'commit-oid',
      summary: { bundles: 1, containers: 0, resources: 0, symlinks: 0, submodules: 0 },
      diagnostics: [],
      tree: {
        commit: 'commit-oid',
        nodes: [{ kind: 'bundle', entry: 'skills/brainstorming/SKILL.md' }],
        diagnostics: [],
      },
    })
    expect(discoverSourceTree).toHaveBeenCalledWith(expect.anything(), {
      name: 'custom-source',
      url: 'https://github.com/obra/superpowers',
      type: 'tag',
      ref: 'v1.0.1',
    })
  })

  it('POST /api/sources/scan rejects the removed glob field', async () => {
    const res = await app.request('/api/sources/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/obra/superpowers',
        scan: '**/SKILL.md',
      }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()).ok).toBe(false)
  })

  it('POST /api/sources/tree reads the pinned tree from cache without remote git operations', async () => {
    const repo = '/tmp/cached-source'
    memFiles[`${repo}/remote-cache/superpowers/.git`] = 'gitdir'
    platformGit.clone.mockClear()
    platformGit.checkout.mockClear()
    platformGit.fetch.mockClear()
    platformGit.lsRemote.mockClear()
    platformGit.revParse.mockClear()
    platformGit.readTree.mockClear()
    platformGit.show.mockClear()

    const res = await app.request('/api/sources/tree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo,
        url: 'https://github.com/obra/superpowers',
        pinned_commit: 'pinned-commit',
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      commit: 'installed-commit',
      summary: { bundles: 1, containers: 2, resources: 1, symlinks: 0, submodules: 0 },
      diagnostics: [],
      tree: {
        commit: 'installed-commit',
        nodes: [
          {
            kind: 'container',
            path: 'shared',
            children: [{ kind: 'resource', path: 'shared/private.md' }],
          },
          {
            kind: 'container',
            path: 'skills',
            children: [{ kind: 'bundle', entry: 'skills/review/SKILL.md' }],
          },
        ],
      },
    })
    expect(platformGit.revParse).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]remote-cache[\\/]superpowers$/),
      'pinned-commit^{commit}',
    )
    expect(platformGit.clone).not.toHaveBeenCalled()
    expect(platformGit.checkout).not.toHaveBeenCalled()
    expect(platformGit.fetch).not.toHaveBeenCalled()
    expect(platformGit.lsRemote).not.toHaveBeenCalled()
  })

  it('POST /api/sources/tree reports a missing cache without starting git operations', async () => {
    platformGit.clone.mockClear()
    platformGit.checkout.mockClear()
    platformGit.fetch.mockClear()
    platformGit.lsRemote.mockClear()
    platformGit.revParse.mockClear()
    platformGit.readTree.mockClear()
    platformGit.show.mockClear()

    const res = await app.request('/api/sources/tree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/missing-cached-source',
        url: 'https://github.com/obra/superpowers',
        pinned_commit: 'pinned-commit',
      }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'source_cache_unavailable' })
    expect(platformGit.revParse).not.toHaveBeenCalled()
    expect(platformGit.readTree).not.toHaveBeenCalled()
    expect(platformGit.show).not.toHaveBeenCalled()
    expect(platformGit.clone).not.toHaveBeenCalled()
    expect(platformGit.checkout).not.toHaveBeenCalled()
    expect(platformGit.fetch).not.toHaveBeenCalled()
    expect(platformGit.lsRemote).not.toHaveBeenCalled()
  })

  it('POST /api/sources/scan logs scan failures', async () => {
    logFns.error.mockClear()
    const { discoverSourceTree } = await import('../../src/remote/discover.js')
    const err = new Error('scan exploded')
    vi.mocked(discoverSourceTree).mockRejectedValueOnce(err)

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

describe('source members', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/sources/members is not available', async () => {
    const res = await app.request('/api/sources/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/source-members' }),
    })

    expect(res.status).toBe(404)
  })
})

describe('source updates', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/install is not available', async () => {
    const res = await app.request('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/source-install' }),
    })

    expect(res.status).toBe(404)
  })

  it('POST /api/update/perform is not available', async () => {
    const res = await app.request('/api/update/perform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  it('requires explicit confirmation when an update creates a resource bundle boundary', async () => {
    memFiles['/tmp/source-boundary/skills.yaml'] = [
      'sources:',
      '  - url: https://github.com/mattpocock/skills',
      '    ref: main',
      '    pinned_commit: old-commit',
      '    members:',
      '      - name: old-skill',
      '        entry: skills/old-skill/SKILL.md',
      '        targets: [codex]',
      '    resources:',
      '      include:',
      '        - path: shared',
      '          kind: directory',
      '      exclude: []',
      'skills: []',
      '',
    ].join('\n')
    prepareSourceUpdateMock.mockResolvedValueOnce({
      pinned_commit: 'next-commit',
      stagingDir: '/tmp/source-boundary/temp/source-updates/staged',
      candidateDir: '/tmp/source-boundary/temp/source-updates/candidate',
      newMembers: [{ name: 'new-skill', entry: 'shared/new-skill/SKILL.md' }],
      resourceBoundaryChanges: [
        {
          name: 'new-skill',
          entry: 'shared/new-skill/SKILL.md',
          path: 'shared/new-skill',
        },
      ],
      pathMoves: [],
      changes: { added: [{ name: 'new-skill' }], updated: [], removed: [], unchanged: [] },
    })
    const prepared = await app.request('/api/update/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/source-boundary',
        source: {
          url: 'https://github.com/mattpocock/skills',
          ref: 'main',
          pinned_commit: 'old-commit',
          members: [{ name: 'old-skill', entry: 'skills/old-skill/SKILL.md', targets: ['codex'] }],
          resources: {
            include: [{ path: 'shared', kind: 'directory' }],
            exclude: [],
          },
        },
        newRef: 'main',
      }),
    })
    const preview = (await prepared.json()) as any
    expect(preview.resourceBoundaryChanges).toEqual([
      {
        name: 'new-skill',
        entry: 'shared/new-skill/SKILL.md',
        path: 'shared/new-skill',
      },
    ])

    const blocked = await app.request('/api/update/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/source-boundary',
        sessionId: preview.sessionId,
        preserve: [],
      }),
    })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error).toBe('resource_boundary_confirmation_required')

    const accepted = await app.request('/api/update/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/source-boundary',
        sessionId: preview.sessionId,
        preserve: [],
        resourceBoundaryDecisions: [{ entry: 'shared/new-skill/SKILL.md', action: 'enable' }],
      }),
    })
    expect((await accepted.json()).ok).toBe(true)
    expect(
      (yaml.load(memFiles['/tmp/source-boundary/skills.yaml']) as any).sources[0].members,
    ).toEqual([{ name: 'new-skill', entry: 'shared/new-skill/SKILL.md' }])
  })

  it('preserves target edits made after update prepare when finalize writes members', async () => {
    memFiles['/tmp/source-concurrent/skills.yaml'] = [
      'sources:',
      '  - url: https://github.com/mattpocock/skills',
      '    ref: main',
      '    members:',
      '      - name: retained',
      '        entry: skills/retained/SKILL.md',
      '        targets: [codex]',
      'skills: []',
      '',
    ].join('\n')
    prepareSourceUpdateMock.mockResolvedValueOnce({
      pinned_commit: 'next-commit',
      stagingDir: '/tmp/source-concurrent/temp/source-updates/staged',
      candidateDir: '/tmp/source-concurrent/temp/source-updates/candidate',
      newMembers: [{ name: 'retained', entry: 'skills/retained/SKILL.md' }],
      resourceBoundaryChanges: [],
      pathMoves: [],
      changes: { added: [], updated: [], removed: [], unchanged: [{ name: 'retained' }] },
    })
    const prepared = await app.request('/api/update/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/source-concurrent',
        source: {
          url: 'https://github.com/mattpocock/skills',
          ref: 'main',
          members: [
            {
              name: 'retained',
              entry: 'skills/retained/SKILL.md',
              targets: ['codex'],
            },
          ],
        },
        newRef: 'main',
      }),
    })
    const { sessionId } = (await prepared.json()) as { sessionId: string }
    memFiles['/tmp/source-concurrent/skills.yaml'] = memFiles[
      '/tmp/source-concurrent/skills.yaml'
    ].replace('[codex]', '[opencode]')

    const finalized = await app.request('/api/update/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/source-concurrent',
        sessionId,
        preserve: [],
        resourceBoundaryDecisions: [],
      }),
    })

    expect((await finalized.json()).ok).toBe(true)
    expect(
      (yaml.load(memFiles['/tmp/source-concurrent/skills.yaml']) as any).sources[0].members,
    ).toEqual([
      {
        name: 'retained',
        entry: 'skills/retained/SKILL.md',
        targets: ['opencode'],
      },
    ])
  })

  it.each([
    ['missing', false],
    ['corrupt', true],
  ])(
    'rolls back a repair update without reprojecting when the previous cache is %s',
    async (suffix, cacheDirectoryExists) => {
      const repo = `/tmp/source-update-${suffix}`
      memFiles[`${repo}/skills.yaml`] = [
        'sources:',
        '  - url: https://github.com/mattpocock/skills',
        '    ref: main',
        '    pinned_commit: old-commit',
        '    members:',
        '      - name: old-skill',
        '        entry: skills/old-skill/SKILL.md',
        '        targets: [codex]',
        'skills: []',
        '',
      ].join('\n')
      if (cacheDirectoryExists) memFiles[`${repo}/remote-cache/skills`] = 'corrupt cache'
      projectRepositoryMock.mockClear()
      projectRepositoryMock.mockResolvedValue({ ok: true })
      projectRepositoryMock.mockResolvedValueOnce({
        ok: false,
        failure: { originalError: new Error('projection failed') },
      })

      const prepared = await app.request('/api/update/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo,
          source: {
            url: 'https://github.com/mattpocock/skills',
            ref: 'main',
            pinned_commit: 'old-commit',
            members: [
              {
                name: 'old-skill',
                entry: 'skills/old-skill/SKILL.md',
                targets: ['codex'],
              },
            ],
          },
          newRef: 'main',
        }),
      })
      const { sessionId } = (await prepared.json()) as { sessionId: string }
      const finalizeBody = { repo, sessionId, preserve: ['old-skill'] }

      const failed = await app.request('/api/update/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(finalizeBody),
      })
      expect((await failed.json()).ok).toBe(false)
      expect(projectRepositoryMock).toHaveBeenCalledTimes(1)
      expect((yaml.load(memFiles[`${repo}/skills.yaml`]) as any).sources[0]).toMatchObject({
        pinned_commit: 'old-commit',
        members: [{ name: 'old-skill', entry: 'skills/old-skill/SKILL.md', targets: ['codex'] }],
      })

      const retried = await app.request('/api/update/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(finalizeBody),
      })
      expect((await retried.json()).ok).toBe(true)
      expect(projectRepositoryMock).toHaveBeenCalledTimes(2)
    },
  )
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

  it('POST /api/sources atomically stores selected bundles and resources', async () => {
    memFiles['/tmp/r8/skills.yaml'] = 'sources: []\nskills: []\n'

    const res = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r8',
        url: 'https://github.com/mattpocock/skills',
        type: 'tag',
        ref: 'v1.0.1',
        members: [{ name: 'review', entry: 'skills/review/SKILL.md' }],
        resources: {
          include: [{ path: 'shared', kind: 'directory' }],
          exclude: [{ path: 'shared/private.md', kind: 'file' }],
        },
      }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r8/skills.yaml']) as any
    expect(parsed.sources[0]).toMatchObject({
      name: 'skills',
      url: 'https://github.com/mattpocock/skills',
      type: 'tag',
      ref: 'v1.0.1',
      pinned_commit: 'installed-commit',
      members: [{ name: 'review', entry: 'skills/review/SKILL.md' }],
      resources: {
        include: [{ path: 'shared', kind: 'directory' }],
        exclude: [{ path: 'shared/private.md', kind: 'file' }],
      },
    })
  })

  it('POST /api/sources rejects the removed scan field', async () => {
    const res = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r8',
        url: 'https://github.com/mattpocock/skills',
        ref: 'main',
        scan: '**/SKILL.md',
      }),
    })

    expect(res.status).toBe(400)
  })

  it('POST /api/sources rejects invalid and duplicate source names with clear status codes', async () => {
    memFiles['/tmp/r8b/skills.yaml'] = [
      'sources:',
      '  - name: openai-skills',
      '    url: https://example.test/skills.git',
      '    ref: main',
      'skills: []',
      '',
    ].join('\n')

    const invalid = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r8b',
        name: 'bad/name',
        url: 'https://example.test/other.git',
        ref: 'main',
      }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, error: 'invalid_source_name' })

    const duplicate = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r8b',
        name: 'openai-skills',
        url: 'https://example.test/other.git',
        ref: 'main',
      }),
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ ok: false, error: 'source_name_exists' })
  })

  it('POST /api/sources/update is not available', async () => {
    const res = await app.request('/api/sources/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r9' }),
    })

    expect(res.status).toBe(404)
  })
})

describe('targets update', () => {
  const app = new Hono().route('/api', registerRoutes())

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
