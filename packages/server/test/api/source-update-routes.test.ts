import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteRoutes } from '../../src/api/routes/remote.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import {
  ResourceLeaseCoordinator,
  type HeldResourceLease,
  type ResourceLeaseRequest,
} from '../../src/concurrency/resource-lease-coordinator.js'
import { projectionResourceKeys } from '../../src/concurrency/resource-keys.js'
import { validationError } from '../helpers/http.js'

const prepareSourceUpdateMock = vi.hoisted(() =>
  vi.fn(async (_git, fs, _source, _newRef, workspace) => {
    await fs.mkdir(join(workspace.candidateDir, '.git'), false)
    await fs.writeFile(join(workspace.candidateDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return {
      pinned_commit: 'next-commit',
      newMembers: [{ name: 'next-skill', entry: 'skills/next-skill/SKILL.md' }],
      resourceBoundaryChanges: [],
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
  }),
)
const projectRepositoryMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))

vi.mock('../../src/remote/update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote/update.js')>()
  return { ...actual, prepareSourceUpdate: prepareSourceUpdateMock }
})

vi.mock('../../src/projection/workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/projection/workflow.js')>()
  return { ...actual, projectRepository: projectRepositoryMock }
})

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: vi.fn(() => log),
    error: log.error,
    warn: log.warn,
    info: log.info,
  },
}))

class RecordingCoordinator extends ResourceLeaseCoordinator {
  readonly acquired: ResourceLeaseRequest[][] = []

  constructor() {
    super(async () => async () => undefined)
  }

  override run<T>(
    requests: readonly ResourceLeaseRequest[],
    operation: (lease: HeldResourceLease) => Promise<T>,
  ): Promise<T> {
    this.acquired.push([...requests])
    return super.run(requests, operation)
  }
}

describe('source update route contract', () => {
  let home: string
  let repoPath: string
  let fs: NodeFileSystem

  beforeEach(async () => {
    vi.clearAllMocks()
    home = await mkdtemp(join(tmpdir(), 'loom-source-update-route-'))
    repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(repoPath, { recursive: true })
    repoPath = await realpath(repoPath)
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: current',
        '    pinned_commit: current-commit',
        '    members:',
        '      - name: old-skill',
        '        entry: skills/old-skill/SKILL.md',
        '        agents: [codex]',
        'skills: []',
        '',
      ].join('\n'),
    )
    fs = new NodeFileSystem()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  })

  function app(fileSystem = fs, leases?: ResourceLeaseCoordinator) {
    return new Hono().route(
      '/api',
      createRemoteRoutes({
        fs: fileSystem,
        git: {} as never,
        proc: {} as never,
        home,
        ...(leases ? { leases } : {}),
      }),
    )
  }

  async function post(application: Hono, path: string, body: unknown) {
    return application.request(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function prepare(application: Hono) {
    const response = await post(application, '/update/prepare', {
      repo: 'default',
      source: {
        url: 'https://example.test/skills.git',
        ref: 'forged',
        pinned_commit: 'forged-commit',
        members: [{ name: 'forged-skill', entry: 'forged/SKILL.md' }],
      },
      newRef: 'next',
    })
    expect(response.status).toBe(200)
    return (await response.json()) as { sessionId: string }
  }

  it('authorizes prepare from the persisted source and cancels its owned workspace', async () => {
    const application = app()
    const { sessionId } = await prepare(application)

    expect(prepareSourceUpdateMock).toHaveBeenCalledWith(
      expect.any(Object),
      fs,
      expect.objectContaining({
        ref: 'current',
        pinned_commit: 'current-commit',
        members: [
          {
            name: 'old-skill',
            entry: 'skills/old-skill/SKILL.md',
            agents: ['codex'],
          },
        ],
      }),
      'next',
      expect.objectContaining({ repoPath }),
      expect.any(Array),
    )

    const cancelled = await post(application, '/update/cancel', { repo: 'default', sessionId })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toEqual({ ok: true })
    expect(await fs.inspectEntry(join(repoPath, 'temp', 'source-updates', sessionId))).toBeNull()
  })

  it('maps malformed persisted state to 422 without executing injected paths', async () => {
    const { sessionId } = await prepare(app())
    const statePath = join(repoPath, 'temp', 'source-updates', sessionId, 'session.json')
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    persisted.stagingDir = join(home, 'outside')
    await writeFile(statePath, JSON.stringify(persisted))

    const response = await post(app(), '/update/cancel', { repo: 'default', sessionId })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'invalid_update_session_state' })
    expect(await fs.inspectEntry(join(home, 'outside'))).toBeNull()
  })

  it('maps persisted state IO failure to a safe logged 500', async () => {
    const { sessionId } = await prepare(app())
    const statePath = join(repoPath, 'temp', 'source-updates', sessionId, 'session.json')
    const failure = Object.assign(new Error('secret denied path'), { code: 'EACCES' })
    class ReadFailureFileSystem extends NodeFileSystem {
      override async readFile(path: string): Promise<string> {
        if (path === statePath) throw failure
        return super.readFile(path)
      }
    }

    const response = await post(app(new ReadFailureFileSystem()), '/update/cancel', {
      repo: 'default',
      sessionId,
    })
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      ok: false,
      error: 'update_session_unavailable',
      message: 'source update session is unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(log.error).toHaveBeenCalledWith(
      'source update cancel session recovery failed',
      expect.objectContaining({ err: expect.any(Error), sessionId }),
    )
  })

  it('rejects stale source state before projection or finalize mutation', async () => {
    const leases = new RecordingCoordinator()
    const application = app(fs, leases)
    const { sessionId } = await prepare(application)
    leases.acquired.length = 0
    const manifestPath = join(repoPath, 'skills.yaml')
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, 'utf8')).replace('current-commit', 'concurrent-commit'),
    )

    const response = await post(application, '/update/finalize', {
      repo: 'default',
      sessionId,
      preserve: [],
      resourceBoundaryDecisions: [],
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'source_update_stale' })
    expect(projectRepositoryMock).not.toHaveBeenCalled()
    expect(leases.acquired).toHaveLength(1)
    const canonicalHome = await realpath(home)
    expect(new Set(leases.acquired[0]!.map(({ key }) => key))).toEqual(
      new Set(projectionResourceKeys(canonicalHome, repoPath, canonicalHome, 'skills')),
    )
    expect(leases.acquired[0]!.every(({ mode }) => mode === 'mutation')).toBe(true)
  })

  it('logs projection primary and rollback failures and retains the recovery journal', async () => {
    const application = app()
    const { sessionId } = await prepare(application)
    const primary = new Error('projection failed')
    const rollback = new Error('projection rollback failed')
    projectRepositoryMock.mockResolvedValueOnce({
      ok: false,
      failure: {
        failedStep: 'skills',
        originalError: primary,
        rollbackReport: { undone: 0, rollbackFailures: [{ path: 'target', err: rollback }] },
      },
    } as never)

    const response = await post(application, '/update/finalize', {
      repo: 'default',
      sessionId,
      preserve: [],
      resourceBoundaryDecisions: [],
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'update_finalize_failed' })
    expect(projectRepositoryMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ home: await realpath(home) }),
      repoPath,
      { scope: 'skills' },
    )
    const failureLog = log.error.mock.calls.find(
      ([message]) => message === 'source update finalize failed',
    )
    const failure = failureLog?.[1]?.err
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({ cause: primary, errors: [primary, rollback] })
    const persisted = JSON.parse(
      await readFile(join(repoPath, 'temp', 'source-updates', sessionId, 'session.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(persisted.finalize).toBeDefined()
  })

  it('rejects invalid and duplicate preserve ids before filesystem mutation', async () => {
    const application = app()
    const { sessionId } = await prepare(application)
    projectRepositoryMock.mockClear()

    const invalid = await post(application, '/update/finalize', {
      repo: 'default',
      sessionId,
      preserve: ['../outside'],
    })
    const duplicate = await post(application, '/update/finalize', {
      repo: 'default',
      sessionId,
      preserve: ['old-skill', 'old-skill'],
    })

    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual(validationError('invalid_preserve_members'))
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ error: 'invalid_preserve_members' })
    expect(projectRepositoryMock).not.toHaveBeenCalled()
    expect(await fs.inspectEntry(join(repoPath, 'assets'))).toBeNull()
  })
})
