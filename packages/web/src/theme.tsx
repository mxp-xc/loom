import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'dark' | 'light' | 'system' | 'auto'

const THEMES: Theme[] = ['dark', 'light', 'system', 'auto']
const AUTO_LIGHT_HOUR = 6
const AUTO_DARK_HOUR = 18

type ThemeContextValue = { theme: Theme; setTheme: (t: Theme) => void }

const ThemeContext = createContext<ThemeContextValue | null>(null)

function isTheme(value: string | null): value is Theme {
  return value !== null && THEMES.includes(value as Theme)
}

function resolveAutoTheme(now = new Date()): 'dark' | 'light' {
  const hour = now.getHours()
  return hour >= AUTO_LIGHT_HOUR && hour < AUTO_DARK_HOUR ? 'light' : 'dark'
}

function millisecondsUntilAutoSwitch(now = new Date()): number {
  const next = new Date(now)
  const hour = now.getHours()

  if (hour < AUTO_LIGHT_HOUR) {
    next.setHours(AUTO_LIGHT_HOUR, 0, 0, 0)
  } else if (hour < AUTO_DARK_HOUR) {
    next.setHours(AUTO_DARK_HOUR, 0, 0, 0)
  } else {
    next.setDate(next.getDate() + 1)
    next.setHours(AUTO_LIGHT_HOUR, 0, 0, 0)
  }

  return Math.max(0, next.getTime() - now.getTime())
}

function resolveApplied(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  if (theme === 'auto') return resolveAutoTheme()
  return theme
}

export function ThemeProvider({
  children,
  defaultTheme = 'light',
  storageKey = 'loom-theme',
}: {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const storedTheme = localStorage.getItem(storageKey)
    return isTheme(storedTheme) ? storedTheme : defaultTheme
  })

  useEffect(() => {
    const applyTheme = () => {
      document.documentElement.setAttribute('data-theme', resolveApplied(theme))
    }

    applyTheme()

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', applyTheme)
      return () => mediaQuery.removeEventListener('change', applyTheme)
    }

    if (theme !== 'auto') return

    let timer: ReturnType<typeof setTimeout>
    const scheduleNextSwitch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        applyTheme()
        scheduleNextSwitch()
      }, millisecondsUntilAutoSwitch())
    }
    const resyncTheme = () => {
      if (document.visibilityState === 'visible') {
        applyTheme()
        scheduleNextSwitch()
      }
    }

    scheduleNextSwitch()
    document.addEventListener('visibilitychange', resyncTheme)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resyncTheme)
    }
  }, [theme])

  const setTheme = (t: Theme) => {
    localStorage.setItem(storageKey, t)
    setThemeState(t)
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
