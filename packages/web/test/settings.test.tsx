// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../src/views/Settings'
import { api } from '../src/lib/api'
import { deferred } from './deferred'

const config = {
  effective: { active_repo: 'default', profile: 'work', agents: ['claude-code'] },
  repo: { profile: 'work', agents: ['claude-code'] },
  local: { active_repo: 'default' },
  profiles: ['work', 'personal'],
}

vi.mock('../src/lib/api', () => ({
  api: {
    getConfig: vi.fn(),
    putConfig: vi.fn(),
    getManifest: vi.fn(),
  },
}))

describe('Settings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    vi.mocked(api.getConfig).mockResolvedValue(config)
    vi.mocked(api.putConfig).mockResolvedValue({ ok: true })
    vi.mocked(api.getManifest).mockResolvedValue({
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [], active: null, activeContent: '' },
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code'] },
      errors: [],
    })
  })

  it('falls back from an invalid persisted category', async () => {
    localStorage.setItem('loom:settings:catTab', 'deleted-category')

    render(<Settings repoPath="/tmp/r" />)

    expect((await screen.findByRole('tab', { name: '通用' })).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByText('Workspace')).toBeDefined()
  })

  it('uses tabs and pressed buttons for category and level navigation', async () => {
    render(<Settings repoPath="/tmp/r" />)
    const general = await screen.findByRole('tab', { name: '通用' })
    const network = screen.getByRole('tab', { name: '网络' })
    expect(general.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(network)
    expect(network.getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem('loom:settings:catTab')).toBe('network')

    const repoLevel = screen.getByRole('button', { name: '仓库级' })
    fireEvent.click(repoLevel)
    expect(repoLevel.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('loom:settings:level')).toBe('repo')
  })

  it('renders loading until the config request completes', async () => {
    const request = deferred<typeof config>()
    vi.mocked(api.getConfig).mockReturnValue(request.promise)
    render(<Settings repoPath="/tmp/r" />)

    expect(screen.getByRole('status').textContent).toContain('加载中')
    request.resolve(config)
    expect(await screen.findByRole('tab', { name: '通用' })).toBeDefined()
  })

  it('shows a load error and retries', async () => {
    const cause = new Error('config unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(api.getConfig).mockRejectedValueOnce(cause).mockResolvedValueOnce(config)
    render(<Settings repoPath="/tmp/r" />)

    expect(await screen.findByText('配置加载失败')).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      { err: cause, repoPath: '/tmp/r' },
      'Failed to load settings',
    )
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('tab', { name: '通用' })).toBeDefined()
  })

  it('saves a profile through the native select and refreshes config and manifest', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByRole('tab', { name: '通用' })
    fireEvent.click(screen.getByRole('button', { name: '仓库级' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Profile' }), {
      target: { value: 'personal' },
    })

    await waitFor(() =>
      expect(api.putConfig).toHaveBeenCalledWith({
        repo: '/tmp/r',
        level: 'repo',
        field: 'profile',
        value: 'personal',
      }),
    )
    await waitFor(() => expect(api.getManifest).toHaveBeenCalledWith('/tmp/r'))
    expect(api.getConfig).toHaveBeenCalledTimes(2)
  })

  it('keeps active_repo visibly read-only without a transactional switch API', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByRole('tab', { name: '通用' })
    fireEvent.click(screen.getByRole('button', { name: '本地级' }))

    const activeRepo = screen.getByRole('combobox', { name: 'Active repo' })
    expect((activeRepo as HTMLSelectElement).value).toBe('default')
    expect(activeRepo.hasAttribute('disabled')).toBe(true)
  })
})
