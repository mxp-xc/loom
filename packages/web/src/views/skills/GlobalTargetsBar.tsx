import { useState } from 'react'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import type { Manifest } from '@loom/core'
import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { api } from '@/lib/api'

interface Props {
  repoPath: string
  manifest: Manifest
  reload: () => void
  setError: (e: unknown) => void
}

export default function GlobalTargetsBar({ repoPath, manifest, reload, setError }: Props) {
  const [updatingAgent, setUpdatingAgent] = useState<AgentId | null>(null)
  const agents = (manifest.config?.targets ?? []) as AgentId[]
  const sourceCount = manifest.skills?.sources?.length ?? 0
  const localCount = manifest.skills?.skills?.length ?? 0
  const skills = [
    ...(manifest.skills?.sources.flatMap((source) =>
      (source.members ?? []).map((member) => ({ kind: 'source' as const, source, member })),
    ) ?? []),
    ...(manifest.skills?.skills.map((skill) => ({ kind: 'local' as const, skill })) ?? []),
  ]

  const setAll = async (agent: AgentId) => {
    if (updatingAgent) return
    const allOn =
      skills.length > 0 &&
      skills.every((item) => {
        const targets = item.kind === 'source' ? item.member.targets : item.skill.targets
        return (targets ?? []).includes(agent)
      })
    try {
      setUpdatingAgent(agent)
      for (const item of skills) {
        const targets =
          item.kind === 'source' ? (item.member.targets ?? []) : (item.skill.targets ?? [])
        const next = allOn
          ? targets.filter((a) => a !== agent)
          : AGENTS.filter((a) => a === agent || targets.includes(a))
        if (item.kind === 'source') {
          await api.updateSkillTargets({
            repo: repoPath,
            sourceUrl: item.source.url,
            memberName: item.member.name,
            targets: next,
          })
        } else {
          await api.updateLocalSkillTargets({ repo: repoPath, id: item.skill.id, targets: next })
        }
      }
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setUpdatingAgent(null)
    }
  }

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
      <span className="cfg-chips" style={{ display: 'flex', gap: 7 }}>
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
              className={`achip ${state}`}
              style={{ ['--c' as string]: agentColor[agent] }}
              aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
              aria-label={`${agentShort[agent]}：${state === 'on' ? '全部已选择' : state === 'mixed' ? '部分已选择' : '全部未选择'}`}
              data-tooltip={`${agentShort[agent]}：${tooltip}`}
              disabled={updatingAgent !== null}
              onClick={() => setAll(agent)}
            >
              {agentShort[agent]}
              {state === 'mixed' && (
                <span className="achip-count">
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
