// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Settings from '../src/views/Settings'

vi.mock('../src/lib/api', () => ({
  api: {
    getConfig: vi.fn(async () => ({
      effective: { active_repo: 'default', targets: ['claude-code'] },
      repo: { targets: ['claude-code'] },
      local: { active_repo: 'default' },
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

  it('sdot: effective tab active_repo=fixed, targets=repo', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    expect(document.querySelector('.sdot-cfg.fixed')).not.toBeNull()
    expect(document.querySelector('.sdot-cfg.repo')).not.toBeNull()
  })

  it('switching to repo tab hides fixed active_repo field', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    // Radix TabsTrigger 在 onMouseDown(button 0) 时触发 onValueChange
    fireEvent.mouseDown(screen.getByText('仓库级'))
    // 仓库级 tab 过滤掉固定本地字段 active_repo
    expect(document.querySelector('.sdot-cfg.fixed')).toBeNull()
  })
})
