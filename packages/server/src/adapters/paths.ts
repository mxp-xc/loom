import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getAgent,
  supportsAgentCapability,
  type AgentCapability,
  type AgentDefinition,
  type AgentId,
  type AgentPathSpec,
} from '@loom/core'

export interface AgentPathContext {
  home: string
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  resolveAgent?: (agent: AgentId) => AgentDefinition
}

export function runtimeAgentPathContext(home = homedir()): AgentPathContext {
  return { home, env: process.env, platform: process.platform }
}

export function resolveAgentConfigDir(agent: AgentId, context: AgentPathContext): string {
  const definition = resolveAgentDefinition(agent, context)
  const override = definition.configDir.overrideEnv
    ? context.env[definition.configDir.overrideEnv]
    : undefined
  if (override) return override
  return resolvePathSpec(definition.configDir.fallback, context)
}

export function resolveAgentPath(
  agent: AgentId,
  capability: 'skills' | 'mcp' | 'memory',
  context: AgentPathContext,
): string {
  const definition = resolveAgentDefinition(agent, context)
  const agentCapability = definition[capability]
  if (!agentCapability) throw new Error(`Agent ${agent} does not support ${capability}`)
  return resolvePathSpec(agentCapability.path, context, resolveAgentConfigDir(agent, context))
}

export function resolveAgentDefinition(agent: AgentId, context: AgentPathContext): AgentDefinition {
  return context.resolveAgent?.(agent) ?? getAgent(agent)
}

export function contextSupportsAgentCapability(
  agent: AgentId,
  capability: AgentCapability,
  context: AgentPathContext,
): boolean {
  return supportsAgentCapability(resolveAgentDefinition(agent, context), capability)
}

function resolvePathSpec(
  path: AgentPathSpec,
  context: AgentPathContext,
  configDir?: string,
): string {
  const root =
    path.root === 'home'
      ? context.home
      : path.root === 'xdg-config'
        ? (context.env.XDG_CONFIG_HOME ?? join(context.home, '.config'))
        : configDir
  if (!root) throw new Error('Agent config directory is unavailable')
  return join(root, ...path.segments)
}

export function agentConfigDir(agent: AgentId, context = runtimeAgentPathContext()): string {
  return resolveAgentConfigDir(agent, context)
}

export function agentSkillsDir(agent: AgentId, context = runtimeAgentPathContext()): string {
  return resolveAgentPath(agent, 'skills', context)
}

export function agentMcpFile(agent: AgentId, context = runtimeAgentPathContext()): string {
  return resolveAgentPath(agent, 'mcp', context)
}

export function agentMemoryFile(agent: AgentId, context = runtimeAgentPathContext()): string {
  return resolveAgentPath(agent, 'memory', context)
}
