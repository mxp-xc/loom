import { describe, it, expect } from 'vitest'
import {
  formatSourceMemberSkillId,
  parseSourceMemberSkillId,
  planProjection,
  resolveSkillNaming,
  sourceIdentity,
} from '../src/projection'
import type { Manifest } from '../src/types'

function sourceTreeFor(entries: string[]) {
  return {
    commit: 'aaa',
    diagnostics: [],
    nodes: entries.map((entry) => {
      const path = entry === 'SKILL.md' ? '' : entry.slice(0, -'/SKILL.md'.length)
      const name = path.split('/').pop() || 'superpowers'
      return { kind: 'bundle' as const, name, path, entry, mode: '040000', oid: entry }
    }),
  }
}

const manifest: Manifest = {
  skills: {
    sources: [
      {
        url: 'github:obra/superpowers',
        ref: 'v5.1.4',
        pinned_commit: 'aaa',
        members: [
          { name: 'brainstorming', entry: 'skills/brainstorming/SKILL.md' },
          { name: 'tdd', entry: 'skills/tdd/SKILL.md' },
          { name: 'writing', entry: 'skills/writing/SKILL.md', agents: ['codex'] },
        ],
        sourceTree: sourceTreeFor([
          'skills/brainstorming/SKILL.md',
          'skills/tdd/SKILL.md',
          'skills/writing/SKILL.md',
        ]),
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
      agents: ['claude-code', 'codex'],
    },
    { id: 'zhipu', type: 'sse', url: 'https://x' },
  ],
  vars: { default: {}, active: {} },
  memory: { memories: [], active: null, activeContent: '' },
  config: {
    agents: ['claude-code', 'codex', 'opencode'],
    projection: { strategy: 'link' },
    skill_naming: 'hyphen',
  },
  errors: [],
}

describe('planProjection', () => {
  it('local skill without agents is not projected', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    const fd = p.links.find((l) => l.skillId === 'frontend-design')!
    expect(fd.agents).toEqual([])
  })
  it('source member is planned inside its source namespace', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    expect(p.links.some((link) => link.source !== 'local')).toBe(false)
    expect(p.sourcePlans).toEqual([
      expect.objectContaining({
        sourceName: 'superpowers',
        commit: 'aaa',
        agent: 'codex',
        projectionBase: 'skills',
        entries: [{ kind: 'bundle', sourcePath: 'skills/writing', targetPath: 'writing' }],
      }),
    ])
  })
  it('uses canonical entry to locate a nested bundle root', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        ...manifest.skills,
        sources: [
          {
            ...manifest.skills.sources[0],
            members: [
              {
                name: 'diagnosing-bugs',
                entry: 'skills/engineering/diagnosing-bugs/SKILL.md',
                agents: ['codex'],
              },
            ],
            sourceTree: sourceTreeFor(['skills/engineering/diagnosing-bugs/SKILL.md']),
          },
        ],
      },
    }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.sourcePlans[0]).toEqual(
      expect.objectContaining({
        projectionBase: 'skills/engineering',
        entries: [
          {
            kind: 'bundle',
            sourcePath: 'skills/engineering/diagnosing-bugs',
            targetPath: 'diagnosing-bugs',
          },
        ],
      }),
    )
  })
  it('uses source name for projected skill id but keeps URL-derived cache id', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        ...manifest.skills,
        sources: [
          {
            ...manifest.skills.sources[0],
            name: 'openai-skills',
            members: [
              {
                name: 'brainstorming',
                entry: 'skills/brainstorming/SKILL.md',
                agents: ['codex'],
              },
            ],
            sourceTree: sourceTreeFor(['skills/brainstorming/SKILL.md']),
          },
        ],
      },
      config: { ...manifest.config, skill_naming: 'dir' },
    }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.sourcePlans[0]).toEqual(
      expect.objectContaining({ sourceName: 'openai-skills', cacheId: 'superpowers' }),
    )
  })
  it('member without agents is not projected', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    expect(
      p.sourcePlans.some((plan) => plan.entries.some((entry) => entry.sourcePath.endsWith('/tdd'))),
    ).toBe(false)
  })
  it('member override agents 生效', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    expect(p.sourcePlans.find((plan) => plan.agent === 'codex')?.entries).toContainEqual({
      kind: 'bundle',
      sourcePath: 'skills/writing',
      targetPath: 'writing',
    })
  })
  it('mcp server projected to its own agents, not global', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex']))
    const m = p.mcpEntries.find((m) => m.id === 'playwright')!
    expect(m.agents).toEqual(['claude-code', 'codex'])
  })
  it('mcp server without agents is not projected', () => {
    const p = planProjection(
      manifest,
      manifest.config,
      new Set(['claude-code', 'codex', 'opencode']),
    )
    const z = p.mcpEntries.find((m) => m.id === 'zhipu')!
    expect(z.agents).toEqual([])
  })
  it('uninstalled agent skipped, marked in skipped', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code']))
    expect(p.skippedAgents).toContain('codex')
    const fd = p.links.find((l) => l.skillId === 'frontend-design')!
    expect(fd.agents).toEqual([])
  })

  it('intersects explicit agents with configured and installed agents', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        ...manifest.skills,
        skills: [{ id: 'frontend-design', agents: ['claude-code', 'opencode'] }],
      },
      config: { ...manifest.config, agents: ['claude-code', 'codex'] },
    }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.links.find((l) => l.skillId === 'frontend-design')?.agents).toEqual(['claude-code'])
  })
  it('filters hidden agents for remote skills and MCP without mutating the manifest', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        sources: [
          {
            ...manifest.skills.sources[0],
            members: [
              {
                name: 'writing',
                entry: 'skills/writing/SKILL.md',
                agents: ['claude-code', 'opencode'],
              },
            ],
            sourceTree: sourceTreeFor(['skills/writing/SKILL.md']),
          },
        ],
        skills: [],
      },
      mcp: [{ id: 'playwright', type: 'stdio', command: 'npx', agents: ['codex', 'opencode'] }],
      config: { ...manifest.config, agents: ['claude-code', 'codex'] },
    }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))

    expect(p.sourcePlans.map((plan) => plan.agent)).toEqual(['claude-code'])
    expect(p.mcpEntries[0].agents).toEqual(['codex'])
    expect(m.skills.sources[0].members?.[0].agents).toEqual(['claude-code', 'opencode'])
    expect(m.mcp[0].agents).toEqual(['codex', 'opencode'])
  })
  it('deduplicates repeated agents before building source projection entries', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        ...manifest.skills,
        sources: [
          {
            ...manifest.skills.sources[0],
            members: [
              {
                name: 'writing',
                entry: 'skills/writing/SKILL.md',
                agents: ['codex', 'codex'],
              },
            ],
            sourceTree: sourceTreeFor(['skills/writing/SKILL.md']),
          },
        ],
      },
    }

    const p = planProjection(m, m.config, new Set(['codex']))

    expect(p.sourcePlans).toHaveLength(1)
    expect(p.sourcePlans[0].entries).toEqual([
      { kind: 'bundle', sourcePath: 'skills/writing', targetPath: 'writing' },
    ])
  })
  it('preserves unavailable source namespaces for every installed skills agent', () => {
    const unavailableSource = {
      ...manifest.skills.sources[0],
      members: [
        {
          name: 'writing',
          entry: 'skills/writing/SKILL.md',
          agents: ['codex' as const],
        },
      ],
      sourceTree: undefined,
      availability: {
        available: false,
        reason: 'cache-unavailable' as const,
      },
    }
    const withoutOverlap: Manifest = {
      ...manifest,
      skills: { sources: [unavailableSource], skills: [] },
    }

    expect(
      planProjection(withoutOverlap, withoutOverlap.config, new Set(['codex', 'claude-code'])),
    ).toMatchObject({
      sourcePlans: [],
      preservedSourceNamespaces: [
        {
          sourceName: 'superpowers',
          sourceUrl: 'github:obra/superpowers',
          agent: 'codex',
        },
        {
          sourceName: 'superpowers',
          sourceUrl: 'github:obra/superpowers',
          agent: 'claude-code',
        },
      ],
    })

    const withOverlap: Manifest = {
      ...withoutOverlap,
      skills: {
        ...withoutOverlap.skills,
        skills: [{ id: 'superpowers/custom', agents: ['codex'] }],
      },
    }
    expect(() => planProjection(withOverlap, withOverlap.config, new Set(['codex']))).toThrow(
      'Local skill destination "superpowers/custom" overlaps source namespace "superpowers" for codex',
    )
  })
  it.each(['superpowers', 'superpowers/custom'])(
    'rejects local skill destination %s overlapping a source namespace on the same agent',
    (localSkillId) => {
      const m: Manifest = {
        ...manifest,
        skills: {
          sources: [
            {
              ...manifest.skills.sources[0],
              members: [
                {
                  name: 'writing',
                  entry: 'skills/writing/SKILL.md',
                  agents: ['codex'],
                },
              ],
              sourceTree: sourceTreeFor(['skills/writing/SKILL.md']),
            },
          ],
          skills: [{ id: localSkillId, agents: ['codex'] }],
        },
      }

      expect(() => planProjection(m, m.config, new Set(['codex']))).toThrow(
        `Local skill destination "${localSkillId}" overlaps source namespace "superpowers" for codex`,
      )
    },
  )

  it('allows matching local and source names when their agents do not overlap', () => {
    const m: Manifest = {
      ...manifest,
      skills: {
        sources: [
          {
            ...manifest.skills.sources[0],
            members: [
              {
                name: 'writing',
                entry: 'skills/writing/SKILL.md',
                agents: ['codex'],
              },
            ],
            sourceTree: sourceTreeFor(['skills/writing/SKILL.md']),
          },
        ],
        skills: [{ id: 'superpowers', agents: ['claude-code'] }],
      },
    }

    expect(() => planProjection(m, m.config, new Set(['claude-code', 'codex']))).not.toThrow()
  })
  it('strategy: copy透传;无 projection 默认 link', () => {
    const pCopy = planProjection(
      manifest,
      { agents: ['claude-code'], projection: { strategy: 'copy' } },
      new Set(['claude-code']),
    )
    expect(pCopy.strategy).toBe('copy')
    const pDefault = planProjection(manifest, { agents: ['claude-code'] }, new Set(['claude-code']))
    expect(pDefault.strategy).toBe('link')
  })

  it('keeps selected roots relative while omitting their common unselected parent', () => {
    const source = {
      name: 'workflow-kit',
      url: 'https://example.test/workflow-kit.git',
      ref: 'main',
      members: [
        { name: 'skill-a', entry: 'folder/skill-a/SKILL.md', agents: ['codex' as const] },
        { name: 'skill-b', entry: 'folder/skill-b/SKILL.md', agents: ['codex' as const] },
      ],
      resources: {
        include: [{ path: 'folder/shared', kind: 'directory' as const }],
        exclude: [{ path: 'folder/shared/archive', kind: 'directory' as const }],
      },
      sourceTree: {
        commit: 'abc',
        diagnostics: [],
        nodes: [
          ...sourceTreeFor(['folder/skill-a/SKILL.md', 'folder/skill-b/SKILL.md']).nodes,
          {
            kind: 'container' as const,
            name: 'shared',
            path: 'folder/shared',
            mode: '040000',
            oid: 'shared',
            children: [
              {
                kind: 'resource' as const,
                name: 'workflow.md',
                path: 'folder/shared/workflow.md',
                mode: '100644',
                oid: 'workflow',
              },
              {
                kind: 'container' as const,
                name: 'archive',
                path: 'folder/shared/archive',
                mode: '040000',
                oid: 'archive',
                children: [
                  {
                    kind: 'resource' as const,
                    name: 'old.md',
                    path: 'folder/shared/archive/old.md',
                    mode: '100644',
                    oid: 'old',
                  },
                ],
              },
            ],
          },
        ],
      },
    }
    const planned = planProjection(
      { ...manifest, skills: { sources: [source], skills: [] } },
      manifest.config,
      new Set(['codex']),
    ).sourcePlans[0]

    expect(planned.projectionBase).toBe('folder')
    expect(planned.entries).toEqual([
      {
        kind: 'resource-file',
        sourcePath: 'folder/shared/workflow.md',
        targetPath: 'shared/workflow.md',
      },
      { kind: 'bundle', sourcePath: 'folder/skill-a', targetPath: 'skill-a' },
      { kind: 'bundle', sourcePath: 'folder/skill-b', targetPath: 'skill-b' },
    ])
  })

  it('maps a root-level bundle to the source namespace root', () => {
    const source = {
      name: 'root-skill',
      url: 'https://example.test/root-skill.git',
      ref: 'main',
      members: [{ name: 'root-skill', entry: 'SKILL.md', agents: ['codex' as const] }],
      sourceTree: sourceTreeFor(['SKILL.md']),
    }
    const planned = planProjection(
      { ...manifest, skills: { sources: [source], skills: [] } },
      manifest.config,
      new Set(['codex']),
    ).sourcePlans[0]

    expect(planned.projectionBase).toBe('')
    expect(planned.entries).toEqual([{ kind: 'bundle', sourcePath: '', targetPath: '' }])
  })
})
describe('planProjection skill_naming', () => {
  it('does not change source namespace planning for dir format', () => {
    const m = { ...manifest, config: { ...manifest.config, skill_naming: 'dir' as const } }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.sourcePlans[0].sourceName).toBe('superpowers')
  })
  it('does not flatten source namespace for hyphen format', () => {
    const m = { ...manifest, config: { ...manifest.config, skill_naming: 'hyphen' as const } }
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.sourcePlans[0].sourceName).toBe('superpowers')
  })
  it('defaults to dir format when unset', () => {
    const m = { ...manifest, config: { ...manifest.config } }
    delete (m.config as any).skill_naming
    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.sourcePlans[0].sourceName).toBe('superpowers')
  })
})

describe('source identity helpers', () => {
  it('derive repo id and select default naming in one place', () => {
    expect(sourceIdentity({ url: 'https://github.com/obra/superpowers.git' })).toEqual({
      repoId: 'superpowers',
    })
    expect(
      sourceIdentity({ name: 'openai-skills', url: 'https://github.com/obra/superpowers.git' }),
    ).toEqual({
      repoId: 'openai-skills',
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
