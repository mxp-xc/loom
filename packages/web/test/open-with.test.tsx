// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenWith } from '../src/components/ui/OpenWith'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', () => ({
  api: {
    getOpenPathPreference: vi.fn(),
    setOpenPathPreference: vi.fn(),
    resolvePath: vi.fn(),
    openPath: vi.fn(),
  },
}))

describe('OpenWith', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getOpenPathPreference).mockResolvedValue({ application: 'vscode' })
    vi.mocked(api.setOpenPathPreference).mockResolvedValue({ ok: true })
    vi.mocked(api.resolvePath).mockResolvedValue({ ok: true, path: '/repo/docs/guide.txt' })
    vi.mocked(api.openPath).mockResolvedValue({ ok: true })
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  it('opens the target with the currently selected application', async () => {
    render(<OpenWith repo="default" path="docs/guide.txt" />)

    fireEvent.click(await screen.findByRole('button', { name: '使用 VS Code 打开' }))

    await waitFor(() =>
      expect(api.openPath).toHaveBeenCalledWith({
        repo: 'default',
        path: 'docs/guide.txt',
        application: 'vscode',
      }),
    )
  })

  it('renders the menu at body level and opens with the chosen application', async () => {
    const { container } = render(<OpenWith repo="default" path="docs" />)

    await screen.findByRole('button', { name: '使用 VS Code 打开' })
    fireEvent.click(screen.getByRole('button', { name: '选择打开方式' }))
    const menu = screen.getByRole('menu', { name: '使用其他应用打开' })
    expect(menu.parentElement).toBe(document.body)
    expect(container.contains(menu)).toBe(false)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Zed' }))

    await waitFor(() =>
      expect(api.openPath).toHaveBeenCalledWith({
        repo: 'default',
        path: 'docs',
        application: 'zed',
      }),
    )
    expect(api.setOpenPathPreference).toHaveBeenCalledWith('zed')
    expect(screen.getByRole('button', { name: '使用 Zed 打开' })).toBeDefined()
  })

  it('loads the device-wide application preference', async () => {
    vi.mocked(api.getOpenPathPreference).mockResolvedValueOnce({ application: 'zed' })

    render(<OpenWith repo="default" path="docs" />)

    expect(await screen.findByRole('button', { name: '使用 Zed 打开' })).toBeDefined()
  })

  it('does not render a fallback application while the preference is loading', async () => {
    let resolvePreference: (value: { application: 'zed' }) => void = () => {}
    vi.mocked(api.getOpenPathPreference).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreference = resolve
      }),
    )

    render(<OpenWith repo="default" path="docs" />)

    expect(screen.queryByRole('button', { name: '使用 VS Code 打开' })).toBeNull()
    expect(screen.getByRole('button', { name: '正在加载打开方式' }).querySelector('img')).toBeNull()

    await act(async () => resolvePreference({ application: 'zed' }))
    expect(await screen.findByRole('button', { name: '使用 Zed 打开' })).toBeDefined()
  })

  it('uses packaged application icons in the launcher and menu', async () => {
    render(<OpenWith repo="default" path="docs" />)

    const primaryIcon = screen
      .getByRole('button', { name: '正在加载打开方式' })
      .querySelector('img')
    expect(primaryIcon).toBeNull()

    const loadedPrimaryIcon = (
      await screen.findByRole('button', { name: '使用 VS Code 打开' })
    ).querySelector('img')
    expect(loadedPrimaryIcon?.getAttribute('src')).toContain('vscode')

    fireEvent.click(screen.getByRole('button', { name: '选择打开方式' }))
    expect(
      screen.getByRole('menuitem', { name: 'Zed' }).querySelector('img')?.getAttribute('src'),
    ).toContain('zed')
    expect(
      screen.getByRole('menuitem', { name: 'Finder' }).querySelector('img')?.getAttribute('src'),
    ).toContain('finder')
  })

  it('closes with Escape and restores focus to the menu trigger', async () => {
    render(<OpenWith repo="default" path="docs" />)
    await screen.findByRole('button', { name: '使用 VS Code 打开' })
    const trigger = screen.getByRole('button', { name: '选择打开方式' })
    fireEvent.click(trigger)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('copies the resolved absolute path from the dropdown menu', async () => {
    const onPathCopied = vi.fn()
    render(<OpenWith repo="default" path="docs/guide.txt" onPathCopied={onPathCopied} />)
    await screen.findByRole('button', { name: '使用 VS Code 打开' })
    const trigger = screen.getByRole('button', { name: '选择打开方式' })
    fireEvent.click(trigger)

    fireEvent.click(screen.getByRole('menuitem', { name: '复制路径' }))

    await waitFor(() => {
      expect(api.resolvePath).toHaveBeenCalledWith({ repo: 'default', path: 'docs/guide.txt' })
      expect(writeText).toHaveBeenCalledWith('/repo/docs/guide.txt')
      expect(onPathCopied).toHaveBeenCalledWith('/repo/docs/guide.txt')
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('reports copy path failures to its consumer', async () => {
    const error = new Error('target missing')
    const onPathCopyError = vi.fn()
    vi.mocked(api.resolvePath).mockRejectedValueOnce(error)
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    render(<OpenWith repo="default" path="missing" onPathCopyError={onPathCopyError} />)
    await screen.findByRole('button', { name: '使用 VS Code 打开' })
    fireEvent.click(screen.getByRole('button', { name: '选择打开方式' }))

    fireEvent.click(screen.getByRole('menuitem', { name: '复制路径' }))

    await waitFor(() => expect(onPathCopyError).toHaveBeenCalledWith(error))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reports open failures to its consumer', async () => {
    const error = new Error('missing app')
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(api.openPath).mockRejectedValueOnce(error)

    try {
      render(<OpenWith repo="default" path="docs" onError={onError} />)

      fireEvent.click(await screen.findByRole('button', { name: '使用 VS Code 打开' }))

      await waitFor(() => expect(onError).toHaveBeenCalledWith(error, 'vscode'))
      expect(consoleError).toHaveBeenCalledWith(
        { err: error, application: 'vscode', path: 'docs' },
        'Failed to open path',
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
