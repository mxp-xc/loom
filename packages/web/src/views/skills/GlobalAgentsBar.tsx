import { agentName, type AgentId } from '@/lib/agents'
import type { Manifest } from '@loom/core'
import { AgentChip } from '@/components/ui/AgentChip'
import type { ManifestOperations } from '@/hooks/useManifestOperations'
import SharedSkillChip from './SharedSkillChip'

interface Props {
  manifest: Manifest
  agents: AgentId[]
  operations: ManifestOperations
}

export default function GlobalAgentsBar({ manifest, agents, operations }: Props) {
  const skills = [
    ...(manifest.skills?.sources.flatMap((source) =>
      (source.members ?? []).map((member) => ({ kind: 'source' as const, source, member })),
    ) ?? []),
    ...(manifest.skills?.skills.map((skill) => ({ kind: 'local' as const, skill })) ?? []),
  ]

  if (skills.length === 0) return null
  const sharedCount = skills.filter((item) =>
    item.kind === 'source' ? item.member.shared === true : item.skill.shared === true,
  ).length
  const sharedState = sharedCount === 0 ? 'off' : sharedCount === skills.length ? 'on' : 'mixed'
  const sharedStatus =
    sharedState === 'on' ? '全部已选择' : sharedState === 'mixed' ? '部分已选择' : '全部未选择'

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
              disabled={operations.pending.skills.agents}
              onClick={() => void operations.setAllSkillAgents(manifest, agent)}
            />
          )
        })}
        {agents.length > 0 && <span className="skill-destination-divider" aria-hidden="true" />}
        <SharedSkillChip
          state={sharedState}
          label={`通用：${sharedStatus}`}
          count={sharedState === 'mixed' ? `${sharedCount}/${skills.length}` : undefined}
          disabled={operations.pending.skills.assignments}
          onClick={() => void operations.setAllSkillShared(manifest)}
        />
      </span>
    </div>
  )
}
