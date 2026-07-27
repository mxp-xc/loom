import { describe, expect, it } from 'vitest'
import {
  SHARED_HOME,
  changedSkillProjectionDestinations,
  normalizeSkillProjectionAssignment,
  parseSkillProjectionDestinationKey,
  sameSkillProjectionAssignment,
  skillProjectionDestinationKey,
  skillProjectionDestinations,
} from '../src/skill-projection.js'

describe('shared home', () => {
  it('defines the fixed shared skills capability without an agent identity', () => {
    expect(SHARED_HOME).toEqual({
      root: { root: 'home', segments: ['.agents'] },
      capabilities: { skills: { path: ['skills'] } },
    })
    expect(SHARED_HOME).not.toHaveProperty('id')
  })
})

describe('skill projection assignments', () => {
  it('normalizes agents in catalog order and defaults shared to false', () => {
    expect(
      normalizeSkillProjectionAssignment({
        agents: ['opencode', 'codex', 'codex'],
      }),
    ).toEqual({ agents: ['codex', 'opencode'], shared: false })
  })

  it('compares normalized assignments', () => {
    expect(
      sameSkillProjectionAssignment(
        { agents: ['opencode', 'codex'], shared: true },
        { agents: ['codex', 'opencode'], shared: true },
      ),
    ).toBe(true)
  })

  it('returns only destinations whose selected state changed', () => {
    expect(
      changedSkillProjectionDestinations(
        { agents: ['claude-code'], shared: false },
        { agents: ['claude-code', 'codex'], shared: true },
      ),
    ).toEqual([{ kind: 'agent', agent: 'codex' }, { kind: 'shared' }])
  })

  it('filters selected agents through the applicable set but always includes shared', () => {
    expect(
      skillProjectionDestinations({ agents: ['claude-code', 'codex'], shared: true }, ['codex']),
    ).toEqual([{ kind: 'agent', agent: 'codex' }, { kind: 'shared' }])
  })
})

describe('skill projection destination keys', () => {
  it.each([
    [{ kind: 'agent', agent: 'codex' } as const, 'agent:codex'],
    [{ kind: 'shared' } as const, 'shared'],
  ])('round-trips %j', (destination, key) => {
    expect(skillProjectionDestinationKey(destination)).toBe(key)
    expect(parseSkillProjectionDestinationKey(key)).toEqual(destination)
  })

  it.each(['agent:unknown', 'agents:codex', '', 'shared:skills'])(
    'rejects unsupported key %s',
    (key) => {
      expect(parseSkillProjectionDestinationKey(key)).toBeNull()
    },
  )
})
