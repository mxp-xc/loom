import { AGENT_IDS, configuredAgents, isAgentId, type AgentId } from './agents.js'

export { SHARED_HOME } from './shared-home.js'

export interface SkillProjectionAssignment {
  agents: AgentId[]
  shared: boolean
}

export type SkillProjectionDestination = { kind: 'agent'; agent: AgentId } | { kind: 'shared' }

export type SkillProjectionDestinationKey = `agent:${AgentId}` | 'shared'

export function normalizeSkillProjectionAssignment(input: {
  agents?: readonly AgentId[]
  shared?: boolean
}): SkillProjectionAssignment {
  return {
    agents: configuredAgents(input.agents),
    shared: input.shared === true,
  }
}

export function sameSkillProjectionAssignment(
  left: { agents?: readonly AgentId[]; shared?: boolean },
  right: { agents?: readonly AgentId[]; shared?: boolean },
): boolean {
  const normalizedLeft = normalizeSkillProjectionAssignment(left)
  const normalizedRight = normalizeSkillProjectionAssignment(right)
  return (
    normalizedLeft.shared === normalizedRight.shared &&
    normalizedLeft.agents.length === normalizedRight.agents.length &&
    normalizedLeft.agents.every((agent, index) => agent === normalizedRight.agents[index])
  )
}

export function changedSkillProjectionDestinations(
  previous: { agents?: readonly AgentId[]; shared?: boolean },
  next: { agents?: readonly AgentId[]; shared?: boolean },
): SkillProjectionDestination[] {
  const before = normalizeSkillProjectionAssignment(previous)
  const after = normalizeSkillProjectionAssignment(next)
  const previousAgents = new Set(before.agents)
  const nextAgents = new Set(after.agents)
  const changed: SkillProjectionDestination[] = AGENT_IDS.filter(
    (agent) => previousAgents.has(agent) !== nextAgents.has(agent),
  ).map((agent) => ({ kind: 'agent', agent }))
  if (before.shared !== after.shared) changed.push({ kind: 'shared' })
  return changed
}

export function skillProjectionDestinations(
  assignment: { agents?: readonly AgentId[]; shared?: boolean },
  applicableAgentIds: readonly AgentId[],
): SkillProjectionDestination[] {
  const normalized = normalizeSkillProjectionAssignment(assignment)
  const selected = new Set(normalized.agents)
  const destinations: SkillProjectionDestination[] = applicableAgentIds
    .filter((agent) => selected.has(agent))
    .map((agent) => ({ kind: 'agent', agent }))
  if (normalized.shared) destinations.push({ kind: 'shared' })
  return destinations
}

export function skillProjectionDestinationKey(
  destination: SkillProjectionDestination,
): SkillProjectionDestinationKey {
  return destination.kind === 'shared' ? 'shared' : `agent:${destination.agent}`
}

export function parseSkillProjectionDestinationKey(
  value: string,
): SkillProjectionDestination | null {
  if (value === 'shared') return { kind: 'shared' }
  if (!value.startsWith('agent:')) return null
  const agent = value.slice('agent:'.length)
  return isAgentId(agent) ? { kind: 'agent', agent } : null
}
