import { describe, it, expect } from 'vitest'
import { planProjection } from '../src/projection.js'
import type { Manifest, Config } from '../src/types.js'

const baseManifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  skills: { sources: [], skills: [] },
  mcp: [],
  memory: { memories: [], active: null, activeContent: '' },
  vars: { default: {}, active: {} },
  config: {},
  errors: [],
  ...overrides,
})

describe('planProjection memory', () => {
  it('memoryPlan.active null when no active memory', () => {
    const mf = baseManifest()
    const cfg: Config = { agents: ['claude-code'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code']))
    expect(plan.memoryPlan.active).toBeNull()
    expect(plan.memoryPlan.content).toBeNull()
  })

  it('memoryPlan carries active memory + content + global agents', () => {
    const mf = baseManifest({
      memory: {
        memories: [{ name: 'v1' }],
        active: { name: 'v1' },
        activeContent: '# hi ${LOOM_AGENT}',
      },
    })
    const cfg: Config = { agents: ['claude-code', 'codex'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code', 'codex']))
    expect(plan.memoryPlan.active?.name).toBe('v1')
    expect(plan.memoryPlan.content).toBe('# hi ${LOOM_AGENT}')
    expect(plan.memoryPlan.agents).toEqual(['claude-code', 'codex'])
  })

  it('memoryPlan.agents filters to installed agents', () => {
    const mf = baseManifest({
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: 'x' },
    })
    const cfg: Config = { agents: ['claude-code', 'codex', 'opencode'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code']))
    expect(plan.memoryPlan.agents).toEqual(['claude-code'])
    expect(plan.skippedAgents).toContain('codex')
    expect(plan.skippedAgents).toContain('opencode')
  })

  it('plans different memory content for independently assigned agents', () => {
    const mf = baseManifest({
      memory: {
        memories: [
          { name: 'team', content: '# team', agents: ['codex'] },
          { name: 'personal', content: '# personal', agents: ['opencode'] },
        ],
        assignments: { codex: 'team', opencode: 'personal' },
        active: null,
        activeContent: '',
      },
    })
    const cfg: Config = { agents: ['codex', 'opencode'] }

    const plan = planProjection(mf, cfg, new Set(['codex', 'opencode']))

    expect(plan.memoryPlan.entries).toEqual([
      {
        memory: { name: 'team', content: '# team', agents: ['codex'] },
        content: '# team',
        agents: ['codex'],
      },
      {
        memory: { name: 'personal', content: '# personal', agents: ['opencode'] },
        content: '# personal',
        agents: ['opencode'],
      },
    ])
  })

  it('does not fall back to active memory when explicit assignments are filtered out', () => {
    const mf = baseManifest({
      memory: {
        memories: [
          { name: 'team', content: '# team', agents: ['codex'] },
          { name: 'personal', content: '# personal' },
        ],
        assignments: { codex: 'team' },
        active: { name: 'personal', content: '# personal' },
        activeContent: '# personal',
      },
    })
    const cfg: Config = {
      agents: ['codex', 'opencode'],
      memory_agents: { codex: 'team' },
    }

    const plan = planProjection(mf, cfg, new Set(['opencode']))

    expect(plan.memoryPlan.entries).toEqual([])
  })
})
