import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/router.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { ResourceLeaseCoordinator } from '../../src/concurrency/resource-lease-coordinator.js'

const logFns = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: vi.fn(() => logFns),
    error: logFns.error,
    warn: logFns.warn,
    info: logFns.info,
  },
}))

class TrackingFileSystem extends NodeFileSystem {
  readonly mutations: string[] = []

  override async writeFile(path: string, _content: string): Promise<void> {
    this.mutations.push(`writeFile:${path}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async mkdir(path: string, _recursive = true): Promise<void> {
    this.mutations.push(`mkdir:${path}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async copyDir(source: string, destination: string): Promise<void> {
    this.mutations.push(`copyDir:${source}:${destination}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async copyFile(source: string, destination: string): Promise<void> {
    this.mutations.push(`copyFile:${source}:${destination}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async move(source: string, destination: string): Promise<void> {
    this.mutations.push(`move:${source}:${destination}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async removeDir(path: string): Promise<void> {
    this.mutations.push(`removeDir:${path}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async replaceFile(source: string, destination: string): Promise<void> {
    this.mutations.push(`replaceFile:${source}:${destination}`)
    throw new Error('unexpected filesystem mutation')
  }

  override async removeFile(path: string): Promise<void> {
    this.mutations.push(`removeFile:${path}`)
    throw new Error('unexpected filesystem mutation')
  }
}

interface RouteCase {
  name: string
  request(repo: string): { path: string; init?: RequestInit }
}

const routeCases: RouteCase[] = [
  {
    name: 'config read',
    request: (repo) => ({ path: `/api/config?repo=${repo}` }),
  },
  {
    name: 'config mutation',
    request: (repo) =>
      jsonRequest('/api/config', { repo, level: 'repo', field: 'label', value: 'demo' }, 'PUT'),
  },
  {
    name: 'projection mutation',
    request: (repo) => jsonRequest('/api/project', { repo, scope: 'skills' }),
  },
  {
    name: 'skills mutation',
    request: (repo) => jsonRequest('/api/skills/local', { repo, skill: { id: 'example' } }),
  },
  {
    name: 'skills scan read',
    request: (repo) => jsonRequest('/api/skills/local/scan', { repo, dir: '/skills' }),
  },
  {
    name: 'MCP mutation',
    request: (repo) =>
      jsonRequest('/api/mcp', {
        repo,
        server: { id: 'example', type: 'stdio', command: 'node' },
      }),
  },
  {
    name: 'MCP import read',
    request: (repo) => jsonRequest('/api/mcp/import/scan', { repo, sources: [] }),
  },
  {
    name: 'MCP import mutation',
    request: (repo) => jsonRequest('/api/mcp/import/apply', { repo, sources: [], keys: [] }),
  },
  {
    name: 'MCP debug read',
    request: (repo) =>
      jsonRequest('/api/mcp/debug/sessions', {
        repo,
        source: 'draft',
        previewAgent: 'codex',
        draft: { id: 'example', type: 'http', url: 'https://example.test/mcp' },
      }),
  },
  {
    name: 'memory read',
    request: (repo) => ({ path: `/api/memory?repo=${repo}` }),
  },
  {
    name: 'memory mutation',
    request: (repo) => jsonRequest('/api/memory', { repo, name: 'example' }),
  },
  {
    name: 'source update mutation',
    request: (repo) =>
      jsonRequest('/api/update/prepare', {
        repo,
        source: { url: 'https://example.test/source.git', ref: 'main', members: [] },
        newRef: 'main',
      }),
  },
  {
    name: 'source cache read',
    request: (repo) =>
      jsonRequest('/api/sources/tree', {
        repo,
        url: 'https://example.test/source.git',
        pinned_commit: 'commit',
      }),
  },
  {
    name: 'sync read',
    request: (repo) => ({ path: `/api/sync/session?repo=${repo}` }),
  },
  {
    name: 'sync mutation',
    request: (repo) => jsonRequest('/api/sync/pull', { repo }),
  },
  {
    name: 'sync remote mutation',
    request: (repo) =>
      jsonRequest('/api/sync/remote', { repo, remoteUrl: 'https://example.test/repo.git' }),
  },
  {
    name: 'sync remote read',
    request: (repo) => ({ path: `/api/sync/remote?repo=${repo}` }),
  },
  {
    name: 'Vars read',
    request: (repo) => ({ path: `/api/vars/environments?repoPath=${repo}` }),
  },
  {
    name: 'Vars mutation',
    request: (repo) =>
      jsonRequest('/api/vars/environments', { repoPath: repo, environment: 'dev' }),
  },
]

let roots: string[]

beforeEach(() => {
  roots = []
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('repository authorization route contract', () => {
  it('maps a linked managed root to repo_unavailable before downstream work', async () => {
    const home = await createHome('linked')
    const { app, fs, git, sync, mcpDebug } = createTestApp(home)

    const status = await app.request('/api/status')
    await expectRepositoryFailure(status, 500, 'repo_unavailable', 'repository is unavailable')

    for (const routeCase of routeCases) {
      const { path, init } = routeCase.request('default')
      const response = await app.request(path, init)
      await expectRepositoryFailure(response, 500, 'repo_unavailable', 'repository is unavailable')
    }

    expect(fs.mutations).toEqual([])
    expect(git.addOrUpdateRemote).not.toHaveBeenCalled()
    expect(git.getRemoteUrl).not.toHaveBeenCalled()
    expect(sync.pull).not.toHaveBeenCalled()
    expect(sync.getSession).not.toHaveBeenCalled()
    expect(mcpDebug.createSession).not.toHaveBeenCalled()
    expect(logFns.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err: expect.any(Error) }),
    )
  })

  it('maps an unknown repository to invalid_repo before downstream work', async () => {
    const home = await createHome('physical')
    const { app, fs, git, sync, mcpDebug } = createTestApp(home)

    for (const routeCase of routeCases) {
      const { path, init } = routeCase.request('missing')
      const response = await app.request(path, init)
      await expectRepositoryFailure(response, 400, 'invalid_repo', 'invalid repository')
    }

    expect(fs.mutations).toEqual([])
    expect(git.addOrUpdateRemote).not.toHaveBeenCalled()
    expect(git.getRemoteUrl).not.toHaveBeenCalled()
    expect(sync.pull).not.toHaveBeenCalled()
    expect(sync.getSession).not.toHaveBeenCalled()
    expect(mcpDebug.createSession).not.toHaveBeenCalled()
  })
})

function jsonRequest(
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' | 'DELETE' = 'POST',
): { path: string; init: RequestInit } {
  return {
    path,
    init: {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  }
}

async function createHome(kind: 'linked' | 'physical'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'loom-repository-routes-'))
  roots.push(home)
  if (kind === 'physical') {
    await mkdir(join(home, '.loom', 'repos', 'default'), { recursive: true })
    return home
  }

  const outside = join(home, 'outside-loom')
  await mkdir(join(outside, 'repos', 'default'), { recursive: true })
  await symlink(outside, join(home, '.loom'), process.platform === 'win32' ? 'junction' : 'dir')
  return home
}

function createTestApp(home: string) {
  const fs = new TrackingFileSystem()
  const leases = new ResourceLeaseCoordinator(async () => async () => undefined)
  const git = {
    addOrUpdateRemote: vi.fn(async () => {}),
    getRemoteUrl: vi.fn(async () => null),
  }
  const sync = {
    recover: vi.fn(async () => {}),
    startMaintenance: vi.fn(),
    pull: vi.fn(async () => ({ clean: true, conflicts: [] })),
    getSession: vi.fn(async () => undefined),
    saveConflict: vi.fn(),
    abort: vi.fn(),
    forcePull: vi.fn(),
    usesLeaseCoordinator: vi.fn((candidate) => candidate === leases),
  }
  const mcpDebug = {
    createSession: vi.fn(),
    callTool: vi.fn(),
    disconnect: vi.fn(),
  }
  const app = new Hono().route(
    '/api',
    registerRoutes({
      fs,
      git: git as never,
      proc: {} as never,
      home,
      leases,
      sync: sync as never,
      mcpDebug,
    }),
  )
  return { app, fs, git, sync, mcpDebug }
}

async function expectRepositoryFailure(
  response: Response,
  status: 400 | 500,
  code: 'invalid_repo' | 'repo_unavailable',
  message: string,
): Promise<void> {
  expect(response.status).toBe(status)
  const body = (await response.json()) as {
    error: string | { code: string; message: string }
    message?: string
  }
  if (typeof body.error === 'string') {
    expect(body).toMatchObject({ ok: false, error: code, message })
  } else {
    expect(body.error).toEqual({ code, message })
  }
}
