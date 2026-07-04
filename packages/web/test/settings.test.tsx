// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Settings from '../src/views/Settings'

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(async () => ({
    effective: { active_repo: 'default', targets: ['claude-code'] },
    repo: { targets: ['claude-code'] },
    local: { active_repo: 'default' },
  })),
  putConfig: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../src/lib/api', () => ({
  api: apiMocks,
}))

describe('Settings', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockClear()
    apiMocks.putConfig.mockClear()
  })

  it('renders three state tabs (最终结果/仓库级/本地级)', async () => {
    render(<Settings repoPath="/tmp/r" />)
    expect(await screen.findByText('最终结果')).toBeDefined()
    expect(screen.getByText('仓库级')).toBeDefined()
    expect(screen.getByText('本地级')).toBeDefined()
  })

  it('sdot: effective tab active_repo=fixed, targets=repo', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    expect(document.querySelector('.sdot2.dot-fixed')).not.toBeNull()
    expect(document.querySelector('.sdot2.repo')).not.toBeNull()
  })

  it('switching to repo tab still shows active_repo as fixed', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByText('仓库级'))
    // active_repo is fixed local — dot stays fixed in all panes
    expect(document.querySelector('.sdot2.dot-fixed')).not.toBeNull()
  })

  it('saves target changes immediately without a global save or discard action', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByText('仓库级'))

    fireEvent.click(screen.getByText('OC'))

    await waitFor(() => {
      expect(apiMocks.putConfig).toHaveBeenCalledWith({
        repoPath: '/tmp/r',
        level: 'repo',
        field: 'targets',
        value: ['claude-code', 'opencode'],
      })
    })
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '放弃' })).toBeNull()
  })

  it('shows a target selection immediately while its save request is pending', async () => {
    let finishSave!: () => void
    apiMocks.putConfig.mockImplementationOnce(
      () => new Promise((resolve) => (finishSave = () => resolve({ ok: true }))),
    )
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByText('仓库级'))

    const oc = screen.getByText('OC')
    fireEvent.click(oc)

    expect(oc.classList.contains('on')).toBe(true)
    finishSave()
    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(2))
  })
})
