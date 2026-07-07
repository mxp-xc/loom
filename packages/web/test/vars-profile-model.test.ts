import { describe, expect, it } from 'vitest'
import type { AgentId } from '../src/lib/agents'
import type { VarsMatrixResponse } from '../src/lib/vars'
import {
  buildVarsProfileState,
  entryValuePreview,
  jsonStringError,
  parseOverrideDraft,
  parseVarDraft,
} from '../src/views/vars/profile-model'

const agents: AgentId[] = ['claude-code', 'codex', 'opencode']

function matrix(agent: AgentId): VarsMatrixResponse {
  return {
    ok: true,
    agent,
    builtinKeys: ['LOOM_AGENT'],
    userKeys: ['agent_name', 'memory.rtk', 'memory.context'],
    snapshot: {
      base: {
        agent_name: { type: 'string', format: 'markdown', value: 'Agent' },
        'memory.rtk': { type: 'string', format: 'path', value: 'RTK.md' },
        'memory.context': { type: 'string', format: 'markdown', value: '' },
      },
      baseAgent: agent === 'codex' ? { agent_name: { value: 'Codex base' } } : {},
      local: {
        'memory.rtk': { value: 'C:/Users/10107/.codex/RTK.md' },
      },
      localAgent: agent === 'codex' ? { agent_name: { value: 'Local Codex agent' } } : {},
    },
    resolution: {
      ok: true,
      values: {
        LOOM_AGENT: { type: 'string', value: agent },
        agent_name: {
          type: 'string',
          format: 'markdown',
          value: agent === 'codex' ? 'Local Codex agent' : 'Agent',
        },
        'memory.rtk': { type: 'string', format: 'path', value: 'C:/Users/10107/.codex/RTK.md' },
        'memory.context': { type: 'string', format: 'markdown', value: '' },
      },
      sources: {
        LOOM_AGENT: { locality: 'builtin', layer: 'runtime' },
        agent_name:
          agent === 'codex'
            ? { locality: 'local', layer: 'agent', agent: 'codex' }
            : { locality: 'synced', layer: 'base' },
        'memory.rtk': { locality: 'local', layer: 'local' },
        'memory.context': { locality: 'synced', layer: 'base' },
      },
      overrideChains: {},
      dependencies: {},
      diagnostics: [],
    },
  }
}

const matricesByAgent = Object.fromEntries(agents.map((agent) => [agent, matrix(agent)])) as Record<
  AgentId,
  VarsMatrixResponse
>

describe('profile vars view model', () => {
  it('builds builtin, base, and local profile summaries', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: false,
    })
    expect(state.profiles.map((profile) => [profile.id, profile.kindBadge])).toEqual([
      ['builtin', 'runtime'],
      ['base', 'locked'],
      ['local', 'local'],
    ])
  })

  it('hides default from list slots and keeps type/format beside key', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: false,
    })
    const local = state.profiles.find((profile) => profile.id === 'local')
    expect(
      local?.entries.map((entry) => [entry.key, entry.type, entry.format, entry.agentSlots]),
    ).toEqual([
      ['agent_name', 'string', 'markdown', ['codex']],
      ['memory.rtk', 'string', 'path', []],
    ])
  })

  it('adds available Base keys only when requested', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: true,
    })
    const local = state.profiles.find((profile) => profile.id === 'local')
    expect(local?.entries.find((entry) => entry.key === 'memory.context')?.state).toBe('available')
  })

  it('builds resolved rows for the active agent', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: false,
    })
    expect(state.resolvedRows.find((row) => row.key === 'agent_name')).toMatchObject({
      valuePreview: 'Local Codex agent',
      sourceLabel: 'local/codex',
    })
  })

  it('parses drafts and validates JSON text', () => {
    expect(parseVarDraft('number', '42')).toEqual({ type: 'number', value: 42 })
    expect(parseVarDraft('boolean', 'true')).toEqual({ type: 'boolean', value: true })
    expect(parseVarDraft('string', '# hi', 'markdown')).toEqual({
      type: 'string',
      format: 'markdown',
      value: '# hi',
    })
    expect(parseVarDraft('secret', 'token', 'markdown')).toEqual({ type: 'secret', value: 'token' })
    expect(parseOverrideDraft('json', '{"a":1}')).toEqual({ value: { a: 1 } })
    expect(entryValuePreview({ value: 'hello' })).toBe('hello')
    expect(jsonStringError('{"a":1}')).toBeNull()
    expect(jsonStringError('{bad')).toBeTruthy()
  })
})
