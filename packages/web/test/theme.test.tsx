// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    expect(() => render(<Orphan />)).toThrow(/useTheme must be used within ThemeProvider/)
  })
})
