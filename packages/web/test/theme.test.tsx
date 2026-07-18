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
  it('defaults to light and sets data-theme=light', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
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

  it('auto theme switches at the next day boundary', () => {
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

  it('ignores an invalid persisted theme', () => {
    localStorage.setItem('loom-theme', 'invalid')
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme').textContent).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
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
