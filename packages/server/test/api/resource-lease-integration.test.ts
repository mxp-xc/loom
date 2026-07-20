import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createConfigRoutes } from '../../src/api/routes/config.js'
import { createHealthRoutes } from '../../src/api/routes/health.js'
import {
  createMcpDebugRoutes,
  type McpDebugSessionManagerLike,
} from '../../src/api/routes/mcp-debug.js'
import { createMcpImportRoutes } from '../../src/api/routes/mcp-import.js'
import { createMemoryRoutes } from '../../src/api/routes/memory.js'
import { createProjectionRoutes } from '../../src/api/routes/projection.js'
import { createVarsRoutes } from '../../src/api/routes/vars.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { readRepoConfig } from '../../src/api/repo-config.js'
import {
  ResourceLeaseCoordinator,
  resourceLeases,
  type HeldResourceLease,
  type ResourceLeaseRequest,
} from '../../src/concurrency/resource-lease-coordinator.js'
import { projectionResourceKeys } from '../../src/concurrency/resource-keys.js'

class RecordingCoordinator extends ResourceLeaseCoordinator {
  readonly acquired: ResourceLeaseRequest[][] = []

  constructor(private readonly beforeOperation?: () => Promise<void>) {
    super(async () => async () => undefined)
  }

  override run<T>(
    requests: readonly ResourceLeaseRequest[],
    operation: (lease: HeldResourceLease) => Promise<T>,
  ): Promise<T> {
    this.acquired.push([...requests])
    return super.run(requests, async (lease) => {
      await this.beforeOperation?.()
      return operation(lease)
    })
  }
}

async function createHomeRepository(home: string, profile: string): Promise<void> {
  const repoPath = join(home, '.loom', 'repos', 'default')
  await mkdir(join(repoPath, 'assets', 'skills', 'demo'), { recursive: true })
  await writeFile(join(home, '.loom', 'config.yaml'), `active_repo: default\nprofile: ${profile}\n`)
  await writeFile(join(repoPath, 'config.yaml'), 'agents: [codex]\n')
  await writeFile(
    join(repoPath, 'skills.yaml'),
    'sources: []\nskills:\n  - id: demo\n    agents: [codex]\n',
  )
  await writeFile(join(repoPath, 'mcp.yaml'), '[]\n')
  await writeFile(join(repoPath, 'assets', 'skills', 'demo', 'SKILL.md'), '# Demo\n')
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

async function retargetDirectoryLink(target: string, path: string): Promise<void> {
  if (process.platform === 'win32') await rmdir(path)
  else await unlink(path)
  await linkDirectory(target, path)
}

async function writeVarsLayers(
  home: string,
  key: string,
  localValue: string,
  type: 'string' | 'secret' = 'string',
): Promise<void> {
  const repoVars = join(home, '.loom', 'repos', 'default', 'vars')
  const localVars = join(home, '.loom', 'local', 'repos', 'default', 'vars')
  await mkdir(repoVars, { recursive: true })
  await mkdir(localVars, { recursive: true })
  await writeFile(join(repoVars, 'base.yaml'), `${key}:\n  type: ${type}\n  value: base\n`)
  await writeFile(join(localVars, 'local.yaml'), `${key}:\n  value: ${localValue}\n`)
}

async function expectHomeAwareReadLease(
  leases: RecordingCoordinator,
  fs: NodeFileSystem,
  home: string,
): Promise<void> {
  const canonicalHome = await fs.realPath(home)
  const canonicalRepo = await fs.realPath(join(home, '.loom', 'repos', 'default'))
  expect(leases.acquired).toHaveLength(1)
  expect(new Set(leases.acquired[0])).toEqual(
    new Set([
      { key: canonicalHome, mode: 'read' as const },
      { key: canonicalRepo, mode: 'read' as const },
    ]),
  )
}

function createMcpDebugSessionManager(): McpDebugSessionManagerLike {
  return {
    createSession: vi.fn(async (input) => ({
      sessionId: 'debug-1',
      source: input.source,
      serverFingerprint: 'fingerprint',
      previewAgent: input.previewAgent,
      tools: [],
      createdAt: '2026-07-20T00:00:00.000Z',
      idleExpiresAt: '2026-07-20T00:05:00.000Z',
      hardExpiresAt: '2026-07-20T00:30:00.000Z',
    })),
    callTool: vi.fn(async () => ({
      ok: true as const,
      result: {},
      durationMs: 0,
      calledAt: '2026-07-20T00:00:00.000Z',
      idleExpiresAt: '2026-07-20T00:05:00.000Z',
    })),
    disconnect: vi.fn(async () => undefined),
  }
}

describe('repository resource lease integration', () => {
  let home: string | undefined

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('shares one canonical repository lease across Config and Memory mutations', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-resource-lease-'))
    const repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(join(repoPath, 'memories'), { recursive: true })
    await writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: default\n')
    await writeFile(join(repoPath, 'config.yaml'), 'profile: local\nagents: []\n')

    const leases = new RecordingCoordinator()
    const deps = {
      fs: new NodeFileSystem(),
      git: {} as never,
      proc: {} as never,
      home,
      leases,
    }
    const app = new Hono()
    app.route('/', createConfigRoutes(deps))
    app.route('/', createMemoryRoutes(deps))

    const configResponse = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', level: 'repo', field: 'profile', value: 'work' }),
    })
    const memoryResponse = await app.request('/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', name: 'notes' }),
    })

    expect(configResponse.status).toBe(200)
    expect(memoryResponse.status).toBe(200)
    const canonicalRepoPath = await deps.fs.realPath(repoPath)
    expect(leases.acquired).toEqual([
      [{ key: canonicalRepoPath, mode: 'mutation' }],
      [{ key: canonicalRepoPath, mode: 'mutation' }],
    ])
    expect(await readRepoConfig(deps.fs, repoPath)).toMatchObject({
      profile: 'work',
      memory_order: ['notes'],
    })
  })

  it('shares the canonical home lease across local Config and MCP import', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-resource-lease-'))
    const repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: default\n')
    await writeFile(join(repoPath, 'config.yaml'), 'agents: []\n')

    const leases = new RecordingCoordinator()
    const deps = {
      fs: new NodeFileSystem(),
      git: {} as never,
      proc: {} as never,
      home,
      leases,
    }
    const app = new Hono()
    app.route('/', createConfigRoutes(deps))
    app.route('/', createMcpImportRoutes(deps))

    const configResponse = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'local', field: 'profile', value: 'work' }),
    })
    const importResponse = await app.request('/mcp/import/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', sources: [] }),
    })

    expect(configResponse.status).toBe(200)
    expect(importResponse.status).toBe(200)
    const canonicalHome = await deps.fs.realPath(home)
    expect(leases.acquired[0]).toEqual([{ key: canonicalHome, mode: 'mutation' }])
    expect(leases.acquired[1]).toContainEqual({ key: canonicalHome, mode: 'read' })
  })

  it('reuses the route dependency fallback coordinator for home-aware routes', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-fallback-resource-lease-'))
    await createHomeRepository(home, 'local')
    await writeVarsLayers(home, 'HOME_VALUE', 'local')
    await writeFile(
      join(home, '.loom', 'repos', 'default', 'mcp.yaml'),
      '- id: demo\n  type: stdio\n  command: node\n',
    )

    const mcpDebug = createMcpDebugSessionManager()
    const deps = {
      fs: new NodeFileSystem(),
      git: {} as never,
      proc: {} as never,
      home,
      mcpDebug,
    }
    const run = vi.spyOn(resourceLeases(deps), 'run')
    const app = new Hono()
    app.route('/', createVarsRoutes(deps))
    app.route('/', createMemoryRoutes(deps))
    app.route('/', createMcpDebugRoutes(deps))

    const varsResponse = await app.request('/vars/preview?repoPath=default&agent=default')
    expect(varsResponse.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)

    const memoryResponse = await app.request('/memory/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', content: '${HOME_VALUE}', agent: 'codex' }),
    })
    expect(memoryResponse.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(2)

    const mcpResponse = await app.request('/mcp/debug/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: 'default',
        source: 'saved',
        serverId: 'demo',
        previewAgent: 'default',
      }),
    })
    expect(mcpResponse.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('uses repo-only content and canonical home-aware projection leases', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-resource-lease-projection-'))
    const repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(join(repoPath, 'assets', 'skills', 'demo'), { recursive: true })
    await writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: default\n')
    await writeFile(join(repoPath, 'config.yaml'), 'agents: []\n')
    await writeFile(join(repoPath, 'skills.yaml'), 'sources: []\nskills:\n  - id: demo\n')
    await writeFile(join(repoPath, 'mcp.yaml'), '[]\n')
    await writeFile(join(repoPath, 'assets', 'skills', 'demo', 'SKILL.md'), '# Before\n')

    const leases = new RecordingCoordinator()
    const deps = {
      fs: new NodeFileSystem(),
      git: {} as never,
      proc: { isCommandInstalled: async () => false },
      home,
      leases,
    }
    const app = new Hono().route('/', createProjectionRoutes(deps))

    const contentResponse = await app.request('/skill/content', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', skillId: 'demo', content: '# After\n' }),
    })
    const manifestResponse = await app.request('/manifest?repo=default')
    const projectResponse = await app.request('/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', scope: 'skills' }),
    })

    expect(contentResponse.status).toBe(200)
    expect(manifestResponse.status).toBe(200)
    expect(projectResponse.status).toBe(200)
    const canonicalRepoPath = await deps.fs.realPath(repoPath)
    const canonicalHome = await deps.fs.realPath(home)
    expect(leases.acquired[0]).toEqual([{ key: canonicalRepoPath, mode: 'mutation' }])
    expect(new Set(leases.acquired[1])).toEqual(
      new Set([
        { key: canonicalRepoPath, mode: 'read' as const },
        { key: canonicalHome, mode: 'read' as const },
      ]),
    )
    expect(new Set(leases.acquired[2]!.map(({ key }) => key))).toEqual(
      new Set(projectionResourceKeys(canonicalHome, canonicalRepoPath, canonicalHome, 'skills')),
    )
    expect(leases.acquired[2]!.every(({ mode }) => mode === 'mutation')).toBe(true)
  })

  it('rejects a repository replaced after authorization without mutating either target', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-repository-replaced-'))
    const repoPath = join(home, '.loom', 'repos', 'default')
    const parkedRepo = join(home, '.loom', 'repos', 'parked')
    const external = join(home, 'external')
    await mkdir(repoPath, { recursive: true })
    await mkdir(external)
    await writeFile(join(repoPath, 'config.yaml'), 'profile: original\n')
    await writeFile(join(external, 'config.yaml'), 'profile: external\n')
    await writeFile(join(external, 'sentinel.txt'), 'untouched\n')

    let replaced = false
    const leases = new RecordingCoordinator(async () => {
      if (replaced) return
      replaced = true
      await rename(repoPath, parkedRepo)
      await linkDirectory(external, repoPath)
    })
    const fs = new NodeFileSystem()
    const write = vi.spyOn(fs, 'writeFile')
    const app = new Hono().route(
      '/',
      createConfigRoutes({ fs, git: {} as never, proc: {} as never, home, leases }),
    )

    const response = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', level: 'repo', field: 'profile', value: 'changed' }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, error: 'repo_unavailable' })
    expect(write).not.toHaveBeenCalled()
    await expect(readFile(join(parkedRepo, 'config.yaml'), 'utf8')).resolves.toBe(
      'profile: original\n',
    )
    await expect(readFile(join(external, 'config.yaml'), 'utf8')).resolves.toBe(
      'profile: external\n',
    )
    await expect(readFile(join(external, 'sentinel.txt'), 'utf8')).resolves.toBe('untouched\n')
  })

  it('keeps local config writes on the authorized home after its alias is retargeted', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-config-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await createHomeRepository(authorizedHome, 'authorized')
    await createHomeRepository(replacementHome, 'replacement')
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const app = new Hono().route(
      '/',
      createConfigRoutes({ fs, git: {} as never, proc: {} as never, home: alias, leases }),
    )

    const response = await app.request('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'local', field: 'profile', value: 'updated' }),
    })

    expect(response.status).toBe(200)
    await expect(readFile(join(authorizedHome, '.loom', 'config.yaml'), 'utf8')).resolves.toContain(
      'profile: updated',
    )
    await expect(
      readFile(join(replacementHome, '.loom', 'config.yaml'), 'utf8'),
    ).resolves.toContain('profile: replacement')
    expect(leases.acquired).toEqual([
      [{ key: await fs.realPath(authorizedHome), mode: 'mutation' }],
    ])
  })

  it('keeps projection output on the authorized home after its alias is retargeted', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-projection-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await createHomeRepository(authorizedHome, 'authorized')
    await createHomeRepository(replacementHome, 'replacement')
    await writeFile(join(replacementHome, '.loom', 'config.yaml'), '[]\n')
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const app = new Hono().route(
      '/',
      createProjectionRoutes({
        fs,
        git: {} as never,
        proc: { isCommandInstalled: async (command: string) => command === 'codex' },
        home: alias,
        leases,
      }),
    )

    const response = await app.request('/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', scope: 'skills' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    await expect(
      readFile(join(authorizedHome, '.codex', 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Demo\n')
    await expect(
      readFile(join(replacementHome, '.codex', 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps initialization on the authorized home after its alias is retargeted', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-init-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await mkdir(authorizedHome)
    await mkdir(replacementHome)
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const git = { init: vi.fn(async () => undefined) }
    const app = new Hono().route(
      '/',
      createHealthRoutes({
        fs,
        git: git as never,
        proc: {} as never,
        home: alias,
        leases,
      }),
    )

    const response = await app.request('/init', { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(readFile(join(authorizedHome, '.loom', 'config.yaml'), 'utf8')).resolves.toContain(
      'active_repo: default',
    )
    await expect(
      readFile(join(replacementHome, '.loom', 'config.yaml'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(git.init).toHaveBeenCalledWith(
      join(await fs.realPath(authorizedHome), '.loom', 'repos', 'default'),
    )
  })

  it('keeps status resolution on the authorized home after its alias is retargeted', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-status-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await createHomeRepository(authorizedHome, 'authorized')
    await createHomeRepository(replacementHome, 'replacement')
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const app = new Hono().route(
      '/',
      createHealthRoutes({
        fs,
        git: {} as never,
        proc: {} as never,
        home: alias,
        leases,
      }),
    )

    const response = await app.request('/status')
    const canonicalHome = await fs.realPath(authorizedHome)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      active_repo: 'default',
      repoPath: join(canonicalHome, '.loom', 'repos', 'default'),
    })
    expect(leases.acquired).toEqual([[{ key: canonicalHome, mode: 'read' }]])
  })

  it('keeps vars preview on the authorized home after its alias is retargeted', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-vars-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await createHomeRepository(authorizedHome, 'authorized')
    await createHomeRepository(replacementHome, 'replacement')
    await writeVarsLayers(authorizedHome, 'HOME_VALUE', 'authorized')
    await writeVarsLayers(replacementHome, 'HOME_VALUE', 'replacement')
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const app = new Hono().route(
      '/',
      createVarsRoutes({
        fs,
        git: {} as never,
        proc: {} as never,
        home: alias,
        leases,
      }),
    )

    const response = await app.request('/vars/preview?repoPath=default&agent=default')
    const body = (await response.json()) as { values?: Record<string, { value?: unknown }> }

    expect(response.status).toBe(200)
    expect(body.values?.HOME_VALUE?.value).toBe('authorized')
    await expectHomeAwareReadLease(leases, fs, authorizedHome)
  })

  it('keeps memory preview on the authorized home after its alias is retargeted', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-memory-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await createHomeRepository(authorizedHome, 'authorized')
    await createHomeRepository(replacementHome, 'replacement')
    await writeVarsLayers(authorizedHome, 'HOME_VALUE', 'authorized')
    await writeVarsLayers(replacementHome, 'HOME_VALUE', 'replacement')
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const app = new Hono().route(
      '/',
      createMemoryRoutes({
        fs,
        git: {} as never,
        proc: {} as never,
        home: alias,
        leases,
      }),
    )

    const response = await app.request('/memory/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'default', content: '${HOME_VALUE}', agent: 'codex' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ rendered: 'authorized' })
    await expectHomeAwareReadLease(leases, fs, authorizedHome)
  })

  it('keeps MCP debug secret resolution on the authorized home after alias retargeting', async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-home-retarget-mcp-debug-'))
    const authorizedHome = join(home, 'authorized')
    const replacementHome = join(home, 'replacement')
    const alias = join(home, 'home-alias')
    await createHomeRepository(authorizedHome, 'authorized')
    await createHomeRepository(replacementHome, 'replacement')
    await writeVarsLayers(authorizedHome, 'MCP_SECRET', 'authorized-secret', 'secret')
    await writeVarsLayers(replacementHome, 'MCP_SECRET', 'replacement-secret', 'secret')
    await writeFile(
      join(authorizedHome, '.loom', 'repos', 'default', 'mcp.yaml'),
      '- id: secure\n  type: stdio\n  command: ${MCP_SECRET}\n',
    )
    await linkDirectory(authorizedHome, alias)

    const leases = new RecordingCoordinator(async () => {
      await retargetDirectoryLink(replacementHome, alias)
    })
    const fs = new NodeFileSystem()
    const mcpDebug = createMcpDebugSessionManager()
    const app = new Hono().route(
      '/',
      createMcpDebugRoutes({
        fs,
        git: {} as never,
        proc: {} as never,
        home: alias,
        leases,
        mcpDebug,
      }),
    )

    const response = await app.request('/mcp/debug/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: 'default',
        source: 'saved',
        serverId: 'secure',
        previewAgent: 'default',
      }),
    })

    expect(response.status).toBe(200)
    expect(mcpDebug.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({ command: 'authorized-secret' }),
      }),
    )
    expect(JSON.stringify(vi.mocked(mcpDebug.createSession).mock.calls)).not.toContain(
      'replacement-secret',
    )
    await expectHomeAwareReadLease(leases, fs, authorizedHome)
  })
})
