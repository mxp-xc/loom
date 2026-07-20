// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '@loom/core'
import { api } from '../src/lib/api'
import type { VarsMatrixResponse } from '../src/lib/vars'
import { useProfileVars } from '../src/views/vars/useProfileVars'
import { deferred } from './deferred'

vi.mock('../src/lib/api', () => ({
  api: {
    getManifest: vi.fn(),
    vars: { getMatrix: vi.fn() },
  },
}))

function manifest(agents: Manifest['config']['agents']): Manifest {
  return {
    skills: { sources: [], skills: [] },
    mcp: [],
    memory: { memories: [], active: null, activeContent: '' },
    vars: { default: {}, active: {} },
    config: { agents },
    errors: [],
  }
}

function matrix(agent: string): VarsMatrixResponse {
  return {
    ok: true,
    agent,
    builtinKeys: [],
    userKeys: [],
    snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
    resolution: {
      ok: true,
      values: {},
      sources: {},
      overrideChains: {},
      dependencies: {},
      diagnostics: [],
    },
  }
}

function ProfileVarsHarness({ repoPath }: { repoPath: string }) {
  const result = useProfileVars(repoPath)
  return (
    <div>
      <span data-testid="loading">{result.loading ? 'loading' : 'loaded'}</span>
      <span data-testid="default-agent">{result.defaultMatrix?.agent ?? 'none'}</span>
      <span data-testid="configured-agents">{result.configuredAgents.join(',')}</span>
      <span data-testid="loaded-agents">{Object.keys(result.matricesByAgent).join(',')}</span>
      <span data-testid="agent-errors">{JSON.stringify(result.matrixErrorsByAgent)}</span>
      <span data-testid="error">{result.error ?? ''}</span>
      <button type="button" onClick={() => void result.reload()}>
        reload
      </button>
    </div>
  )
}

describe('useProfileVars', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('loads Default and only the configured agent matrices', async () => {
    vi.mocked(api.getManifest).mockResolvedValue(manifest(['codex', 'opencode']))
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => matrix(agent))

    render(<ProfileVarsHarness repoPath="/configured" />)

    await screen.findByText('loaded')
    expect(api.vars.getMatrix).toHaveBeenCalledTimes(3)
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/configured', 'default')
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/configured', 'codex')
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/configured', 'opencode')
    expect(api.vars.getMatrix).not.toHaveBeenCalledWith('/configured', 'claude-code')
  })

  it('keeps successful agents when one agent matrix fails', async () => {
    vi.mocked(api.getManifest).mockResolvedValue(manifest(['codex', 'opencode']))
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      if (agent === 'opencode') throw new Error('OpenCode matrix unavailable')
      return matrix(agent)
    })

    render(<ProfileVarsHarness repoPath="/partial" />)

    await screen.findByText('loaded')
    expect(screen.getByTestId('configured-agents').textContent).toBe('codex,opencode')
    expect(screen.getByTestId('loaded-agents').textContent).toBe('codex')
    expect(screen.getByTestId('agent-errors').textContent).toContain('OpenCode matrix unavailable')
    expect(screen.getByTestId('error').textContent).toBe('')
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/partial', agent: 'opencode' }),
      'Failed to load agent vars',
    )
  })

  it('ignores a previous repository response and skips its matrix requests', async () => {
    const repoA = deferred<Manifest>()
    vi.mocked(api.getManifest).mockImplementation((repoPath) =>
      repoPath === '/repo-a' ? repoA.promise : Promise.resolve(manifest(['opencode'])),
    )
    vi.mocked(api.vars.getMatrix).mockImplementation(async (repoPath, agent) =>
      matrix(`${repoPath}:${agent}`),
    )
    const view = render(<ProfileVarsHarness repoPath="/repo-a" />)

    view.rerender(<ProfileVarsHarness repoPath="/repo-b" />)
    expect(await screen.findByText('/repo-b:default')).toBeDefined()
    repoA.resolve(manifest(['codex']))
    await act(async () => undefined)

    expect(screen.getByTestId('default-agent').textContent).toBe('/repo-b:default')
    expect(api.vars.getMatrix).not.toHaveBeenCalledWith('/repo-a', expect.anything())
  })

  it('commits only the latest reload when matrix responses arrive out of order', async () => {
    const firstReload = deferred<VarsMatrixResponse>()
    const secondReload = deferred<VarsMatrixResponse>()
    let defaultRequest = 0
    vi.mocked(api.getManifest).mockResolvedValue(manifest([]))
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      defaultRequest += 1
      if (defaultRequest === 1) return matrix(agent)
      if (defaultRequest === 2) return firstReload.promise
      return secondReload.promise
    })
    render(<ProfileVarsHarness repoPath="/reload" />)
    await screen.findByText('loaded')

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledTimes(3))
    await act(async () => {
      secondReload.resolve(matrix('second'))
      await secondReload.promise
    })
    expect(screen.getByTestId('default-agent').textContent).toBe('second')

    await act(async () => {
      firstReload.resolve(matrix('first'))
      await firstReload.promise
    })
    expect(screen.getByTestId('default-agent').textContent).toBe('second')
  })

  it('does not start matrix requests after unmount', async () => {
    const pendingManifest = deferred<Manifest>()
    vi.mocked(api.getManifest).mockReturnValue(pendingManifest.promise)
    const view = render(<ProfileVarsHarness repoPath="/unmount" />)

    view.unmount()
    pendingManifest.resolve(manifest(['codex']))
    await act(async () => undefined)

    expect(api.vars.getMatrix).not.toHaveBeenCalled()
  })
})
