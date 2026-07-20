// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/theme'
import App from '../src/App'
import { api } from '../src/lib/api'
import { deferred } from './deferred'

const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true } as const

vi.mock('../src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    getManifest: vi.fn(async () => ({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: [], profile: 'local' },
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
  default: ({ repoPath }: { repoPath: string }) => <div>Skills page:{repoPath}</div>,
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
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(api.init).mockResolvedValue({
      ok: true,
      active_repo: 'default',
      repoPath: '/tmp/r',
    })
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

  it('persists the last clicked sidebar page', async () => {
    renderApp('/skills')

    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }))

    expect(await screen.findByText('Settings page')).toBeDefined()
    expect(localStorage.getItem('loom-sidebar-last-path')).toBe('/settings')
  })

  it('restores the last clicked sidebar page from the home route', async () => {
    localStorage.setItem('loom-sidebar-last-path', '/memory')

    renderApp('/')

    expect(await screen.findByText('Memory page')).toBeDefined()
  })

  it('falls back to Skills when the stored sidebar path is invalid', async () => {
    localStorage.setItem('loom-sidebar-last-path', '/vars-lab')

    renderApp('/')

    expect(await screen.findByText('Skills page:default')).toBeDefined()
  })

  it('keeps an explicit URL ahead of the stored sidebar page', async () => {
    localStorage.setItem('loom-sidebar-last-path', '/memory')

    renderApp('/mcp')

    expect(await screen.findByText('MCP page')).toBeDefined()
  })

  it('initializes once during StrictMode effect replay', async () => {
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
    expect(api.init).toHaveBeenCalledTimes(1)
  })

  it('passes the authorized repository name to routed pages', async () => {
    renderApp('/skills')

    expect(await screen.findByText('Skills page:default')).toBeDefined()
    expect(screen.getByText('default')).toBeDefined()
  })

  it('keeps the loading state until initialization resolves', async () => {
    const request = deferred<{ ok: true; active_repo: string; repoPath: string }>()
    vi.mocked(api.init).mockReturnValue(request.promise)
    renderApp('/skills')

    expect(screen.getByRole('status').textContent).toContain('initializing')
    request.resolve({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })
    expect(await screen.findByText('Skills page:default')).toBeDefined()
  })

  it.each([
    ['empty repository path', { ok: true, active_repo: 'default', repoPath: '' }],
    ['empty active repository', { ok: true, active_repo: '', repoPath: '/tmp/r' }],
  ])('shows an initialization error for %s', async (_label, response) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(api.init).mockResolvedValue(response)
    renderApp('/skills')

    expect(await screen.findByText('Loom 初始化失败')).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: '初始化响应缺少有效的 repository' }) },
      'Failed to initialize Loom',
    )
    expect(screen.queryByText('Skills page:default')).toBeNull()
  })

  it('redirects unknown routes to Skills', async () => {
    renderApp('/missing-page')

    expect(await screen.findByText('Skills page:default')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('aria-current')).toBe('page')
  })

  it('navigates between primary pages', async () => {
    renderApp('/skills')
    await screen.findByText('Skills page:default')

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))

    expect(await screen.findByText('Settings page')).toBeDefined()
  })

  it.each([
    ['/skills', 'workbench', 'Skills page:default'],
    ['/mcp', 'workbench', 'MCP page'],
    ['/memory', 'fullHeight', 'Memory page'],
    ['/vars', 'fullHeight', 'Vars page'],
    ['/vars-lab', 'fullHeight', 'Vars lab page'],
    ['/sync', 'content', 'Sync page'],
    ['/settings', 'content', 'Settings page'],
  ])('wraps %s in the %s page layout', async (path, variant, pageText) => {
    renderApp(path)

    await screen.findByText(pageText)

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

  it('selects and persists the automatic theme', async () => {
    renderApp()

    await screen.findByRole('link', { name: 'Skills' })
    const autoTheme = screen.getByRole('button', { name: '自动主题（06:00–18:00 浅色）' })
    fireEvent.click(autoTheme)

    expect(autoTheme.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('loom-theme')).toBe('auto')
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
