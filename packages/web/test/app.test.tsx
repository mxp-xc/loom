// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/theme'
import App from '../src/App'

const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true } as const

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
  beforeEach(() => {
    localStorage.clear()
  })

  function renderApp() {
    render(
      <ThemeProvider defaultTheme="light">
        <MemoryRouter future={routerFuture}>
          <App />
        </MemoryRouter>
      </ThemeProvider>,
    )
  }

  it('renders navigation with five items', async () => {
    renderApp()
    expect(await screen.findByText('Skills', { exact: true })).toBeDefined()
    expect(screen.getByText('MCP servers', { exact: true })).toBeDefined()
    expect(screen.getByText('Variables', { exact: true })).toBeDefined()
    expect(screen.getByText('Sync', { exact: true })).toBeDefined()
    expect(screen.getByText('Settings', { exact: true })).toBeDefined()
  })

  it('collapses the sidebar to icon-only navigation', async () => {
    renderApp()

    await screen.findByText('Skills', { exact: true })
    fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))

    const sidebar = screen.getByLabelText('主导航')
    const skillsLabel = screen.getByLabelText('Skills').querySelector('.nav-text')

    expect(sidebar.getAttribute('data-collapsed')).toBe('true')
    expect(skillsLabel?.getAttribute('aria-hidden')).toBe('true')
    expect(localStorage.getItem('loom-sidebar-collapsed')).toBe('true')
  })

  it('resizes the sidebar by dragging the separator', async () => {
    renderApp()

    await screen.findByText('Skills', { exact: true })
    const resizer = screen.getByRole('separator', { name: '调整侧边栏宽度' })
    const sidebar = screen.getByLabelText('主导航')
    const shell = sidebar.parentElement as HTMLElement

    fireEvent(resizer, new MouseEvent('pointerdown', { bubbles: true, clientX: 208 }))
    fireEvent(window, new MouseEvent('pointermove', { bubbles: true, clientX: 280 }))
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true }))

    await waitFor(() => {
      expect(shell.style.getPropertyValue('--sidebar-width')).toBe('280px')
    })
    expect(localStorage.getItem('loom-sidebar-width')).toBe('280')
  })
})
