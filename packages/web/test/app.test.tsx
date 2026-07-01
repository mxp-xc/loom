// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/theme'
import App from '../src/App'

vi.mock('../src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    getManifest: vi.fn(async () => ({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: [], profile: 'local' },
      errors: [],
    })),
    getConfig: vi.fn(async () => ({ effective: {}, repo: {}, local: {} })),
    getSyncRemote: vi.fn(async () => ({ remoteUrl: null })),
    setSyncRemote: vi.fn(async () => ({ ok: true })),
    syncPull: vi.fn(async () => ({ clean: true, files: [], textConflicts: [] })),
    syncPush: vi.fn(async () => ({ ok: true })),
    syncApply: vi.fn(async () => ({ ok: true })),
  },
}))

describe('App', () => {
  it('renders navigation with four items', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </ThemeProvider>,
    )
    expect(await screen.findByText('Skills', { exact: true })).toBeDefined()
    expect(screen.getByText('MCP servers', { exact: true })).toBeDefined()
    expect(screen.getByText('Sync', { exact: true })).toBeDefined()
    expect(screen.getByText('Settings', { exact: true })).toBeDefined()
  })
})
