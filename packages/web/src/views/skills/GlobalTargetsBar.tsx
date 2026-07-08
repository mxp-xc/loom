import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import type { Manifest } from '@loom/core'
import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import type { ManifestOperations } from '@/hooks/useManifestOperations'

interface Props {
  manifest: Manifest
  operations: ManifestOperations
}

export default function GlobalTargetsBar({ manifest, operations }: Props) {
  const agents = (manifest.config?.targets ?? []) as AgentId[]
  const sourceCount = manifest.skills?.sources?.length ?? 0
  const localCount = manifest.skills?.skills?.length ?? 0
  const skills = [
    ...(manifest.skills?.sources.flatMap((source) =>
      (source.members ?? []).map((member) => ({ kind: 'source' as const, source, member })),
    ) ?? []),
    ...(manifest.skills?.skills.map((skill) => ({ kind: 'local' as const, skill })) ?? []),
  ]

  const anyUpdating = agents.some((agent) => operations.pending.skills.allTargets(agent))

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
        批量设置 · 应用于全部 skills
      </span>
      <span className="target-chips" style={{ display: 'flex', gap: 7 }}>
        {agents.map((agent) => {
          const count = skills.filter((item) =>
            (item.kind === 'source' ? item.member.targets : item.skill.targets)?.includes(agent),
          ).length
          const state = count === 0 ? 'off' : count === skills.length ? 'on' : 'mixed'
          const tooltip =
            state === 'on' ? '全部已选择' : state === 'mixed' ? '部分已选择' : '全部未选择'
          return (
            <button
              key={agent}
              type="button"
              className="target-chip"
              style={{ ['--c' as string]: agentColor[agent] }}
              data-state={state}
              aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
              aria-label={`${agentShort[agent]}：${state === 'on' ? '全部已选择' : state === 'mixed' ? '部分已选择' : '全部未选择'}`}
              data-tooltip={`${agentShort[agent]}：${tooltip}`}
              disabled={anyUpdating}
              onClick={() => void operations.setAllSkillTargets(manifest, agent)}
            >
              {agentShort[agent]}
              {state === 'mixed' && (
                <span className="target-chip-count">
                  {count}/{skills.length}
                </span>
              )}
            </button>
          )
        })}
      </span>
      <IconButton asChild label="在 Settings 中修改 targets" tooltip="设置">
        <Link to="/settings">
          <Settings2 className="h-3.5 w-3.5" />
        </Link>
      </IconButton>
    </div>
  )
}
