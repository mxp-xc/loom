import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { api } from './lib/api'
import ToastHost from './components/ToastHost'
import Skills from './views/skills/Skills'
import Mcp from './views/Mcp'
import Memory from './views/Memory'
import Sync from './views/Sync'
import Settings from './views/Settings'
import Vars from './views/vars/Vars'
import VarsProfileDemo from './views/vars/VarsProfileDemo'
import { useManifest } from './hooks/useManifest'
import { useViewError } from './hooks/useViewError'
import { useTheme } from './theme'
import { Button } from '@/components/ui/button'
import {
  Braces,
  Command,
  GripVertical,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
} from 'lucide-react'

const SIDEBAR_WIDTH_KEY = 'loom-sidebar-width'
const SIDEBAR_COLLAPSED_KEY = 'loom-sidebar-collapsed'
const MIN_SIDEBAR_WIDTH = 176
const DEFAULT_SIDEBAR_WIDTH = MIN_SIDEBAR_WIDTH
const MAX_SIDEBAR_WIDTH = 360
const COLLAPSED_SIDEBAR_WIDTH = 64

function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

function readStoredSidebarWidth() {
  if (typeof localStorage === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  const stored = Number.parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '', 10)
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH
}

function readStoredSidebarCollapsed() {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
}

function useNarrowSidebarViewport() {
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 700px)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 700px)')
    const update = () => setIsNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return isNarrow
}

function SidebarNavLink({
  to,
  label,
  icon,
  collapsed,
}: {
  to: string
  label: string
  icon: ReactNode
  collapsed: boolean
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
      aria-label={label}
      title={label}
    >
      <span className="ic" aria-hidden="true">
        {icon}
      </span>
      <span className="nav-text" aria-hidden={collapsed ? 'true' : undefined}>
        {label}
      </span>
    </NavLink>
  )
}

function ThemeSwitcher({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme()
  const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
  const labels: Record<'light' | 'dark' | 'system', string> = {
    light: '浅色主题',
    dark: '深色主题',
    system: '跟随系统主题',
  }
  return (
    <div className="theme-switcher" data-collapsed={collapsed ? 'true' : undefined}>
      <span className="label" aria-hidden={collapsed ? 'true' : undefined}>
        theme
      </span>
      <div className="theme-options">
        {modes.map((m) => (
          <Button
            key={m}
            variant="ghost"
            size="xs"
            aria-label={labels[m]}
            aria-pressed={theme === m}
            title={labels[m]}
            onClick={() => setTheme(m)}
            style={{
              width: collapsed ? 32 : undefined,
              padding: collapsed ? 0 : '3px 8px',
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
  const isNarrowSidebarViewport = useNarrowSidebarViewport()
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [storedSidebarCollapsed, setStoredSidebarCollapsed] = useState(readStoredSidebarCollapsed)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarCollapsed = storedSidebarCollapsed && !isNarrowSidebarViewport
  const shellStyle = {
    '--sidebar-width': `${sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth}px`,
  } as CSSProperties

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(storedSidebarCollapsed))
  }, [storedSidebarCollapsed])

  useEffect(() => {
    if (!resizingSidebar) return

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(event.clientX))
    }
    const stopResizing = () => setResizingSidebar(false)

    document.body.classList.add('sidebar-resizing')
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)

    return () => {
      document.body.classList.remove('sidebar-resizing')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  }, [resizingSidebar])

  const beginSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) return
    event.preventDefault()
    setResizingSidebar(true)
    setSidebarWidth(clampSidebarWidth(event.clientX))
  }

  const handleSidebarResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) return

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebarWidth((width) => clampSidebarWidth(width - 16))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebarWidth((width) => clampSidebarWidth(width + 16))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSidebarWidth(MIN_SIDEBAR_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSidebarWidth(MAX_SIDEBAR_WIDTH)
    }
  }

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
      <div
        className="shell"
        style={shellStyle}
        data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
        data-sidebar-resizing={resizingSidebar ? 'true' : undefined}
      >
        <aside
          id="loom-main-sidebar"
          className="sidebar"
          aria-label="主导航"
          data-collapsed={sidebarCollapsed ? 'true' : 'false'}
        >
          <div className="sidebar-toolbar">
            <span className="label" aria-hidden={sidebarCollapsed ? 'true' : undefined}>
              workspace
            </span>
            <button
              className="sidebar-collapse-button"
              type="button"
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="loom-main-sidebar"
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              onClick={() => setStoredSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </div>
          <SidebarNavLink
            to="/skills"
            label="Skills"
            icon={<Sparkles size={15} />}
            collapsed={sidebarCollapsed}
          />
          <SidebarNavLink
            to="/mcp"
            label="MCP servers"
            icon={<Command size={15} />}
            collapsed={sidebarCollapsed}
          />
          <SidebarNavLink
            to="/memory"
            label="Memory"
            icon={<PencilLine size={15} />}
            collapsed={sidebarCollapsed}
          />
          <SidebarNavLink
            to="/vars"
            label="Variables"
            icon={<Braces size={15} />}
            collapsed={sidebarCollapsed}
          />
          <SidebarNavLink
            to="/sync"
            label="Sync"
            icon={<RefreshCw size={15} />}
            collapsed={sidebarCollapsed}
          />
          <div className="nav-section">
            <span className="label" aria-hidden={sidebarCollapsed ? 'true' : undefined}>
              system
            </span>
          </div>
          <SidebarNavLink
            to="/settings"
            label="Settings"
            icon={<SettingsIcon size={15} />}
            collapsed={sidebarCollapsed}
          />
          <ThemeSwitcher collapsed={sidebarCollapsed} />
          {!sidebarCollapsed && (
            <div
              className="sidebar-resizer"
              role="separator"
              aria-label="调整侧边栏宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_SIDEBAR_WIDTH}
              aria-valuemax={MAX_SIDEBAR_WIDTH}
              aria-valuenow={sidebarWidth}
              tabIndex={0}
              title="拖拽调整侧边栏宽度"
              onPointerDown={beginSidebarResize}
              onKeyDown={handleSidebarResizeKeyDown}
            >
              <GripVertical size={12} aria-hidden="true" />
            </div>
          )}
        </aside>
        <main className="main">
          <Routes>
            <Route index element={<Navigate to="/skills" replace />} />
            <Route path="skills" element={<Skills repoPath={repoPath} />} />
            <Route path="mcp" element={<Mcp repoPath={repoPath} />} />
            <Route path="memory" element={<Memory repoPath={repoPath} />} />
            <Route path="vars" element={<Vars repoPath={repoPath} />} />
            <Route path="vars-lab" element={<VarsProfileDemo />} />
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
        setRepoPath(res.active_repo)
        setActiveRepo(res.active_repo)
        setLoading(false)
      })
      .catch((e) => {
        console.error('Failed to initialize Loom', e)
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

  return (
    <>
      <Shell repoPath={repoPath} activeRepo={activeRepo} />
      <ToastHost />
    </>
  )
}
