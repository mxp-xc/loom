import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import type { Manifest } from '@loom/core'
import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  repoPath: string
  manifest: Manifest
  reload: () => void
  setError: (e: unknown) => void
}

const renderChip = (agent: AgentId) => (
  <span key={agent} className="chip active" style={{ ['--c' as string]: agentColor[agent] }}>
    {agentShort[agent]}
  </span>
)

export default function GlobalTargetsBar({ manifest }: Props) {
  const agents = manifest.config?.targets ?? []
  const sourceCount = manifest.skills?.sources?.length ?? 0
  const localCount = manifest.skills?.skills?.length ?? 0

  if (sourceCount === 0 && localCount === 0) return null

  return (
    <div
      className="global-targets-bar"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        alignItems: 'center',
        gap: 12,
        marginTop: 14,
        marginBottom: 6,
        padding: '8px 14px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--card)',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        当前 targets
      </span>
      <span className="chips" style={{ display: 'flex', gap: 7 }}>
        {agents.map(renderChip)}
      </span>
      <Button asChild variant="ghost" size="xs">
        <Link to="/settings" title="在 Settings 中修改 targets">
          <Settings2 className="h-3.5 w-3.5" /> 设置
        </Link>
      </Button>
    </div>
  )
}
