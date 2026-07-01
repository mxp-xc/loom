import { describe, it, expect } from 'vitest'
import { planProjection } from '../../src/core/projection'
import type { Manifest } from '../../src/core/types'

const manifest: Manifest = {
  skills: {
    sources: [{ url: 'github:obra/superpowers', ref: 'v5.1.4', pinned_commit: 'aaa', members: [{ name: 'brainstorming' }, { name: 'tdd', enabled: false }, { name: 'writing', targets: ['codex'] }] }],
    skills: [{ id: 'frontend-design' }],
  },
  mcp: [
    { id: 'playwright', type: 'stdio', command: 'npx', args: ['p'], targets: ['claude-code', 'codex'] },
    { id: 'zhipu', type: 'sse', url: 'https://x' },
  ],
  vars: { default: {}, active: {} },
  config: { targets: ['claude-code', 'codex', 'opencode'], projection: { strategy: 'link' } },
  errors: [],
}

describe('planProjection', () => {
  it('local skill projected to all global targets', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const fd = p.links.find(l => l.skillId === 'frontend-design')!
    expect(fd.targets).toEqual(['claude-code', 'codex', 'opencode'])
  })
  it('source member (explicit members override) gets namespace prefix', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.links.some(l => l.skillId === 'superpowers-brainstorming')).toBe(true)
  })
  it('enabled:false member -> empty targets', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const tdd = p.links.find(l => l.skillId === 'superpowers-tdd')!
    expect(tdd.targets).toEqual([])
  })
  it('member override targets生效', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const writing = p.links.find(l => l.skillId === 'superpowers-writing')!
    expect(writing.targets).toEqual(['codex'])
  })
  it('mcp server projected to its own targets, not global', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex']))
    const m = p.mcpEntries.find(m => m.id === 'playwright')!
    expect(m.targets).toEqual(['claude-code', 'codex'])
  })
  it('mcp server without targets falls back to global', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const z = p.mcpEntries.find(m => m.id === 'zhipu')!
    expect(z.targets).toEqual(['claude-code', 'codex', 'opencode'])
  })
  it('uninstalled agent skipped, marked in skipped', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code']))
    expect(p.skippedAgents).toContain('codex')
    const fd = p.links.find(l => l.skillId === 'frontend-design')!
    expect(fd.targets).toEqual(['claude-code'])
  })
  it('strategy: copy透传;无 projection 默认 link', () => {
    const pCopy = planProjection(manifest, { targets: ['claude-code'], projection: { strategy: 'copy' } }, new Set(['claude-code']))
    expect(pCopy.strategy).toBe('copy')
    const pDefault = planProjection(manifest, { targets: ['claude-code'] }, new Set(['claude-code']))
    expect(pDefault.strategy).toBe('link')
  })
})
