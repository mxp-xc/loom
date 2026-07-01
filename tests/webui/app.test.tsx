// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../../webui/src/App'

vi.mock('../../webui/src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    getManifest: vi.fn(async () => ({ skills: { sources: [], skills: [] }, mcp: [], vars: { default: {}, active: {} }, config: { targets: [], profile: 'local' }, errors: [] })),
    getConfig: vi.fn(async () => ({ effective: {}, repo: {}, local: {} })),
  },
}))

describe('App', () => {
  it('renders navigation with four items', async () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(await screen.findByText('Skills', { exact: true })).toBeDefined()
    expect(screen.getByText('MCP servers', { exact: true })).toBeDefined()
    expect(screen.getByText('Sync', { exact: true })).toBeDefined()
    expect(screen.getByText('Settings', { exact: true })).toBeDefined()
  })
})
