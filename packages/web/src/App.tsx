import { useEffect, useState } from 'react'
import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { api } from './lib/api'
import Skills from './views/skills/Skills'
import Mcp from './views/Mcp'
import Sync from './views/Sync'
import Settings from './views/Settings'
import { useManifest } from './hooks/useManifest'
import { useViewError } from './hooks/useViewError'
import { useTheme } from './theme'
import { Button } from '@/components/ui/button'
import { Sun, Moon, Monitor } from 'lucide-react'

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
  return (
    <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border)', padding: '10px 18px' }}>
      <span className="label">theme</span>
      <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
        {modes.map((m) => (
          <Button
            key={m}
            variant="ghost"
            size="xs"
            onClick={() => setTheme(m)}
            style={{
              padding: '3px 8px',
              border: '1px solid transparent',
              transition: 'all var(--dur) var(--ease)',
              ...(theme === m
                ? {
                    background: 'var(--primary)',
                    color: 'var(--primary-fg)',
                    borderColor: 'var(--primary)',
                  }
                : {
                    background: 'transparent',
                    color: 'var(--muted)',
                    borderColor: 'var(--border)',
                    opacity: 0.65,
                  }),
            }}
          >
            {m === 'light' ? (
              <Sun className="h-3 w-3" />
            ) : m === 'dark' ? (
              <Moon className="h-3 w-3" />
            ) : (
              <Monitor className="h-3 w-3" />
            )}
          </Button>
        ))}
      </div>
    </div>
  )
}

// Rendered once init resolves and repoPath is known, so useManifest can be
// called unconditionally and share its cache with the active view.
function Shell({ repoPath, activeRepo }: { repoPath: string; activeRepo: string }) {
  const { manifest } = useManifest(repoPath)
  const profile = manifest?.config?.profile ?? ''
  return (
    <>
      <div className="statusline">
        <span className="brand">◆ loom</span>
        <span className="v">{activeRepo}</span>
        <span>·</span>
        <span className="v">{profile || 'default'}</span>
        <span className="sync">
          <span className="dot" />
          synced
        </span>
      </div>
      <div className="shell">
        <aside className="sidebar">
          <div className="nav-section">
            <span className="label">workspace</span>
          </div>
          <NavLink
            to="/skills"
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <span className="ic">✦</span>Skills
          </NavLink>
          <NavLink to="/mcp" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ic">⌘</span>MCP servers
          </NavLink>
          <NavLink
            to="/sync"
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <span className="ic">⇅</span>Sync
          </NavLink>
          <div className="nav-section">
            <span className="label">system</span>
          </div>
          <NavLink
            to="/settings"
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <span className="ic">⚙</span>Settings
          </NavLink>
          <ThemeSwitcher />
        </aside>
        <main className="main">
          <Routes>
            <Route index element={<Navigate to="/skills" replace />} />
            <Route path="skills" element={<Skills repoPath={repoPath} />} />
            <Route path="mcp" element={<Mcp repoPath={repoPath} />} />
            <Route path="sync" element={<Sync repoPath={repoPath} />} />
            <Route path="settings" element={<Settings repoPath={repoPath} />} />
          </Routes>
        </main>
      </div>
    </>
  )
}

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [activeRepo, setActiveRepo] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const { error, setError } = useViewError()

  useEffect(() => {
    api
      .init()
      .then((res) => {
        setRepoPath(res.repoPath)
        setActiveRepo(res.active_repo)
        setLoading(false)
      })
      .catch((e) => {
        setError(e)
        setLoading(false)
      })
  }, [])

  if (loading)
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--muted)',
        }}
      >
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>
          ◆ loom initializing…
        </span>
      </div>
    )
  if (error)
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--error)',
        }}
      >
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>
          初始化失败: {error}
        </span>
      </div>
    )
  if (!repoPath) return null

  return <Shell repoPath={repoPath} activeRepo={activeRepo} />
}
