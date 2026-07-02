import type { Manifest, AgentId, Config } from './types.js'

export interface LinkPlan {
  skillId: string
  source: 'local' | { repoId: string; memberName: string }
  targets: AgentId[]
}
export interface McpPlanEntry {
  id: string
  targets: AgentId[]
}
export interface ProjectionPlan {
  links: LinkPlan[]
  mcpEntries: McpPlanEntry[]
  skippedAgents: AgentId[]
  strategy: 'link' | 'copy'
}

export function planProjection(
  manifest: Manifest,
  effectiveConfig: Config,
  installedAgents: Set<AgentId>,
): ProjectionPlan {
  const globalTargets = effectiveConfig.targets ?? []
  const skippedAgents: AgentId[] = []
  const naming = effectiveConfig.skill_naming ?? 'dir'
  const activeTargets = (ts: AgentId[]): AgentId[] => {
    const out: AgentId[] = []
    for (const a of ts) {
      if (installedAgents.has(a)) out.push(a)
      else skippedAgents.push(a)
    }
    return out
  }

  const links: LinkPlan[] = []
  for (const s of manifest.skills.skills) {
    links.push({ skillId: s.id, source: 'local', targets: activeTargets(globalTargets) })
  }
  for (const src of manifest.skills.sources) {
    const repoId = deriveRepoId(src.url)
    const members = src.members?.length ? src.members : []
    for (const m of members) {
      const ts = activeTargets(m.enabled === false ? [] : (m.targets ?? globalTargets))
      links.push({
        skillId: naming === 'hyphen' ? `${repoId}-${m.name}` : `${repoId}/${m.name}`,
        source: { repoId, memberName: m.name },
        targets: ts,
      })
    }
  }

  const mcpEntries: McpPlanEntry[] = manifest.mcp.map((m) => ({
    id: m.id,
    targets: activeTargets(m.targets ?? globalTargets),
  }))

  return {
    links,
    mcpEntries,
    skippedAgents: [...new Set(skippedAgents)],
    strategy: effectiveConfig.projection?.strategy ?? 'link',
  }
}

export function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1]
    .split('/')
    .pop()!
    .replace(/\.git$/, '')
}
