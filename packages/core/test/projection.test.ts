import { describe, it, expect } from 'vitest'
import {
  formatSourceMemberSkillId,
  parseSourceMemberSkillId,
  planProjection,
  resolveSkillNaming,
  sourceIdentity,
} from '../src/projection'
import type { Manifest } from '../src/types'

const manifest: Manifest = {
  skills: {
    sources: [
      {
        url: 'github:obra/superpowers',
        ref: 'v5.1.4',
        pinned_commit: 'aaa',
        members: [
          { name: 'brainstorming' },
          { name: 'tdd', enabled: false },
          { name: 'writing', targets: ['codex'] },
        ],
      },
    ],
    skills: [{ id: 'frontend-design' }],
  },
  mcp: [
    {
      id: 'playwright',
      type: 'stdio',
      command: 'npx',
      args: ['p'],
      targets: ['claude-code', 'codex'],
    },
    { id: 'zhipu', type: 'sse', url: 'https://x' },
  ],
  vars: { default: {}, active: {} },
  memory: { memories: [], active: null, activeContent: '' },
  config: {
    targets: ['claude-code', 'codex', 'opencode'],
    projection: { strategy: 'link' },
    skill_naming: 'hyphen',
  },
  errors: [],
}

describe('planProjection', () => {
  it('local skill without targets is not projected', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    const fd = p.links.find((l) => l.skillId === 'frontend-design')!
    expect(fd.targets).toEqual([])
  })
  it('source member (explicit members override) gets namespace prefix', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    expect(p.links.some((l) => l.skillId === 'superpowers-brainstorming')).toBe(true)
  })
  it('enabled:false member -> empty targets', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    const tdd = p.links.find((l) => l.skillId === 'superpowers-tdd')!
    expect(tdd.targets).toEqual([])
  })
  it('member override targets生效', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    const writing = p.links.find((l) => l.skillId === 'superpowers-writing')!
    expect(writing.targets).toEqual(['codex'])
  })
  it('mcp server projected to its own targets, not global', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex']))
    const m = p.mcpEntries.find((m) => m.id === 'playwright')!
    expect(m.targets).toEqual(['claude-code', 'codex'])
  })
  it('mcp server without targets is not projected', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    const z = p.mcpEntries.find((m) => m.id === 'zhipu')!
    expect(z.targets).toEqual([])
  })
  it('uninstalled agent skipped, marked in skipped', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code']))
    expect(p.skippedAgents).toContain('codex')
    const fd = p.links.find((l) => l.skillId === 'frontend-design')!
    expect(fd.targets).toEqual([])
  })

  it('intersects explicit targets with configured and installed targets', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        ...manifest.skills,
        skills: [{ id: 'frontend-design', targets: ['claude-code', 'opencode'] }],
      },
      config: { ...manifest.config, targets: ['claude-code', 'codex'] },
    }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.links.find((l) => l.skillId === 'frontend-design')?.targets).toEqual(['claude-code'])
  })
  it('filters hidden targets for remote skills and MCP without mutating the manifest', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        sources: [
          {
            ...manifest.skills.sources[0],
            members: [{ name: 'writing', targets: ['claude-code', 'opencode'] }],
          },
        ],
        skills: [],
      },
      mcp: [{ id: 'playwright', type: 'stdio', command: 'npx', targets: ['codex', 'opencode'] }],
      config: { ...manifest.config, targets: ['claude-code', 'codex'] },
    }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))

    expect(p.links[0].targets).toEqual(['claude-code'])
    expect(p.mcpEntries[0].targets).toEqual(['codex'])
    expect(m.skills.sources[0].members?.[0].targets).toEqual(['claude-code', 'opencode'])
    expect(m.mcp[0].targets).toEqual(['codex', 'opencode'])
  })
  it('strategy: copy透传;无 projection 默认 link', () => {
    const pCopy = planProjection(
      manifest,
      { targets: ['claude-code'], projection: { strategy: 'copy' } },
      new Set(['claude-code']),
    )
    expect(pCopy.strategy).toBe('copy')
    const pDefault = planProjection(
      manifest,
      { targets: ['claude-code'] },
      new Set(['claude-code']),
    )
    expect(pDefault.strategy).toBe('link')
  })
})
describe('planProjection skill_naming', () => {
  it('dir format produces repoId/memberName skillId', () => {
    const m = { ...manifest, config: { ...manifest.config, skill_naming: 'dir' as const } }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    const link = p.links.find(
      (l) => l.source !== 'local' && (l.source as any).memberName === 'brainstorming',
    )
    expect(link!.skillId).toBe('superpowers/brainstorming')
  })
  it('hyphen format produces repoId-memberName skillId', () => {
    const m = { ...manifest, config: { ...manifest.config, skill_naming: 'hyphen' as const } }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    const link = p.links.find(
      (l) => l.source !== 'local' && (l.source as any).memberName === 'brainstorming',
    )
    expect(link!.skillId).toBe('superpowers-brainstorming')
  })
  it('defaults to dir format when unset', () => {
    const m = { ...manifest, config: { ...manifest.config } }
    delete (m.config as any).skill_naming
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    const link = p.links.find(
      (l) => l.source !== 'local' && (l.source as any).memberName === 'brainstorming',
    )
    expect(link!.skillId).toBe('superpowers/brainstorming')
  })
})

describe('source identity helpers', () => {
  it('derive repo id and select default naming in one place', () => {
    expect(sourceIdentity({ url: 'https://github.com/obra/superpowers.git' })).toEqual({
      repoId: 'superpowers',
    })
    expect(resolveSkillNaming({})).toBe('dir')
    expect(resolveSkillNaming({ skill_naming: 'hyphen' })).toBe('hyphen')
  })

  it('formats and parses source member skill ids for dir and hyphen naming', () => {
    const source = { url: 'github:obra/superpowers', ref: 'main' }

    expect(formatSourceMemberSkillId(source, 'brainstorming', { skill_naming: 'dir' })).toBe(
      'superpowers/brainstorming',
    )
    expect(formatSourceMemberSkillId(source, 'brainstorming', { skill_naming: 'hyphen' })).toBe(
      'superpowers-brainstorming',
    )
    expect(parseSourceMemberSkillId('superpowers/brainstorming', source)).toBe('brainstorming')
    expect(parseSourceMemberSkillId('superpowers-brainstorming', source)).toBe('brainstorming')
    expect(parseSourceMemberSkillId('custom-name', source)).toBe('custom-name')
  })
})
