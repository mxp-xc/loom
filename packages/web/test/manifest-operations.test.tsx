// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, api } from '../src/lib/api'
import { useManifestOperations } from '../src/hooks/useManifestOperations'

vi.mock('../src/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
      readonly diagnostics?: unknown[],
    ) {
      super(message)
    }
  },
  api: {
    getManifest: vi.fn(async () => ({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex'] },
      errors: [],
    })),
    putConfig: vi.fn(async () => ({ ok: true })),
    project: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => ({ updates: [{ hasUpdate: false }] })),
    getSourceRefs: vi.fn(async () => ({ ok: true, branches: [], tags: [] })),
    getCachedSourceTree: vi.fn(async () => ({
      ok: true,
      tree: { commit: 'abc', nodes: [], diagnostics: [] },
    })),
    scanSource: vi.fn(async () => ({ ok: true, members: [] })),
    refreshSource: vi.fn(async () => ({ ok: true, members: [] })),
    addSource: vi.fn(async () => ({ ok: true })),
    reconcileSource: vi.fn(async () => ({
      ok: true,
      finalized: true,
      changes: { added: [], updated: [], removed: [] },
    })),
    prepareSourceUpdate: vi.fn(async () => ({
      ok: true,
      sessionId: 'update-1',
      pinned_commit: 'bbb',
      changes: { added: [], updated: [], removed: [] },
      resourceBoundaryChanges: [],
    })),
    finalizeSourceUpdate: vi.fn(async () => ({ ok: true, pinned_commit: 'bbb' })),
    cancelSourceUpdate: vi.fn(async () => ({ ok: true })),
    importLocalSkills: vi.fn(async () => ({ ok: true })),
    writeLocalSkills: vi.fn(async () => ({ ok: true })),
    updateSkillAgentsBatch: vi.fn(async () => ({ ok: true })),
    resolveSourceNamespaceCollision: vi.fn(async () => ({
      ok: true,
      agent: 'codex',
      sourceName: 'playwright-cli',
      backupName: 'playwright-cli-backup',
    })),
    updateMcpAgents: vi.fn(async () => ({ ok: true })),
  },
}))

type Operations = ReturnType<typeof useManifestOperations>

function Harness({
  action,
  onError = vi.fn(),
  onToast = vi.fn(),
  onSuccess = vi.fn(),
}: {
  action: (ops: Operations) => Promise<unknown>
  onError?: (error: string) => void
  onToast?: (message: string) => void
  onSuccess?: () => void
}) {
  const ops = useManifestOperations('/tmp/r', { onError, onToast, onSuccess })
  const projectPending = ops.pending.project('skills')
  return (
    <button type="button" disabled={projectPending} onClick={() => void action(ops)}>
      {projectPending ? 'busy' : 'run'}
    </button>
  )
}

function CollisionHarness() {
  const ops = useManifestOperations('/tmp/r')
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void ops.toggleSourceSkillAgent(
            'https://github.com/microsoft/playwright-cli.git',
            'skills/playwright-cli/SKILL.md',
            'codex',
            [],
          )
        }
      >
        trigger
      </button>
      <output>{ops.sourceNamespaceCollision?.sourceName ?? 'none'}</output>
      <button type="button" onClick={() => void ops.resolveSourceNamespaceCollision()}>
        resolve
      </button>
    </>
  )
}

describe('useManifestOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.reconcileSource).mockResolvedValue({
      ok: true,
      finalized: true,
      changes: { added: [], updated: [], removed: [] },
    })
  })

  it('saves config and refreshes the shared manifest cache on success', async () => {
    const onError = vi.fn()
    render(
      <Harness
        onError={onError}
        action={(ops) => ops.saveConfig({ level: 'repo', field: 'agents', value: ['codex'] })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.putConfig).toHaveBeenCalledWith({
        repo: '/tmp/r',
        level: 'repo',
        field: 'agents',
        value: ['codex'],
      }),
    )
    await waitFor(() => expect(api.getManifest).toHaveBeenCalledWith('/tmp/r'))
    expect(onError).not.toHaveBeenCalled()
  })

  it('notifies success only after a successful mutation refreshes manifest', async () => {
    const onSuccess = vi.fn()
    const getManifestCallsBefore = vi.mocked(api.getManifest).mock.calls.length
    render(<Harness onSuccess={onSuccess} action={(ops) => ops.project('skills')} />)

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 1))
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('normalizes ok:false responses and does not refresh after a failed mutation', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.project).mockResolvedValueOnce({
      ok: false,
      message: '投影失败: bad yaml',
    } as never)

    try {
      render(<Harness onError={onError} action={(ops) => ops.project('skills')} />)

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(onError).toHaveBeenCalledWith('投影失败: bad yaml'))
      expect(api.getManifest).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'project:skills',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps a duplicate pending operation from running twice', async () => {
    let release!: () => void
    vi.mocked(api.project).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true })
        }) as never,
    )

    render(<Harness action={(ops) => ops.project('skills')} />)

    fireEvent.click(screen.getByRole('button', { name: 'run' }))
    await screen.findByRole('button', { name: 'busy' })
    fireEvent.click(screen.getByRole('button', { name: 'busy' }))

    expect(api.project).toHaveBeenCalledTimes(1)

    act(() => release())
    await waitFor(() => expect(api.getManifest).toHaveBeenCalledWith('/tmp/r'))
  })

  it('turns a source namespace collision into a resolvable GUI state', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.updateSkillAgentsBatch).mockRejectedValueOnce(
      new ApiError('collision', 409, 'source_namespace_collision', [
        {
          code: 'source_namespace_collision',
          message: 'backup required',
          agent: 'codex',
          sourceName: 'playwright-cli',
          sourceUrl: 'https://github.com/microsoft/playwright-cli.git',
        },
      ] as never),
    )

    try {
      render(<CollisionHarness />)
      fireEvent.click(screen.getByRole('button', { name: 'trigger' }))
      await screen.findByText('playwright-cli')

      fireEvent.click(screen.getByRole('button', { name: 'resolve' }))
      await waitFor(() =>
        expect(api.resolveSourceNamespaceCollision).toHaveBeenCalledWith({
          repo: '/tmp/r',
          sourceUrl: 'https://github.com/microsoft/playwright-cli.git',
          agent: 'codex',
        }),
      )
      await screen.findByText('none')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('advances the GUI to the next source namespace collision', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const collision = (sourceName: string, sourceUrl: string) =>
      new ApiError('collision', 409, 'source_namespace_collision', [
        {
          code: 'source_namespace_collision',
          message: 'backup required',
          agent: 'codex',
          sourceName,
          sourceUrl,
        },
      ] as never)
    vi.mocked(api.updateSkillAgentsBatch).mockRejectedValueOnce(
      collision('playwright-cli', 'https://github.com/microsoft/playwright-cli.git'),
    )
    vi.mocked(api.resolveSourceNamespaceCollision)
      .mockRejectedValueOnce(collision('superpowers', 'https://github.com/example/superpowers.git'))
      .mockResolvedValueOnce({
        ok: true,
        agent: 'codex',
        sourceName: 'superpowers',
        backupName: 'superpowers-backup',
      })

    try {
      render(<CollisionHarness />)
      fireEvent.click(screen.getByRole('button', { name: 'trigger' }))
      await screen.findByText('playwright-cli')

      fireEvent.click(screen.getByRole('button', { name: 'resolve' }))
      await screen.findByText('superpowers')
      fireEvent.click(screen.getByRole('button', { name: 'resolve' }))

      await screen.findByText('none')
      expect(api.resolveSourceNamespaceCollision).toHaveBeenNthCalledWith(2, {
        repo: '/tmp/r',
        sourceUrl: 'https://github.com/example/superpowers.git',
        agent: 'codex',
      })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not notify stale callers after the component unmounts', async () => {
    let reject!: (error: Error) => void
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.putConfig).mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectFn) => {
          reject = rejectFn
        }) as never,
    )

    try {
      const rendered = render(
        <Harness
          onError={onError}
          action={(ops) => ops.saveConfig({ level: 'local', field: 'profile', value: 'work' })}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))
      rendered.unmount()

      await act(async () => {
        reject(new Error('write failed'))
        await Promise.resolve()
      })

      expect(onError).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'config:local:profile',
          err: expect.any(Error),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns an atomic source creation failure without writing members separately', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['addSource']>> | undefined
    vi.mocked(api.addSource).mockResolvedValueOnce({
      ok: false,
      message: 'source write failed',
    } as never)

    try {
      render(
        <Harness
          onError={onError}
          onSuccess={onSuccess}
          action={async (ops) => {
            result = await ops.addSource({
              url: 'https://example.test/skills.git',
              ref: 'main',
              members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
              resources: { include: [], exclude: [] },
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toContain('source write failed')
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('source write failed'))
      expect(api.getManifest).not.toHaveBeenCalled()
      expect(onSuccess).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:add',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('scans the selected source ref without a glob pattern', async () => {
    render(
      <Harness
        action={(ops) =>
          ops.scanSourceTree('https://example.test/skills.git', {
            name: 'custom-skills',
            ref: 'v1.0.1',
            type: 'tag',
          })
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.scanSource).toHaveBeenCalledWith({
        name: 'custom-skills',
        url: 'https://example.test/skills.git',
        ref: 'v1.0.1',
        type: 'tag',
      }),
    )
  })

  it('allows scans for different refs to run concurrently', async () => {
    let resolveFirst!: (value: unknown) => void
    vi.mocked(api.scanSource)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }) as never,
      )
      .mockResolvedValueOnce({
        ok: true,
        tree: { commit: 'next', nodes: [], diagnostics: [] },
      } as never)
    const scanCallCount = vi.mocked(api.scanSource).mock.calls.length

    render(
      <Harness
        action={async (ops) => {
          const first = ops.scanSourceTree('https://example.test/skills.git', {
            ref: 'release',
            type: 'branch',
          })
          const second = ops.scanSourceTree('https://example.test/skills.git', {
            ref: 'next',
            type: 'branch',
          })
          await second
          resolveFirst({
            ok: true,
            tree: { commit: 'release', nodes: [], diagnostics: [] },
          })
          await first
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount + 2))
  })

  it('loads an existing source tree from its pinned cache without remote discovery', async () => {
    render(
      <Harness
        action={(ops) =>
          ops.loadCachedSourceTree({
            url: 'https://example.test/skills.git',
            ref: 'main',
            pinned_commit: 'abc123456789',
          })
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.getCachedSourceTree).toHaveBeenCalledWith({
        repo: '/tmp/r',
        url: 'https://example.test/skills.git',
        pinned_commit: 'abc123456789',
      }),
    )
    expect(api.getSourceRefs).not.toHaveBeenCalled()
    expect(api.scanSource).not.toHaveBeenCalled()
  })

  it('refreshes an existing source tree at its ref', async () => {
    render(
      <Harness
        action={(ops) =>
          ops.refreshSourceTree({
            url: 'https://example.test/skills.git',
            ref: 'v1.0.1',
            type: 'tag',
            members: [
              {
                name: 'alpha',
                entry: 'alpha/SKILL.md',
                description: 'runtime description',
              },
            ],
            sourceTree: { commit: 'abc', nodes: [], diagnostics: [] },
          })
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.refreshSource).toHaveBeenCalledWith('/tmp/r', {
        url: 'https://example.test/skills.git',
        ref: 'v1.0.1',
        type: 'tag',
      }),
    )
  })

  it('strips runtime source fields before checking for updates', async () => {
    render(
      <Harness
        action={(ops) =>
          ops.checkSourceUpdate({
            url: 'https://example.test/skills.git',
            ref: 'main',
            members: [
              {
                name: 'alpha',
                entry: 'alpha/SKILL.md',
                agents: ['codex'],
                description: 'runtime description',
              },
            ],
            sourceTree: { commit: 'abc', nodes: [], diagnostics: [] },
          })
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith('/tmp/r', [
        {
          url: 'https://example.test/skills.git',
          ref: 'main',
          members: [{ name: 'alpha', entry: 'alpha/SKILL.md', agents: ['codex'] }],
        },
      ]),
    )
  })

  it('passes type, members, and resources when adding a source', async () => {
    render(
      <Harness
        action={(ops) =>
          ops.addSource({
            name: 'skills',
            url: 'https://example.test/skills.git',
            ref: 'v1.0.1',
            type: 'tag',
            members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
            resources: { include: [{ path: 'shared', kind: 'directory' }], exclude: [] },
          })
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.addSource).toHaveBeenCalledWith({
        repo: '/tmp/r',
        name: 'skills',
        url: 'https://example.test/skills.git',
        ref: 'v1.0.1',
        type: 'tag',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
        resources: { include: [{ path: 'shared', kind: 'directory' }], exclude: [] },
      }),
    )
  })

  it('atomically reconciles a source name change and refreshes the manifest', async () => {
    let result: Awaited<ReturnType<Operations['saveSource']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.saveSource({
            source: {
              name: 'old-name',
              url: 'https://example.test/skills.git',
              ref: 'main',
              type: 'branch',
              members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
            },
            name: 'new-name',
            ref: 'main',
            type: 'branch',
            expectedCommit: 'abc123456789',
            members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
            resources: { include: [], exclude: [] },
          })
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith({
        repo: '/tmp/r',
        url: 'https://example.test/skills.git',
        name: 'new-name',
        ref: 'main',
        type: 'branch',
        expected_commit: 'abc123456789',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
        resources: { include: [], exclude: [] },
      }),
    )
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
  })

  it('returns failure when the atomic source creation request throws', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['addSource']>> | undefined
    vi.mocked(api.addSource).mockRejectedValueOnce(new Error('source write exploded') as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.addSource({
              url: 'https://example.test/skills.git',
              ref: 'main',
              members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
              resources: { include: [], exclude: [] },
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toContain('source write exploded')
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('source write exploded'))
      expect(api.getManifest).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:add',
          err: expect.any(Error),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns failure without refreshing when atomic source reconciliation fails', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['saveSource']>> | undefined
    vi.mocked(api.reconcileSource).mockResolvedValueOnce({
      ok: false,
      message: 'source reconciliation failed',
    } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.saveSource({
              source: {
                url: 'https://example.test/skills.git',
                ref: 'main',
                type: 'branch',
              },
              ref: 'develop',
              type: 'branch',
              members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
              resources: { include: [], exclude: [] },
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.reconcileSource).toHaveBeenCalled())
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('source reconciliation failed')
      expect(onError).toHaveBeenCalledWith('source reconciliation failed')
      expect(api.reconcileSource).toHaveBeenCalledWith({
        repo: '/tmp/r',
        url: 'https://example.test/skills.git',
        name: 'skills',
        ref: 'develop',
        type: 'branch',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
        resources: { include: [], exclude: [] },
      })
      expect(api.getManifest).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:save:https://example.test/skills.git',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns failure and refreshes when the skill agent batch fails', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['setAllSkillAgents']>> | undefined
    vi.mocked(api.updateSkillAgentsBatch).mockResolvedValueOnce({
      ok: false,
      message: 'batch projection failed',
    } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.setAllSkillAgents(
              {
                skills: {
                  sources: [
                    {
                      url: 'https://example.test/skills.git',
                      ref: 'main',
                      members: [
                        { name: 'alpha', entry: 'alpha/SKILL.md' },
                        { name: 'beta', entry: 'beta/SKILL.md' },
                      ],
                    },
                  ],
                  skills: [],
                },
                mcp: [],
                vars: { default: {}, active: {} },
                config: { agents: ['codex'] },
                errors: [],
              } as never,
              'codex',
            )
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.updateSkillAgentsBatch).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('batch projection failed')
      expect(onError).toHaveBeenCalledWith('batch projection failed')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'skills:agents',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('refreshes and reports a projection warning without success notifications', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const onToast = vi.fn()
    let result: Awaited<ReturnType<Operations['toggleLocalSkillAgent']>> | undefined
    vi.mocked(api.updateSkillAgentsBatch).mockResolvedValueOnce({
      ok: true,
      warnings: [{ message: 'Source shared-skills is unavailable' }],
    } as never)

    render(
      <Harness
        onError={onError}
        onSuccess={onSuccess}
        onToast={onToast}
        action={async (ops) => {
          result = await ops.toggleLocalSkillAgent('local-alpha', 'codex', [])
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.getManifest).toHaveBeenCalledWith('/tmp/r'))
    expect(result).toMatchObject({ ok: true, message: 'Source shared-skills is unavailable' })
    expect(onError).toHaveBeenCalledWith('Source shared-skills is unavailable')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onToast).not.toHaveBeenCalled()
  })

  it('refreshes manifest after a rejected skill-agent ApiError', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['toggleLocalSkillAgent']>> | undefined
    vi.mocked(api.updateSkillAgentsBatch).mockRejectedValueOnce(
      new ApiError('Skills state conflict', 409, 'stale_agent_state'),
    )

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.toggleLocalSkillAgent('local-alpha', 'codex', [])
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('Skills state conflict')
      expect(onError).toHaveBeenCalledWith('Skills state conflict')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('uses one shared pending key for item, source, and global skill batches', async () => {
    let release!: (value: { ok: true }) => void
    let sourceResult: Awaited<ReturnType<Operations['setSourceSkillAgents']>> | undefined
    let globalResult: Awaited<ReturnType<Operations['setAllSkillAgents']>> | undefined
    vi.mocked(api.updateSkillAgentsBatch).mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve
        }) as never,
    )

    render(
      <Harness
        action={async (ops) => {
          const item = ops.toggleLocalSkillAgent('local-alpha', 'codex', [])
          sourceResult = await ops.setSourceSkillAgents(
            {
              url: 'https://example.test/skills.git',
              ref: 'main',
              members: [{ name: 'alpha', entry: 'alpha/SKILL.md', agents: [] }],
            },
            'codex',
          )
          globalResult = await ops.setAllSkillAgents(
            {
              skills: { sources: [], skills: [{ id: 'local-alpha', agents: [] }] },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { agents: ['codex'] },
              errors: [],
            } as never,
            'codex',
          )
          release({ ok: true })
          await item
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.updateSkillAgentsBatch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(sourceResult).toEqual({ ok: false, skipped: true }))
    expect(globalResult).toEqual({ ok: false, skipped: true })
  })

  it('uses a one-element batch for a single source member toggle', async () => {
    let result: Awaited<ReturnType<Operations['toggleSourceSkillAgent']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.toggleSourceSkillAgent(
            'https://example.test/skills.git',
            'alpha/SKILL.md',
            'codex',
            ['claude-code'],
          )
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.updateSkillAgentsBatch).toHaveBeenCalledTimes(1))
    expect(api.updateSkillAgentsBatch).toHaveBeenCalledWith({
      repo: '/tmp/r',
      sources: [
        {
          sourceUrl: 'https://example.test/skills.git',
          updates: [
            {
              memberEntry: 'alpha/SKILL.md',
              expectedAgents: ['claude-code'],
              agents: ['claude-code', 'codex'],
            },
          ],
        },
      ],
      locals: [],
    })
    await waitFor(() => expect(result?.ok).toBe(true))
  })

  it('uses one server-side batch mutation for global skill agents', async () => {
    let result: Awaited<ReturnType<Operations['setAllSkillAgents']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.setAllSkillAgents(
            {
              skills: {
                sources: [
                  {
                    url: 'https://example.test/skills.git',
                    ref: 'main',
                    members: [{ name: 'alpha', entry: 'alpha/SKILL.md', agents: [] }],
                  },
                ],
                skills: [{ id: 'local-alpha', agents: [] }],
              },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { agents: ['codex'] },
              errors: [],
            } as never,
            'codex',
          )
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.updateSkillAgentsBatch).toHaveBeenCalledTimes(1))
    expect(api.updateSkillAgentsBatch).toHaveBeenCalledWith({
      repo: '/tmp/r',
      sources: [
        {
          sourceUrl: 'https://example.test/skills.git',
          updates: [{ memberEntry: 'alpha/SKILL.md', expectedAgents: [], agents: ['codex'] }],
        },
      ],
      locals: [{ id: 'local-alpha', expectedAgents: [], agents: ['codex'] }],
    })
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).not.toHaveBeenCalled()
  })

  it('relies on the source batch mutation to complete projection', async () => {
    let result: Awaited<ReturnType<Operations['setSourceSkillAgents']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.setSourceSkillAgents(
            {
              url: 'https://example.test/skills.git',
              ref: 'main',
              members: [
                { name: 'alpha', entry: 'alpha/SKILL.md', agents: [] },
                { name: 'beta', entry: 'beta/SKILL.md', agents: [] },
                { name: 'gamma', entry: 'gamma/SKILL.md', agents: ['claude-code'] },
              ],
            },
            'codex',
          )
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.updateSkillAgentsBatch).toHaveBeenCalledTimes(1))
    expect(api.updateSkillAgentsBatch).toHaveBeenCalledWith({
      repo: '/tmp/r',
      sources: [
        {
          sourceUrl: 'https://example.test/skills.git',
          updates: [
            {
              memberEntry: 'alpha/SKILL.md',
              expectedAgents: [],
              agents: ['codex'],
            },
            {
              memberEntry: 'beta/SKILL.md',
              expectedAgents: [],
              agents: ['codex'],
            },
            {
              memberEntry: 'gamma/SKILL.md',
              expectedAgents: ['claude-code'],
              agents: ['claude-code', 'codex'],
            },
          ],
        },
      ],
      locals: [],
    })
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).not.toHaveBeenCalled()
  })

  it('returns failure and refreshes when MCP bulk agent update fails after an earlier update', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['setAllMcpAgents']>> | undefined
    vi.mocked(api.updateMcpAgents)
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValueOnce({ ok: false, message: 'second MCP agent failed' } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.setAllMcpAgents(
              [
                { id: 'alpha', type: 'stdio', command: 'alpha', agents: [] },
                { id: 'beta', type: 'stdio', command: 'beta', agents: [] },
              ] as never,
              'codex',
            )
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('second MCP agent failed')
      expect(onError).toHaveBeenCalledWith('second MCP agent failed')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'mcp:all-agents:codex',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('logs ok:false results without notifying when a notification guard is stale', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['loadSourceRefs']>> | undefined
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: false,
      message: 'stale refs failure',
      details: { url: 'https://example.test/stale.git' },
    } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.loadSourceRefs('https://example.test/stale.git', {
              shouldNotify: () => false,
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(result?.ok).toBe(false))
      expect(onError).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:refs:https://example.test/stale.git',
          result: expect.objectContaining({
            ok: false,
            details: { url: 'https://example.test/stale.git' },
          }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('logs thrown errors with operation context and stack', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('refs exploded')
    vi.mocked(api.getSourceRefs).mockRejectedValueOnce(err as never)

    try {
      render(
        <Harness
          onError={onError}
          action={(ops) => ops.loadSourceRefs('https://example.test/error.git')}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(onError).toHaveBeenCalledWith('refs exploded'))
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:refs:https://example.test/error.git',
          err,
        }),
        expect.any(String),
      )
      expect(err.stack).toBeTruthy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('sends only persisted source fields when preparing an update', async () => {
    render(
      <Harness
        action={(ops) =>
          ops.performSourceUpdate(
            {
              name: 'source-name',
              url: 'https://example.test/skills.git',
              ref: 'main',
              pinned_commit: 'abc',
              members: [
                {
                  name: 'alpha',
                  entry: 'skills/alpha/SKILL.md',
                  agents: ['codex'],
                  description: 'runtime member description',
                },
              ],
              resources: {
                include: [{ path: 'shared', kind: 'directory' }],
                exclude: [],
              },
              sourceTree: { commit: 'abc', nodes: [], diagnostics: [] },
            },
            'repair',
          )
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.prepareSourceUpdate).toHaveBeenCalledWith({
        repo: '/tmp/r',
        newRef: 'main',
        source: {
          name: 'source-name',
          url: 'https://example.test/skills.git',
          ref: 'main',
          pinned_commit: 'abc',
          members: [
            {
              name: 'alpha',
              entry: 'skills/alpha/SKILL.md',
              agents: ['codex'],
            },
          ],
          resources: {
            include: [{ path: 'shared', kind: 'directory' }],
            exclude: [],
          },
        },
      }),
    )
  })

  it('cancels a prepared source update without refreshing the manifest', async () => {
    const getManifestCallsBefore = vi.mocked(api.getManifest).mock.calls.length
    render(<Harness action={(ops) => ops.cancelSourceUpdate('update-1')} />)

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.cancelSourceUpdate).toHaveBeenCalledWith({
        repo: '/tmp/r',
        sessionId: 'update-1',
      }),
    )
    expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore)
  })
})
