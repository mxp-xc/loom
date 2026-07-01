// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Skills from '../../webui/src/views/Skills'
import Sync from '../../webui/src/views/Sync'

vi.mock('../../webui/src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    status: vi.fn(async () => ({ active_repo: 'default', repoPath: '/tmp/r' })),
    project: vi.fn(async () => ({ ok: true })),
    syncPull: vi.fn(async () => ({ clean: true, files: [], textConflicts: [] })),
    syncPush: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(async () => ({ effective: {}, repo: {}, local: {} })),
    getManifest: vi.fn(async () => ({ skills: { sources: [], skills: [] }, mcp: [], vars: { default: {}, active: {} }, config: { targets: ['claude-code', 'codex'] }, errors: [] })),
  },
}))

describe('Skills view', () => {
  it('renders heading and project button', async () => {
    render(<MemoryRouter><Skills repoPath="/tmp/r" /></MemoryRouter>)
    expect(await screen.findByText('投影', { exact: false })).toBeDefined()
  })
})

describe('Sync view', () => {
  it('renders pull and push buttons', () => {
    render(<MemoryRouter><Sync repoPath="/tmp/r" /></MemoryRouter>)
    expect(screen.getByText('⇅ 拉取', { exact: true })).toBeDefined()
    expect(screen.getByText('↑ 上传', { exact: true })).toBeDefined()
  })
})
