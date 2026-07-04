import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import type { Manifest } from '@loom/core'

interface Props {
  repoPath: string
  manifest: Manifest
  reload: () => void
  setError: (e: unknown) => void
}

const renderChip = (agent: AgentId, active: boolean, onClick?: () => void) => (
  <span
    key={agent}
    className={'chip ' + (active ? 'active' : 'inactive')}
    style={{ ['--c' as string]: agentColor[agent] }}
    onClick={onClick}
  >
    {agentShort[agent]}
  </span>
)

export default function GlobalTargetsBar({ repoPath, manifest, reload, setError }: Props) {
  const agents = manifest.config?.targets ?? []
  const allAgents: AgentId[] = [...AGENTS]
  const sourceCount = manifest.skills?.sources?.length ?? 0
  const localCount = manifest.skills?.skills?.length ?? 0

  const handleGlobalTargetToggle = async (agent: AgentId) => {
    const current = manifest.config?.targets ?? []
    const newTargets = current.includes(agent)
      ? current.filter((a) => a !== agent)
      : [...current, agent]
    try {
      await api.putConfig({ repoPath, level: 'repo', field: 'targets', value: newTargets })
      reload()
    } catch (e) {
      setError(e)
    }
  }

  if (sourceCount === 0 && localCount === 0) return null

  return (
    <div
      className="global-targets-bar"
      style={{
        display: 'grid',
        gridTemplateColumns: '12px minmax(0, 1fr) auto 90px 28px',
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
      <span />
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        全局 targets
      </span>
      <span className="chips" style={{ display: 'flex', gap: 7 }}>
        {allAgents.map((a) => renderChip(a, agents.includes(a), () => handleGlobalTargetToggle(a)))}
      </span>
      <span />
      <span />
    </div>
  )
}
