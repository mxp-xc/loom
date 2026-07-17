// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../src/lib/api'
import { useManifestOperations } from '../src/hooks/useManifestOperations'

vi.mock('../src/lib/api', () => ({
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
    importLocalSkills: vi.fn(async () => ({ ok: true })),
    writeLocalSkills: vi.fn(async () => ({ ok: true })),
    updateSkillAgents: vi.fn(async () => ({ ok: true })),
    updateSourceSkillAgents: vi.fn(async () => ({ ok: true })),
    updateLocalSkillAgents: vi.fn(async () => ({ ok: true })),
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

  it('saves a source name change and projects skills', async () => {
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
            expected_commit: 'abc123456789',
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

  it('returns failure and refreshes when source meta saves before member save fails', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['saveSource']>> | undefined
    vi.mocked(api.reconcileSource).mockResolvedValueOnce({
      ok: false,
      message: 'members write failed',
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
      expect(result?.message).toBe('members write failed')
      expect(onError).toHaveBeenCalledWith('members write failed')
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

  it('returns failure and refreshes when skill bulk agent update fails after an earlier update', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['setAllSkillAgents']>> | undefined
    vi.mocked(api.updateSkillAgents)
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValueOnce({ ok: false, message: 'second agent failed' } as never)

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
                      members: [{ name: 'alpha' }, { name: 'beta' }],
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

      await waitFor(() => expect(api.updateSkillAgents).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('second agent failed')
      expect(onError).toHaveBeenCalledWith('second agent failed')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'skills:all-agents:codex',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('projects skills after bulk skill agent update succeeds', async () => {
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
                    members: [{ name: 'alpha', agents: [] }],
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

    await waitFor(() => expect(api.updateSkillAgents).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.updateLocalSkillAgents).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/r', scope: 'skills' })
  })

  it('projects skills after source bulk agent update succeeds', async () => {
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

    await waitFor(() => expect(api.updateSourceSkillAgents).toHaveBeenCalledTimes(1))
    expect(api.updateSourceSkillAgents).toHaveBeenCalledWith({
      repo: '/tmp/r',
      sourceUrl: 'https://example.test/skills.git',
      updates: [
        { memberEntry: 'alpha/SKILL.md', agents: ['codex'] },
        { memberEntry: 'beta/SKILL.md', agents: ['codex'] },
        { memberEntry: 'gamma/SKILL.md', agents: ['claude-code', 'codex'] },
      ],
    })
    expect(api.updateSkillAgents).not.toHaveBeenCalled()
    expect(api.updateLocalSkillAgents).not.toHaveBeenCalled()
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/r', scope: 'skills' })
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
})
