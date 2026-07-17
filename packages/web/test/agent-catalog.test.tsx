// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AGENTS, formatAgentFallbackPath } from '@loom/core'
import { AgentChip } from '../src/components/ui/AgentChip.js'
import { agentColor, agentMcpPath, agentName, agentShort } from '../src/lib/agents.js'
import { resolveAgentIcon } from '../src/lib/agent-icons.js'

describe('Web agent catalog adapter', () => {
  it.each(AGENTS)('derives Web metadata for $id', (agent) => {
    expect(agentName[agent.id]).toBe(agent.display.name)
    expect(agentShort[agent.id]).toBe(agent.display.short)
    expect(agentColor[agent.id]).toBe(agent.display.color)
    expect(resolveAgentIcon(agent.display.icon)).toMatchObject({ kind: agent.display.icon.kind })
  })

  it.each(AGENTS.filter((agent) => agent.mcp))('derives the MCP path for $id', (agent) => {
    expect(agentMcpPath[agent.id]).toBe(formatAgentFallbackPath(agent.id, agent.mcp!.path))
  })

  it.each(AGENTS)('renders the catalog icon and accessible name for $id', (agent) => {
    render(<AgentChip agent={agent.id} state="on" />)
    expect(screen.getByLabelText(agent.display.name)).toBeDefined()
  })

  it('supports an explicit text icon', () => {
    expect(resolveAgentIcon({ kind: 'text', text: 'H' })).toEqual({ kind: 'text', text: 'H' })
  })
})
