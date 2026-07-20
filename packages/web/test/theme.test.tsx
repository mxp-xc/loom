// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { ThemeProvider, useTheme } from '../src/theme'

function Probe() {
  const { theme } = useTheme()
  return <div data-testid="theme">{theme}</div>
}

function matchMediaStub(matches: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  window.matchMedia = matchMediaStub(false) as unknown as typeof window.matchMedia
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ThemeProvider', () => {
  it('defaults to auto without persisting a user preference', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 19, 12))

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('auto')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('loom-theme')).toBeNull()
  })

  it('reads persisted theme from localStorage', () => {
    localStorage.setItem('loom-theme', 'dark')
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('system theme resolves via matchMedia (dark)', () => {
    window.matchMedia = matchMediaStub(true) as unknown as typeof window.matchMedia
    render(
      <ThemeProvider defaultTheme="system">
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it.each([
    [new Date(2026, 6, 19, 6), 'light'],
    [new Date(2026, 6, 19, 17, 59), 'light'],
    [new Date(2026, 6, 19, 18), 'dark'],
    [new Date(2026, 6, 19, 5, 59), 'dark'],
  ])('auto theme resolves %s as %s', (now, appliedTheme) => {
    vi.useFakeTimers()
    vi.setSystemTime(now)

    render(
      <ThemeProvider defaultTheme="auto">
        <Probe />
      </ThemeProvider>,
    )

    expect(screen.getByTestId('theme').textContent).toBe('auto')
    expect(document.documentElement.getAttribute('data-theme')).toBe(appliedTheme)
  })

  it('auto theme switches at the next light/dark boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 19, 17, 59, 59, 900))

    render(
      <ThemeProvider defaultTheme="auto">
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    act(() => vi.advanceTimersByTime(100))

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('reacts to system theme changes and removes its listener on unmount', () => {
    let matches = false
    const listeners = new Set<() => void>()
    const addEventListener = vi.fn((_event: string, listener: () => void) =>
      listeners.add(listener),
    )
    const removeEventListener = vi.fn((_event: string, listener: () => void) =>
      listeners.delete(listener),
    )
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia

    const view = render(
      <ThemeProvider defaultTheme="system">
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    matches = true
    act(() => listeners.forEach((listener) => listener()))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    view.unmount()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('resyncs auto theme when the page becomes visible and cleans up the listener', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 19, 17))
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    let visibilityState: DocumentVisibilityState = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    })

    const view = render(
      <ThemeProvider defaultTheme="auto">
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    vi.setSystemTime(new Date(2026, 6, 19, 20))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    visibilityState = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    view.unmount()
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    removeEventListener.mockRestore()
  })

  it('ignores an invalid persisted theme', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 19, 20))
    localStorage.setItem('loom-theme', 'invalid')
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('auto')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('setTheme persists to localStorage and applies', () => {
    function Setter() {
      const { setTheme } = useTheme()
      return <button onClick={() => setTheme('dark')}>go dark</button>
    }
    render(
      <ThemeProvider>
        <Setter />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByText('go dark'))
    expect(localStorage.getItem('loom-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('throws when useTheme is used outside provider', () => {
    function Orphan() {
      useTheme()
      return null
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => render(<Orphan />)).toThrow(/useTheme must be used within ThemeProvider/)
    } finally {
      consoleError.mockRestore()
    }
  })
})
