// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Settings from '../src/views/Settings'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', () => ({
  api: {
    getConfig: vi.fn(async () => ({
      effective: { active_repo: 'default', agents: ['claude-code'] },
      repo: { agents: ['claude-code'] },
      local: { active_repo: 'default' },
    })),
    putConfig: vi.fn(async () => ({ ok: true })),
    getManifest: vi.fn(async () => ({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code'] },
      errors: [],
    })),
  },
}))

describe('Settings', () => {
  it('renders three state tabs (最终结果/仓库级/本地级)', async () => {
    render(<Settings repoPath="/tmp/r" />)
    expect(await screen.findByText('最终结果')).toBeDefined()
    expect(screen.getByText('仓库级')).toBeDefined()
    expect(screen.getByText('本地级')).toBeDefined()
  })

  it('sdot: effective tab active_repo=fixed, agents=repo', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    expect(screen.getByTitle('固定本地级')).toBeDefined()
    expect(screen.getByTitle('仓库级已设')).toBeDefined()
  })

  it('switching to repo tab still shows active_repo as fixed', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByText('仓库级'))
    // active_repo is fixed local — dot stays fixed in all panes
    expect(screen.getByTitle('固定本地级')).toBeDefined()
  })

  it('refreshes shared manifest after saving agents', async () => {
    const getConfigCallsBefore = vi.mocked(api.getConfig).mock.calls.length
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByText('仓库级'))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))

    await waitFor(() => expect(api.getManifest).toHaveBeenCalledWith('/tmp/r'))
    await waitFor(() => expect(api.getConfig).toHaveBeenCalledTimes(getConfigCallsBefore + 2))
  })

  it('does not render the old global save bar actions', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')

    expect(screen.queryByRole('button', { name: '放弃' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })
})
