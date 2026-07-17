import { AGENTS, AGENT_IDS, formatAgentFallbackPath, getAgent, type AgentId } from '@loom/core'

export type { AgentId } from '@loom/core'

export const agentIds: AgentId[] = [...AGENT_IDS]

export const agentShort = Object.fromEntries(
  AGENTS.map((agent) => [agent.id, agent.display.short]),
) as Record<AgentId, string>

export const agentColor = Object.fromEntries(
  AGENTS.map((agent) => [agent.id, agent.display.color]),
) as Record<AgentId, string>

export const agentName = Object.fromEntries(
  AGENTS.map((agent) => [agent.id, agent.display.name]),
) as Record<AgentId, string>

export const agentMcpPath = Object.fromEntries(
  AGENTS.filter((agent) => agent.mcp).map((agent) => [
    agent.id,
    formatAgentFallbackPath(agent.id, agent.mcp!.path),
  ]),
) as Partial<Record<AgentId, string>>

export function agentSkillPath(agent: AgentId, skillId: string): string {
  const definition = getAgent(agent)
  if (!definition.skills) throw new Error(`Agent ${agent} does not support skills`)
  return `${formatAgentFallbackPath(agent, definition.skills.path)}/${skillId}`
}
