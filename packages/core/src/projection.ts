import type { Manifest, AgentId, Config, Memory, SkillSource } from './types.js'

export interface LinkPlan {
  skillId: string
  source: 'local' | { repoId: string; memberName: string }
  targets: AgentId[]
}
export interface McpPlanEntry {
  id: string
  targets: AgentId[]
}
export interface MemoryPlan {
  active: Memory | null
  content: string | null
  targets: AgentId[]
}
export interface ProjectionPlan {
  links: LinkPlan[]
  mcpEntries: McpPlanEntry[]
  memoryPlan: MemoryPlan
  skippedAgents: AgentId[]
  strategy: 'link' | 'copy'
}

export type SkillNaming = NonNullable<Config['skill_naming']>

export interface SourceIdentity {
  repoId: string
}

type SourceIdentityInput = string | Pick<SkillSource, 'url'> | SourceIdentity

export function resolveSkillNaming(config?: Pick<Config, 'skill_naming'> | null): SkillNaming {
  return config?.skill_naming ?? 'dir'
}

export function sourceIdentity(source: string | Pick<SkillSource, 'url'>): SourceIdentity {
  return { repoId: deriveRepoId(typeof source === 'string' ? source : source.url) }
}

export function formatSourceMemberSkillId(
  source: SourceIdentityInput,
  memberName: string,
  configOrNaming?: Pick<Config, 'skill_naming'> | SkillNaming | null,
): string {
  const repoId = sourceRepoId(source)
  const naming =
    typeof configOrNaming === 'string' ? configOrNaming : resolveSkillNaming(configOrNaming)
  return naming === 'hyphen' ? repoId + '-' + memberName : repoId + '/' + memberName
}

export function parseSourceMemberSkillId(skillId: string, source: SourceIdentityInput): string {
  const repoId = sourceRepoId(source)
  const hyphenPrefix = repoId + '-'
  const dirPrefix = repoId + '/'
  if (skillId.startsWith(hyphenPrefix)) return skillId.slice(hyphenPrefix.length)
  if (skillId.startsWith(dirPrefix)) return skillId.slice(dirPrefix.length)
  return skillId
}

export function planProjection(
  manifest: Manifest,
  effectiveConfig: Config,
  installedAgents: Set<AgentId>,
): ProjectionPlan {
  const globalTargets = effectiveConfig.targets ?? []
  const globalTargetSet = new Set(globalTargets)
  const skippedAgents: AgentId[] = []
  const activeTargets = (ts: AgentId[]): AgentId[] => {
    const out: AgentId[] = []
    for (const a of ts) {
      if (!globalTargetSet.has(a)) continue
      if (installedAgents.has(a)) out.push(a)
      else skippedAgents.push(a)
    }
    return out
  }

  const links: LinkPlan[] = []
  for (const s of manifest.skills.skills) {
    links.push({ skillId: s.id, source: 'local', targets: activeTargets(s.targets ?? []) })
  }
  for (const src of manifest.skills.sources) {
    const { repoId } = sourceIdentity(src)
    const members = src.members?.length ? src.members : []
    for (const m of members) {
      const ts = activeTargets(m.enabled === false ? [] : (m.targets ?? []))
      links.push({
        skillId: formatSourceMemberSkillId({ repoId }, m.name, effectiveConfig),
        source: { repoId, memberName: m.name },
        targets: ts,
      })
    }
  }

  const mcpEntries: McpPlanEntry[] = manifest.mcp.map((m) => ({
    id: m.id,
    targets: activeTargets(m.targets ?? []),
  }))

  const memActive = manifest.memory.active
  const memoryTargets = activeTargets(globalTargets)
  const memoryPlan: MemoryPlan = {
    active: memActive,
    content: memActive ? manifest.memory.activeContent : null,
    targets: memoryTargets,
  }

  return {
    links,
    mcpEntries,
    memoryPlan,
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

function sourceRepoId(source: SourceIdentityInput): string {
  if (typeof source === 'string') return deriveRepoId(source)
  if ('repoId' in source) return source.repoId
  return deriveRepoId(source.url)
}
