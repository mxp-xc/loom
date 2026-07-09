import { useEffect, useState } from 'react'

export type UiTheme = 'dark' | 'light'

export function readUiTheme(): UiTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function monacoThemeName(theme: UiTheme): 'vs-dark' | 'vs' {
  return theme === 'dark' ? 'vs-dark' : 'vs'
}

export function useMonacoUiTheme(): UiTheme {
  const [theme, setTheme] = useState<UiTheme>(() => readUiTheme())

  useEffect(() => {
    const syncTheme = () => setTheme(readUiTheme())
    syncTheme()

    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return

    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributeFilter: ['data-theme'],
      attributes: true,
    })

    return () => observer.disconnect()
  }, [])

  return theme
}
