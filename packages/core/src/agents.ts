import { z } from 'zod'

export type AgentCapability = 'skills' | 'mcp' | 'memory' | 'vars'
export type AgentPathRoot = 'home' | 'xdg-config' | 'config'
export type McpCodecId = 'json-object' | 'toml-table'

export interface AgentPathSpec {
  root: AgentPathRoot
  segments: readonly string[]
}

export interface AgentConfigDirSpec {
  overrideEnv?: string
  fallback: AgentPathSpec
}

export type AgentIcon = { kind: 'asset'; key: string } | { kind: 'text'; text: string }

export interface AgentDefinition {
  id: string
  display: {
    name: string
    short: string
    color: string
    icon: AgentIcon
  }
  command: string
  configDir: AgentConfigDirSpec
  skills?: { path: AgentPathSpec }
  memory?: { path: AgentPathSpec }
  mcp?: {
    path: AgentPathSpec
    codec: McpCodecId
    rootKey: string
    importSuffix: string
  }
}

const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function defineAgentCatalog<const T extends readonly AgentDefinition[]>(definitions: T): T {
  const ids = new Set<string>()
  const shorts = new Set<string>()
  const suffixes = new Set<string>()

  for (const definition of definitions) {
    if (!AGENT_ID_PATTERN.test(definition.id)) {
      throw new Error(`Invalid agent id: ${definition.id}`)
    }
    if (ids.has(definition.id)) throw new Error(`Duplicate agent id: ${definition.id}`)
    ids.add(definition.id)

    if (!definition.display.name || !definition.display.short || !definition.display.color) {
      throw new Error(`Incomplete display metadata for agent: ${definition.id}`)
    }
    if (shorts.has(definition.display.short)) {
      throw new Error(`Duplicate agent short name: ${definition.display.short}`)
    }
    shorts.add(definition.display.short)

    if (!definition.command) throw new Error(`Missing command for agent: ${definition.id}`)
    validatePath(definition.configDir.fallback, definition.id, 'configDir')
    if (definition.configDir.fallback.root === 'config') {
      throw new Error(`Agent configDir cannot be rooted at config: ${definition.id}`)
    }
    if (definition.skills) validatePath(definition.skills.path, definition.id, 'skills')
    if (definition.memory) validatePath(definition.memory.path, definition.id, 'memory')
    if (definition.mcp) {
      validatePath(definition.mcp.path, definition.id, 'mcp')
      if (!definition.mcp.rootKey || !definition.mcp.importSuffix) {
        throw new Error(`Incomplete MCP capability for agent: ${definition.id}`)
      }
      if (suffixes.has(definition.mcp.importSuffix)) {
        throw new Error(`Duplicate MCP import suffix: ${definition.mcp.importSuffix}`)
      }
      suffixes.add(definition.mcp.importSuffix)
    }
    if (!definition.skills && !definition.memory && !definition.mcp) {
      throw new Error(`Agent must declare a projection capability: ${definition.id}`)
    }
    if (definition.display.icon.kind === 'asset' && !definition.display.icon.key) {
      throw new Error(`Missing agent icon asset key: ${definition.id}`)
    }
    if (definition.display.icon.kind === 'text' && !definition.display.icon.text) {
      throw new Error(`Missing agent text icon: ${definition.id}`)
    }
  }
  return definitions
}

function validatePath(path: AgentPathSpec, agent: string, capability: string): void {
  if (!['home', 'xdg-config', 'config'].includes(path.root)) {
    throw new Error(`Invalid path root for ${agent}.${capability}: ${path.root}`)
  }
  for (const segment of path.segments) {
    if (!segment || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
      throw new Error(`Invalid path segment for ${agent}.${capability}: ${segment}`)
    }
  }
}

export const AGENTS = defineAgentCatalog([
  {
    id: 'claude-code',
    display: {
      name: 'Claude Code',
      short: 'CC',
      color: '#d97757',
      icon: { kind: 'asset', key: 'claude' },
    },
    command: 'claude',
    configDir: {
      overrideEnv: 'CLAUDE_CONFIG_DIR',
      fallback: { root: 'home', segments: ['.claude'] },
    },
    skills: { path: { root: 'config', segments: ['skills'] } },
    memory: { path: { root: 'config', segments: ['CLAUDE.md'] } },
    mcp: {
      path: { root: 'home', segments: ['.claude.json'] },
      codec: 'json-object',
      rootKey: 'mcpServers',
      importSuffix: 'cc',
    },
  },
  {
    id: 'codex',
    display: {
      name: 'Codex',
      short: 'CX',
      color: '#06b6d4',
      icon: { kind: 'asset', key: 'codex' },
    },
    command: 'codex',
    configDir: {
      overrideEnv: 'CODEX_HOME',
      fallback: { root: 'home', segments: ['.codex'] },
    },
    skills: { path: { root: 'config', segments: ['skills'] } },
    memory: { path: { root: 'config', segments: ['AGENTS.md'] } },
    mcp: {
      path: { root: 'config', segments: ['config.toml'] },
      codec: 'toml-table',
      rootKey: 'mcp_servers',
      importSuffix: 'cx',
    },
  },
  {
    id: 'opencode',
    display: {
      name: 'OpenCode',
      short: 'OC',
      color: '#8b5cf6',
      icon: { kind: 'asset', key: 'opencode' },
    },
    command: 'opencode',
    configDir: {
      overrideEnv: 'OPENCODE_CONFIG_DIR',
      fallback: { root: 'xdg-config', segments: ['opencode'] },
    },
    skills: { path: { root: 'config', segments: ['skills'] } },
    memory: { path: { root: 'config', segments: ['AGENTS.md'] } },
    mcp: {
      path: { root: 'config', segments: ['opencode.json'] },
      codec: 'json-object',
      rootKey: 'mcp',
      importSuffix: 'oc',
    },
  },
] as const)

export type AgentId = (typeof AGENTS)[number]['id']

export const AGENT_IDS = AGENTS.map((agent) => agent.id) as [AgentId, ...AgentId[]]
export const AgentIdSchema = z.enum(AGENT_IDS)

const AGENT_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent] as const))

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_BY_ID.has(value as AgentId)
}

export function getAgent(id: AgentId): (typeof AGENTS)[number] {
  return AGENT_BY_ID.get(id)!
}

export function configuredAgents(agents: readonly unknown[] | null | undefined): AgentId[] {
  if (!agents?.length) return []
  const selected = new Set(agents.filter(isAgentId))
  return AGENT_IDS.filter((agent) => selected.has(agent))
}

export function supportsAgentCapability(
  agent: AgentId | AgentDefinition,
  capability: AgentCapability,
): boolean {
  if (capability === 'vars') return true
  const definition = typeof agent === 'string' ? getAgent(agent) : agent
  return definition[capability] !== undefined
}

export function applicableAgents(
  agents: readonly unknown[] | null | undefined,
  capability: AgentCapability,
): AgentId[] {
  return configuredAgents(agents).filter((agent) => supportsAgentCapability(agent, capability))
}

export function agentsSupporting(capability: AgentCapability): AgentId[] {
  return AGENT_IDS.filter((agent) => supportsAgentCapability(agent, capability))
}

export function formatAgentFallbackPath(agent: AgentId, path: AgentPathSpec): string {
  const definition = getAgent(agent)
  const fallback = definition.configDir.fallback
  const fallbackSegments =
    fallback.root === 'xdg-config' ? ['.config', ...fallback.segments] : [...fallback.segments]
  const segments =
    path.root === 'config'
      ? [...fallbackSegments, ...path.segments]
      : path.root === 'xdg-config'
        ? ['.config', ...path.segments]
        : [...path.segments]
  return '~/' + segments.join('/')
}
