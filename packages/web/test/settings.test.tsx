// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Settings from '../src/views/Settings'

const { refreshManifest } = vi.hoisted(() => ({ refreshManifest: vi.fn(async () => {}) }))

vi.mock('../src/lib/api', () => ({
  api: {
    getConfig: vi.fn(async () => ({
      effective: { active_repo: 'default', targets: ['claude-code'] },
      repo: { targets: ['claude-code'] },
      local: { active_repo: 'default' },
    })),
    putConfig: vi.fn(async () => ({ ok: true })),
  },
}))

vi.mock('../src/hooks/useManifest', () => ({ refreshManifest }))

describe('Settings', () => {
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

  it('refreshes shared manifest after saving targets', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByText('仓库级'))
    fireEvent.click(screen.getByText('CC'))

    await waitFor(() => expect(refreshManifest).toHaveBeenCalledWith('/tmp/r'))
  })

  it('does not render the old global save bar actions', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')

    expect(screen.queryByRole('button', { name: '放弃' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })
})
