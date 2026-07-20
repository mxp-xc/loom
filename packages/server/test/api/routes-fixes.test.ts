import { afterAll, describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import * as yaml from 'js-yaml'
import { registerRoutes } from '../../src/api/router'
import { deriveRepoId } from '@loom/core'
import type { ProjectionResult } from '../../src/projection/executor.js'
import type { PreparedSourceUpdate } from '../../src/remote/update.js'
import { responseJson, validationError } from '../helpers/http.js'

const logFns = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))
const projectRepositoryMock = vi.hoisted(() =>
  vi.fn<() => Promise<ProjectionResult>>(async () => ({ ok: true })),
)
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
  vi.fn<typeof import('../../src/remote/update.js').prepareSourceUpdate>(
    async (_git, fs, _source, _newRef, workspace) => {
      await fs.mkdir(`${workspace.candidateDir}/.git`, true)
      await fs.writeFile(`${workspace.candidateDir}/.git/HEAD`, 'ref: refs/heads/main\n')
      return {
        pinned_commit: 'next-commit',
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
              agents: ['codex'],
            },
          ],
          unchanged: [],
        },
      }
    },
  ),
)

const memFiles: Record<string, string> = {}
const memFileIdentities = new Map<string, string>()
const memDirectories = new Map<string, string>()
let memIdentity = 0

function normalizeMemPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '')
}

function memEntry(path: string) {
  const normalized = normalizeMemPath(path)
  if (normalized in memFiles) {
    let identity = memFileIdentities.get(normalized)
    if (!identity) {
      identity = `file:${++memIdentity}`
      memFileIdentities.set(normalized, identity)
    }
    return { kind: 'file' as const, identity, linkCount: 1 }
  }
  const explicitIdentity = memDirectories.get(normalized)
  if (explicitIdentity) return { kind: 'directory' as const, identity: explicitIdentity }
  const prefix = `${normalized}/`
  if (
    Object.keys(memFiles).some((candidate) => candidate.startsWith(prefix)) ||
    [...memDirectories.keys()].some((candidate) => candidate.startsWith(prefix))
  ) {
    return { kind: 'directory' as const, identity: `directory:${normalized}` }
  }
  return null
}

const memFs = {
  readFile: vi.fn(async (p: string) => {
    const n = normalizeMemPath(p)
    if (!(n in memFiles)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return memFiles[n]
  }),
  writeFile: vi.fn(async (p: string, c: string) => {
    const path = normalizeMemPath(p)
    memFiles[path] = c
    if (!memFileIdentities.has(path)) memFileIdentities.set(path, `file:${++memIdentity}`)
  }),
  writeFileExclusive: vi.fn(async (p: string, c: string) => {
    const path = normalizeMemPath(p)
    if (memEntry(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    memFiles[path] = c
    const identity = `file:${++memIdentity}`
    memFileIdentities.set(path, identity)
    return { kind: 'file' as const, identity, linkCount: 1 }
  }),
  exists: vi.fn(async (p: string) => memEntry(p) !== null),
  inspectEntry: vi.fn(async (p: string) => memEntry(p)),
  realPath: vi.fn(async (p: string) => normalizeMemPath(p)),
  readLink: vi.fn(async () => {
    throw Object.assign(new Error('not a link'), { code: 'EINVAL' })
  }),
  readDir: vi.fn(async (p: string) => {
    const root = normalizeMemPath(p)
    const prefix = `${root}/`
    return [
      ...new Set(
        [...Object.keys(memFiles), ...memDirectories.keys()]
          .filter((candidate) => candidate.startsWith(prefix))
          .map((candidate) => candidate.slice(prefix.length).split('/')[0])
          .filter(Boolean),
      ),
    ]
  }),
  mkdir: vi.fn(async (p: string, recursive = true) => {
    const normalized = normalizeMemPath(p)
    if (memEntry(normalized)) {
      if (!recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      return
    }
    memDirectories.set(normalized, `directory:${++memIdentity}`)
  }),
  copyDir: vi.fn(async (source: string, destination: string) => {
    const src = normalizeMemPath(source)
    const dest = normalizeMemPath(destination)
    memDirectories.set(dest, `directory:${++memIdentity}`)
    const prefix = `${src}/`
    for (const [path, content] of Object.entries(memFiles)) {
      if (path.startsWith(prefix)) {
        const copied = `${dest}/${path.slice(prefix.length)}`
        memFiles[copied] = content
        memFileIdentities.set(copied, `file:${++memIdentity}`)
      }
    }
  }),
  move: vi.fn(async (source: string, destination: string) => {
    moveMemEntry(source, destination, false)
  }),
  moveNoReplace: vi.fn(async (source: string, destination: string) => {
    moveMemEntry(source, destination, true)
    return memEntry(destination)!
  }),
  moveDirectoryAtomic: vi.fn(
    async (source: string, destination: string, expectedIdentity: string) => {
      const sourceEntry = memEntry(source)
      if (sourceEntry?.kind !== 'directory' || sourceEntry.identity !== expectedIdentity) {
        throw new Error(`Source directory identity changed before atomic move: ${source}`)
      }
      if (memEntry(destination)) {
        throw Object.assign(new Error(`Destination already exists: ${destination}`), {
          code: 'destination_exists',
        })
      }

      memDirectories.set(normalizeMemPath(source), sourceEntry.identity)
      moveMemEntry(source, destination, false)
      return memEntry(destination)!
    },
  ),
  removeDir: vi.fn(async (p: string) => {
    const normalized = normalizeMemPath(p)
    const prefix = `${normalized}/`
    memDirectories.delete(normalized)
    for (const path of [...memDirectories.keys()]) {
      if (path.startsWith(prefix)) memDirectories.delete(path)
    }
    for (const path of Object.keys(memFiles)) {
      if (path.startsWith(prefix)) {
        delete memFiles[path]
        memFileIdentities.delete(path)
      }
    }
  }),
  removeFile: vi.fn(async (p: string) => {
    const path = normalizeMemPath(p)
    delete memFiles[path]
    memFileIdentities.delete(path)
  }),
  removeEntryIfIdentity: vi.fn(async (p: string, expectedIdentity: string) => {
    const entry = memEntry(p)
    if (!entry || entry.identity !== expectedIdentity) throw new Error('identity changed')
    if (entry.kind === 'directory') await memFs.removeDir(p)
    else await memFs.removeFile(p)
  }),
  replaceFile: vi.fn(async (tempPath: string, targetPath: string) => {
    const temp = normalizeMemPath(tempPath)
    const target = normalizeMemPath(targetPath)
    memFiles[target] = memFiles[temp]
    const identity = memFileIdentities.get(temp)
    if (identity) memFileIdentities.set(target, identity)
    delete memFiles[temp]
    memFileIdentities.delete(temp)
  }),
}

function moveMemEntry(source: string, destination: string, noReplace: boolean): void {
  const src = normalizeMemPath(source)
  const dest = normalizeMemPath(destination)
  if (noReplace && memEntry(dest)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  const sourceDirectory = memDirectories.get(src)
  if (sourceDirectory) {
    memDirectories.delete(src)
    memDirectories.set(dest, noReplace ? `directory:${++memIdentity}` : sourceDirectory)
  }
  const prefix = `${src}/`
  for (const path of [...memDirectories.keys()]) {
    if (!path.startsWith(prefix)) continue
    const identity = memDirectories.get(path)!
    memDirectories.delete(path)
    memDirectories.set(`${dest}/${path.slice(prefix.length)}`, identity)
  }
  for (const [path, content] of Object.entries(memFiles)) {
    if (path === src) {
      const identity = memFileIdentities.get(path)
      delete memFiles[path]
      memFiles[dest] = content
      memFileIdentities.delete(path)
      if (identity) memFileIdentities.set(dest, identity)
    } else if (path.startsWith(prefix)) {
      const identity = memFileIdentities.get(path)
      const moved = `${dest}/${path.slice(prefix.length)}`
      delete memFiles[path]
      memFiles[moved] = content
      memFileIdentities.delete(path)
      if (identity) memFileIdentities.set(moved, identity)
    }
  }
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
vi.mock('../../src/sync/push.js', () => ({ syncPush: vi.fn(async () => ({ ok: true })) }))
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

const routes = registerRoutes()
const app = new Hono().route('/api', routes)

afterAll(async () => {
  await routes.dispose()
})

describe('routes file-init safety', () => {
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
    expect(await res.json()).toEqual(validationError('invalid_server'))
  })

  it('POST /api/skills/local works when skills.yaml does not exist', async () => {
    memFiles['/tmp/r1/assets/skills/test-skill/SKILL.md'] = '# Test skill'
    const res = await app.request('/api/skills/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r1', skill: { id: 'test-skill' } }),
    })
    expect(res.status).toBe(200)
    const body = await responseJson<{ ok: boolean }>(res)
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
    const body = await responseJson<{ ok: boolean }>(res)
    expect(body.ok).toBe(true)
  })
})

describe('reorder endpoints', () => {
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
  it('DELETE /api/mcp rejects a missing id with the existing invalid_id contract', async () => {
    const res = await app.request('/api/mcp', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r4' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_id'))
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
    const body = await responseJson<{ ok: boolean }>(res)
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
    const body = await responseJson<{ ok: boolean }>(res)
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
    const body = await responseJson<{ ok: boolean }>(res)
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r4/mcp.yaml']) as any
    expect(parsed).toHaveLength(0)
  })
})

describe('local skill import', () => {
  it('POST /api/skills/local/import rejects a non-array skills field', async () => {
    const res = await app.request('/api/skills/local/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r7', mode: 'ref', skills: null }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_skills'))
  })
})

describe('source scan', () => {
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
    expect((await responseJson<{ ok: boolean }>(res)).ok).toBe(false)
  })

  it('POST /api/sources/tree reads the pinned tree from cache without remote git operations', async () => {
    const repo = '/tmp/cached-source'
    memFiles[`${repo}/skills.yaml`] = [
      'sources:',
      '  - url: https://github.com/obra/superpowers',
      '    ref: main',
      '    pinned_commit: pinned-commit',
      'skills: []',
      '',
    ].join('\n')
    memDirectories.set(`${repo}/remote-cache/superpowers/.git`, `directory:${++memIdentity}`)
    memFiles[`${repo}/remote-cache/superpowers/.git/HEAD`] = 'ref: refs/heads/main\n'
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
    const repo = '/tmp/missing-cached-source'
    memFiles[`${repo}/skills.yaml`] = [
      'sources:',
      '  - url: https://github.com/obra/superpowers',
      '    ref: main',
      '    pinned_commit: pinned-commit',
      'skills: []',
      '',
    ].join('\n')
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

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'scan_failed',
      message: 'failed to scan source',
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

    expect(res.status).toBe(500)
    expect((await responseJson<{ error: string }>(res)).error).toBe('refs_failed')
    expect(logFns.error).toHaveBeenCalledWith(
      'source refs failed',
      expect.objectContaining({ err: expect.any(TypeError) }),
    )
  })
})

describe('source updates', () => {
  it('requires explicit confirmation when an update creates a resource bundle boundary', async () => {
    memFiles['/tmp/source-boundary/skills.yaml'] = [
      'sources:',
      '  - url: https://github.com/mattpocock/skills',
      '    ref: main',
      '    pinned_commit: old-commit',
      '    members:',
      '      - name: old-skill',
      '        entry: skills/old-skill/SKILL.md',
      '        agents: [codex]',
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
          members: [{ name: 'old-skill', entry: 'skills/old-skill/SKILL.md', agents: ['codex'] }],
          resources: {
            include: [{ path: 'shared', kind: 'directory' }],
            exclude: [],
          },
        },
        newRef: 'main',
      }),
    })
    const preview = (await prepared.json()) as any
    memDirectories.set(
      `/tmp/source-boundary/temp/source-updates/${preview.sessionId}/candidate/.git`,
      `directory:${++memIdentity}`,
    )
    memFiles[`/tmp/source-boundary/temp/source-updates/${preview.sessionId}/candidate/.git/HEAD`] =
      'ref: refs/heads/main\n'
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
    expect((await responseJson<{ error: string }>(blocked)).error).toBe(
      'resource_boundary_confirmation_required',
    )

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
    expect((await responseJson<{ ok: boolean }>(accepted)).ok).toBe(true)
    expect(
      (yaml.load(memFiles['/tmp/source-boundary/skills.yaml']) as any).sources[0].members,
    ).toEqual([{ name: 'new-skill', entry: 'shared/new-skill/SKILL.md' }])
  })

  it('preserves agent edits made after update prepare when finalize writes members', async () => {
    memFiles['/tmp/source-concurrent/skills.yaml'] = [
      'sources:',
      '  - url: https://github.com/mattpocock/skills',
      '    ref: main',
      '    members:',
      '      - name: retained',
      '        entry: skills/retained/SKILL.md',
      '        agents: [codex]',
      'skills: []',
      '',
    ].join('\n')
    prepareSourceUpdateMock.mockResolvedValueOnce({
      pinned_commit: 'next-commit',
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
              agents: ['codex'],
            },
          ],
        },
        newRef: 'main',
      }),
    })
    const { sessionId } = (await prepared.json()) as { sessionId: string }
    memDirectories.set(
      `/tmp/source-concurrent/temp/source-updates/${sessionId}/candidate/.git`,
      `directory:${++memIdentity}`,
    )
    memFiles[`/tmp/source-concurrent/temp/source-updates/${sessionId}/candidate/.git/HEAD`] =
      'ref: refs/heads/main\n'
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

    expect((await responseJson<{ ok: boolean }>(finalized)).ok).toBe(true)
    expect(
      (yaml.load(memFiles['/tmp/source-concurrent/skills.yaml']) as any).sources[0].members,
    ).toEqual([
      {
        name: 'retained',
        entry: 'skills/retained/SKILL.md',
        agents: ['opencode'],
      },
    ])
  })

  it('installs preserved members from pinned Git blobs through the local transaction', async () => {
    const repo = '/tmp/source-preserve-transaction'
    const sourceUrl = 'https://github.com/mattpocock/skills'
    const cache = `${repo}/remote-cache/${deriveRepoId(sourceUrl)}`
    memFiles[`${repo}/skills.yaml`] = [
      'sources:',
      `  - url: ${sourceUrl}`,
      '    ref: main',
      '    pinned_commit: abcdef1',
      '    members:',
      '      - name: old-skill',
      '        entry: skills/old-skill/SKILL.md',
      '        agents: [codex]',
      'skills: []',
      '',
    ].join('\n')
    memDirectories.set(cache, `directory:${++memIdentity}`)
    memDirectories.set(`${cache}/.git`, `directory:${++memIdentity}`)
    memFiles[`${cache}/.git/HEAD`] = 'ref: refs/heads/main\n'
    platformGit.readTree.mockResolvedValueOnce([
      { mode: '040000', type: 'tree', oid: 'skills-tree', path: 'skills' },
      {
        mode: '040000',
        type: 'tree',
        oid: 'old-skill-tree',
        path: 'skills/old-skill',
      },
      {
        mode: '100644',
        type: 'blob',
        oid: 'old-skill-file',
        path: 'skills/old-skill/SKILL.md',
      },
    ])
    platformGit.show.mockResolvedValueOnce('# Old skill')

    const prepared = await app.request('/api/update/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo,
        source: { url: sourceUrl, ref: 'forged' },
        newRef: 'next',
      }),
    })
    const { sessionId } = (await prepared.json()) as { sessionId: string }
    const finalized = await app.request('/api/update/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, sessionId, preserve: ['old-skill'] }),
    })

    expect(finalized.status).toBe(200)
    expect(await finalized.json()).toMatchObject({ ok: true, preserved: ['old-skill'] })
    expect(memFiles[`${repo}/assets/skills/old-skill/SKILL.md`]).toBe('# Old skill')
    expect(
      JSON.parse(memFiles[`${repo}/assets/skills/old-skill/.loom-source-update-owner.json`]),
    ).toMatchObject({ version: 1, sessionId, skillId: 'old-skill' })
    expect((yaml.load(memFiles[`${repo}/skills.yaml`]) as any).skills).toEqual([
      { id: 'old-skill', agents: ['codex'] },
    ])
    expect(memFs.mkdir).toHaveBeenCalledWith(
      `${repo}/temp/source-updates/${sessionId}/preserve-transaction`,
      false,
    )
    expect(memFs.copyDir).not.toHaveBeenCalledWith(
      expect.stringContaining('/temp/source-updates/'),
      `${repo}/assets/skills/old-skill`,
    )
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
        '        agents: [codex]',
        'skills: []',
        '',
      ].join('\n')
      if (cacheDirectoryExists) {
        memDirectories.set(`${repo}/remote-cache/skills`, `directory:${++memIdentity}`)
      }
      projectRepositoryMock.mockClear()
      projectRepositoryMock.mockResolvedValue({ ok: true })
      projectRepositoryMock.mockResolvedValueOnce({
        ok: false,
        failure: {
          failedStep: 'projection',
          originalError: new Error('projection failed'),
          rollbackReport: { undone: 0, rollbackFailures: [] },
        },
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
                agents: ['codex'],
              },
            ],
          },
          newRef: 'main',
        }),
      })
      const { sessionId } = (await prepared.json()) as { sessionId: string }
      const finalizeBody = { repo, sessionId, preserve: [] }

      const failed = await app.request('/api/update/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(finalizeBody),
      })
      expect((await responseJson<{ ok: boolean }>(failed)).ok).toBe(false)
      expect(projectRepositoryMock).toHaveBeenCalledTimes(1)
      expect((yaml.load(memFiles[`${repo}/skills.yaml`]) as any).sources[0]).toMatchObject({
        pinned_commit: 'old-commit',
        members: [{ name: 'old-skill', entry: 'skills/old-skill/SKILL.md', agents: ['codex'] }],
      })

      const retried = await app.request('/api/update/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(finalizeBody),
      })
      expect((await responseJson<{ ok: boolean }>(retried)).ok).toBe(true)
      expect(projectRepositoryMock).toHaveBeenCalledTimes(2)
    },
  )
})

describe('source metadata', () => {
  it('POST /api/sources rejects a missing url with invalid_url', async () => {
    const res = await app.request('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r8', ref: 'main' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_url'))
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
    expect((await responseJson<{ ok: boolean }>(res)).ok).toBe(true)
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
})

describe('agents update', () => {
  it('POST /api/skills/source-agents keeps separate invalid field error codes', async () => {
    const res = await app.request('/api/skills/source-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/tmp/r5',
        sourceUrl: 'https://example.test/skills.git',
        updates: null,
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(validationError('invalid_updates'))
  })

  it('POST /api/mcp/agents updates agents for an mcp server', async () => {
    memFiles['/tmp/r5/mcp.yaml'] =
      '- id: srv1\n  type: stdio\n  command: echo\n  agents:\n    - claude-code\n'
    const res = await app.request('/api/mcp/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/tmp/r5', id: 'srv1', agents: ['claude-code', 'codex'] }),
    })
    expect(res.status).toBe(200)
    const body = await responseJson<{ ok: boolean }>(res)
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r5/mcp.yaml']) as any
    expect(parsed[0].agents).toEqual(['claude-code', 'codex'])
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
    expect((await responseJson<{ error: string }>(res)).error).toBe('invalid_server')
  })
})

describe('PUT /config', () => {
  it('PUT /api/config updates a repo-level config field', async () => {
    memFiles['/tmp/r6/config.yaml'] = 'profile: local\nagents:\n  - claude-code\n'
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
    const body = await responseJson<{ ok: boolean }>(res)
    expect(body.ok).toBe(true)
    const parsed = yaml.load(memFiles['/tmp/r6/config.yaml']) as any
    expect(parsed.profile).toBe('default')
  })
})
