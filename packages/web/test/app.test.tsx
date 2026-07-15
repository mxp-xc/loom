// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/theme'
import App from '../src/App'
import { api } from '../src/lib/api'

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

vi.mock('../src/views/skills/Skills', () => ({
  default: () => <div>Skills page</div>,
}))

vi.mock('../src/views/Mcp', () => ({
  default: () => <div>MCP page</div>,
}))

vi.mock('../src/views/Memory', () => ({
  default: () => <div>Memory page</div>,
}))

vi.mock('../src/views/vars/Vars', () => ({
  default: () => <div>Vars page</div>,
}))

vi.mock('../src/views/vars/VarsProfileDemo', () => ({
  default: () => <div>Vars lab page</div>,
}))

vi.mock('../src/views/Sync', () => ({
  default: () => <div>Sync page</div>,
}))

vi.mock('../src/views/Settings', () => ({
  default: () => <div>Settings page</div>,
}))

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1024,
    })
  })

  function renderApp(initialPath = '/') {
    render(
      <ThemeProvider defaultTheme="light">
        <MemoryRouter future={routerFuture} initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>,
    )
  }

  it('renders navigation with five items', async () => {
    renderApp()
    expect(await screen.findByRole('link', { name: 'Skills' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'MCP servers' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Variables' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Sync' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeDefined()
  })

  it('initializes once during StrictMode effect replay', async () => {
    const callsBefore = vi.mocked(api.init).mock.calls.length
    render(
      <StrictMode>
        <ThemeProvider defaultTheme="light">
          <MemoryRouter future={routerFuture} initialEntries={['/skills']}>
            <App />
          </MemoryRouter>
        </ThemeProvider>
      </StrictMode>,
    )

    await screen.findByRole('link', { name: 'Skills' })
    expect(api.init).toHaveBeenCalledTimes(callsBefore + 1)
  })

  it.each([
    ['/skills', 'workbench'],
    ['/mcp', 'workbench'],
    ['/memory', 'fullHeight'],
    ['/vars', 'fullHeight'],
    ['/vars-lab', 'fullHeight'],
    ['/sync', 'content'],
    ['/settings', 'content'],
  ])('wraps %s in the %s page layout', async (path, variant) => {
    renderApp(path)

    await screen.findByRole('link', { name: 'Skills' })

    await waitFor(() => {
      const layout = document.querySelector('[data-page-layout]')
      expect(layout?.getAttribute('data-page-layout')).toBe(variant)
    })
  })

  it('collapses the sidebar to icon-only navigation', async () => {
    renderApp()

    await screen.findByRole('link', { name: 'Skills' })
    fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))

    const sidebar = screen.getByLabelText('主导航')
    const skillsLabel = screen.getByLabelText('Skills').querySelector('.nav-text')

    expect(sidebar.getAttribute('data-collapsed')).toBe('true')
    expect(skillsLabel?.getAttribute('aria-hidden')).toBe('true')
    expect(localStorage.getItem('loom-sidebar-collapsed')).toBe('true')
  })

  it('resizes the sidebar by dragging the separator', async () => {
    renderApp()

    await screen.findByRole('link', { name: 'Skills' })
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

  it('clamps stored sidebar width to the current viewport', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 900,
    })
    localStorage.setItem('loom-sidebar-width', '360')

    renderApp()

    await screen.findByRole('link', { name: 'Skills' })
    const sidebar = screen.getByLabelText('主导航')
    const shell = sidebar.parentElement as HTMLElement

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('270px')
  })
})
