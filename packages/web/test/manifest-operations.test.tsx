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
      config: { targets: ['codex'] },
      errors: [],
    })),
    putConfig: vi.fn(async () => ({ ok: true })),
    project: vi.fn(async () => ({ ok: true })),
    getSourceRefs: vi.fn(async () => ({ ok: true, branches: [], tags: [] })),
    addSource: vi.fn(async () => ({ ok: true })),
    setSourceMembers: vi.fn(async () => ({ ok: true })),
    updateSourceMeta: vi.fn(async () => ({ ok: true })),
    importLocalSkills: vi.fn(async () => ({ ok: true })),
    writeLocalSkills: vi.fn(async () => ({ ok: true })),
    updateSkillTargets: vi.fn(async () => ({ ok: true })),
    updateSourceSkillTargets: vi.fn(async () => ({ ok: true })),
    updateLocalSkillTargets: vi.fn(async () => ({ ok: true })),
    updateMcpTargets: vi.fn(async () => ({ ok: true })),
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
  })

  it('saves config and refreshes the shared manifest cache on success', async () => {
    const onError = vi.fn()
    render(
      <Harness
        onError={onError}
        action={(ops) => ops.saveConfig({ level: 'repo', field: 'targets', value: ['codex'] })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.putConfig).toHaveBeenCalledWith({
        repo: '/tmp/r',
        level: 'repo',
        field: 'targets',
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

  it('returns failure and refreshes when source member save returns ok:false after source creation', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['addSource']>> | undefined
    vi.mocked(api.addSource).mockResolvedValueOnce({ ok: true } as never)
    vi.mocked(api.setSourceMembers).mockResolvedValueOnce({
      ok: false,
      message: 'members write failed',
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
              members: ['alpha'],
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.setSourceMembers).toHaveBeenCalled())
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toContain('members write failed')
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('members write failed'))
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
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

  it('returns failure and refreshes when source member save throws after source creation', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['addSource']>> | undefined
    vi.mocked(api.addSource).mockResolvedValueOnce({ ok: true } as never)
    vi.mocked(api.setSourceMembers).mockRejectedValueOnce(new Error('members exploded') as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.addSource({
              url: 'https://example.test/skills.git',
              ref: 'main',
              members: ['alpha'],
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.setSourceMembers).toHaveBeenCalled())
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toContain('members exploded')
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('members exploded'))
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
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
    vi.mocked(api.updateSourceMeta).mockResolvedValueOnce({ ok: true } as never)
    vi.mocked(api.setSourceMembers).mockResolvedValueOnce({
      ok: false,
      message: 'members write failed',
    } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.saveSource({
              source: { url: 'https://example.test/skills.git', ref: 'main', type: 'branch' },
              ref: 'develop',
              type: 'branch',
              members: ['alpha'],
            })
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.setSourceMembers).toHaveBeenCalled())
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('members write failed')
      expect(onError).toHaveBeenCalledWith('members write failed')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
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

  it('projects skills after source scan member selection is saved', async () => {
    let result: Awaited<ReturnType<Operations['saveSourceMembers']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.saveSourceMembers(
            { url: 'https://example.test/skills.git', ref: 'main' },
            ['alpha'],
          )
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() =>
      expect(api.setSourceMembers).toHaveBeenCalledWith({
        repo: '/tmp/r',
        url: 'https://example.test/skills.git',
        members: ['alpha'],
      }),
    )
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/r', scope: 'skills' })
  })

  it('returns failure and refreshes when skill bulk target update fails after an earlier update', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['setAllSkillTargets']>> | undefined
    vi.mocked(api.updateSkillTargets)
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValueOnce({ ok: false, message: 'second target failed' } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.setAllSkillTargets(
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
                config: { targets: ['codex'] },
                errors: [],
              } as never,
              'codex',
            )
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.updateSkillTargets).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('second target failed')
      expect(onError).toHaveBeenCalledWith('second target failed')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'skills:all-targets:codex',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('projects skills after bulk skill target update succeeds', async () => {
    let result: Awaited<ReturnType<Operations['setAllSkillTargets']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.setAllSkillTargets(
            {
              skills: {
                sources: [
                  {
                    url: 'https://example.test/skills.git',
                    ref: 'main',
                    members: [{ name: 'alpha', targets: [] }],
                  },
                ],
                skills: [{ id: 'local-alpha', targets: [] }],
              },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { targets: ['codex'] },
              errors: [],
            } as never,
            'codex',
          )
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.updateSkillTargets).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.updateLocalSkillTargets).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/r', scope: 'skills' })
  })

  it('projects skills after source bulk target update succeeds', async () => {
    let result: Awaited<ReturnType<Operations['setSourceSkillTargets']>> | undefined

    render(
      <Harness
        action={async (ops) => {
          result = await ops.setSourceSkillTargets(
            {
              url: 'https://example.test/skills.git',
              ref: 'main',
              members: [
                { name: 'alpha', targets: [] },
                { name: 'beta', enabled: false, targets: [] },
                { name: 'gamma', targets: ['claude-code'] },
              ],
            },
            'codex',
          )
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(api.updateSourceSkillTargets).toHaveBeenCalledTimes(1))
    expect(api.updateSourceSkillTargets).toHaveBeenCalledWith({
      repo: '/tmp/r',
      sourceUrl: 'https://example.test/skills.git',
      updates: [
        { memberName: 'alpha', targets: ['codex'] },
        { memberName: 'gamma', targets: ['claude-code', 'codex'] },
      ],
    })
    expect(api.updateSkillTargets).not.toHaveBeenCalled()
    expect(api.updateLocalSkillTargets).not.toHaveBeenCalled()
    await waitFor(() => expect(result?.ok).toBe(true))
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/r', scope: 'skills' })
  })

  it('returns failure and refreshes when MCP bulk target update fails after an earlier update', async () => {
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let result: Awaited<ReturnType<Operations['setAllMcpTargets']>> | undefined
    vi.mocked(api.updateMcpTargets)
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValueOnce({ ok: false, message: 'second MCP target failed' } as never)

    try {
      render(
        <Harness
          onError={onError}
          action={async (ops) => {
            result = await ops.setAllMcpTargets(
              [
                { id: 'alpha', type: 'stdio', command: 'alpha', targets: [] },
                { id: 'beta', type: 'stdio', command: 'beta', targets: [] },
              ] as never,
              'codex',
            )
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'run' }))

      await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result?.ok).toBe(false))
      expect(result?.message).toBe('second MCP target failed')
      expect(onError).toHaveBeenCalledWith('second MCP target failed')
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'mcp:all-targets:codex',
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
})
