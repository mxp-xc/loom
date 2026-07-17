import { agentName, type AgentId } from '@/lib/agents'
import type { Manifest } from '@loom/core'
import { AgentChip } from '@/components/ui/AgentChip'
import type { ManifestOperations } from '@/hooks/useManifestOperations'

interface Props {
  manifest: Manifest
  agents: AgentId[]
  operations: ManifestOperations
}

export default function GlobalAgentsBar({ manifest, agents, operations }: Props) {
  const sourceCount = manifest.skills?.sources?.length ?? 0
  const localCount = manifest.skills?.skills?.length ?? 0
  const skills = [
    ...(manifest.skills?.sources.flatMap((source) =>
      (source.members ?? []).map((member) => ({ kind: 'source' as const, source, member })),
    ) ?? []),
    ...(manifest.skills?.skills.map((skill) => ({ kind: 'local' as const, skill })) ?? []),
  ]

  const anyUpdating = agents.some((agent) => operations.pending.skills.allAgents(agent))

  if (agents.length === 0 || (sourceCount === 0 && localCount === 0)) return null

  return (
    <div
      className="global-agents-bar"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
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
          fontSize: 13,
          color: 'var(--muted)',
        }}
      >
        批量设置 · 应用于全部 skills
      </span>
      <span className="agent-chips" style={{ display: 'flex', gap: 7 }}>
        {agents.map((agent) => {
          const count = skills.filter((item) =>
            (item.kind === 'source' ? item.member.agents : item.skill.agents)?.includes(agent),
          ).length
          const state = count === 0 ? 'off' : count === skills.length ? 'on' : 'mixed'
          const status =
            state === 'on' ? '全部已选择' : state === 'mixed' ? '部分已选择' : '全部未选择'
          const tooltip = state === 'mixed' ? `${status} ${count}/${skills.length}` : status
          return (
            <AgentChip
              key={agent}
              agent={agent}
              state={state}
              label={`${agentName[agent]}：${status}`}
              tooltip={tooltip}
              disabled={anyUpdating}
              onClick={() => void operations.setAllSkillAgents(manifest, agent)}
            />
          )
        })}
      </span>
    </div>
  )
}
