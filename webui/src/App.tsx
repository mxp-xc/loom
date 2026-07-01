import { useEffect, useState } from 'react'
import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { api } from './lib/api'
import Skills from './views/Skills'
import Mcp from './views/Mcp'
import Sync from './views/Sync'
import Settings from './views/Settings'

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [activeRepo, setActiveRepo] = useState<string>('')
  const [profile, setProfile] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.init().then((res) => {
      setRepoPath(res.repoPath)
      setActiveRepo(res.active_repo)
      api.getManifest(res.repoPath).then((m: any) => setProfile(m.config?.profile ?? '')).catch(() => {})
      setLoading(false)
    }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    })
  }, [])

  if (loading) return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--muted)' }}>
      <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 14 }}>◆ loom initializing…</span>
    </div>
  )
  if (error) return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--error)' }}>
      <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 14 }}>初始化失败: {error}</span>
    </div>
  )
  if (!repoPath) return null

  return (
    <>
      <div className="statusline">
        <span className="brand">◆ loom</span>
        <span className="v">{activeRepo}</span>
        <span>·</span>
        <span className="v">{profile || 'default'}</span>
        <span className="sync"><span className="dot" />synced</span>
      </div>
      <div className="shell">
        <aside className="sidebar">
          <div className="nav-section"><span className="label">workspace</span></div>
          <NavLink to="/skills" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ic">✦</span>Skills
          </NavLink>
          <NavLink to="/mcp" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ic">⌘</span>MCP servers
          </NavLink>
          <NavLink to="/sync" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ic">⇅</span>Sync
          </NavLink>
          <div className="nav-section"><span className="label">system</span></div>
          <NavLink to="/settings" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ic">⚙</span>Settings
          </NavLink>
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
