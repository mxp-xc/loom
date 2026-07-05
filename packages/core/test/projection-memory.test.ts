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
    const cfg: Config = { targets: ['claude-code'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code']))
    expect(plan.memoryPlan.active).toBeNull()
    expect(plan.memoryPlan.content).toBeNull()
  })

  it('memoryPlan carries active memory + content + global targets', () => {
    const mf = baseManifest({
      memory: {
        memories: [{ name: 'v1' }],
        active: { name: 'v1' },
        activeContent: '# hi ${LOOM_AGENT}',
      },
    })
    const cfg: Config = { targets: ['claude-code', 'codex'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code', 'codex']))
    expect(plan.memoryPlan.active?.name).toBe('v1')
    expect(plan.memoryPlan.content).toBe('# hi ${LOOM_AGENT}')
    expect(plan.memoryPlan.targets).toEqual(['claude-code', 'codex'])
  })

  it('memoryPlan.targets filters to installed agents', () => {
    const mf = baseManifest({
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: 'x' },
    })
    const cfg: Config = { targets: ['claude-code', 'codex', 'opencode'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code']))
    expect(plan.memoryPlan.targets).toEqual(['claude-code'])
    expect(plan.skippedAgents).toContain('codex')
    expect(plan.skippedAgents).toContain('opencode')
  })
})
