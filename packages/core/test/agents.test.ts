import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  AGENT_IDS,
  AGENTS,
  applicableAgents,
  configuredAgents,
  defineAgentCatalog,
  formatAgentFallbackPath,
  getAgent,
} from '../src/index.js'

describe('Agent Catalog', () => {
  it('derives ids, schema and lookup from one ordered definition list', () => {
    expect(AGENT_IDS).toEqual(['claude-code', 'codex', 'opencode'])
    expect(AGENTS.map((agent) => agent.id)).toEqual(AGENT_IDS)
    expect(AgentIdSchema.safeParse('codex').success).toBe(true)
    expect(AgentIdSchema.safeParse('other').success).toBe(false)
    expect(getAgent('opencode').display.short).toBe('OC')
  })

  it('normalizes configured and applicable agents in Catalog order', () => {
    expect(configuredAgents(undefined)).toEqual([])
    expect(configuredAgents([])).toEqual([])
    expect(configuredAgents(['opencode', 'codex', 'opencode'])).toEqual(['codex', 'opencode'])
    expect(applicableAgents(['opencode', 'codex'], 'mcp')).toEqual(['codex', 'opencode'])
  })

  it('rejects invalid code definitions at module construction', () => {
    const base = AGENTS[0]
    expect(() => defineAgentCatalog([base, { ...base }])).toThrow('Duplicate agent id')
    expect(() =>
      defineAgentCatalog([
        {
          ...base,
          id: 'bad_agent',
        },
      ]),
    ).toThrow('Invalid agent id')
    expect(() =>
      defineAgentCatalog([
        {
          ...base,
          id: 'hermes',
          skills: { path: { root: 'config', segments: ['..'] } },
        },
      ]),
    ).toThrow('Invalid path segment')
  })

  it('keeps current integration facts in the Catalog', () => {
    expect(getAgent('claude-code')).toMatchObject({
      command: 'claude',
      configDir: { overrideEnv: 'CLAUDE_CONFIG_DIR' },
      mcp: { rootKey: 'mcpServers', codec: 'json-object', importSuffix: 'cc' },
    })
    expect(getAgent('codex')).toMatchObject({
      command: 'codex',
      configDir: { overrideEnv: 'CODEX_HOME' },
      mcp: { rootKey: 'mcp_servers', codec: 'toml-table', importSuffix: 'cx' },
    })
    expect(getAgent('opencode')).toMatchObject({
      command: 'opencode',
      configDir: { overrideEnv: 'OPENCODE_CONFIG_DIR' },
      mcp: { rootKey: 'mcp', codec: 'json-object', importSuffix: 'oc' },
    })
  })

  it('formats capability paths from each agent config fallback root', () => {
    expect(formatAgentFallbackPath('claude-code', getAgent('claude-code').skills.path)).toBe(
      '~/.claude/skills',
    )
    expect(formatAgentFallbackPath('codex', getAgent('codex').mcp.path)).toBe(
      '~/.codex/config.toml',
    )
    expect(formatAgentFallbackPath('opencode', getAgent('opencode').mcp.path)).toBe(
      '~/.config/opencode/opencode.json',
    )
  })
})
