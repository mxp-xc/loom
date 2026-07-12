import { describe, it, expect } from 'vitest'
import {
  addLocalSkill,
  removeLocalSkill,
  addSource,
  removeSource,
  setSourceMembers,
  setSourceMemberTargets,
  setSkillTargets,
  setLocalSkillTargets,
  pinSourceCommit,
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  setMcpTargets,
  setConfigField,
  updateSourceMeta,
} from '../src/mutators.js'
import type { SkillsManifest, McpServer, AgentId } from '../src/types.js'

const emptySkills: SkillsManifest = { sources: [], skills: [] }

describe('addLocalSkill', () => {
  it('adds a skill and returns changed=true', () => {
    const result = addLocalSkill(emptySkills, { id: 'test' })
    expect(result.changed).toBe(true)
    expect(result.data.skills).toHaveLength(1)
  })
  it('preserves unknown YAML fields via spread', () => {
    const skills = { sources: [], skills: [{ id: 'a', customField: 'x' } as any] }
    const result = addLocalSkill(skills, { id: 'b' })
    expect(result.data.skills[0]).toHaveProperty('customField', 'x')
  })
  it('does not mutate the input', () => {
    const result = addLocalSkill(emptySkills, { id: 'test' })
    expect(emptySkills.skills).toHaveLength(0)
    expect(result.data).not.toBe(emptySkills)
  })
})

describe('removeLocalSkill', () => {
  it('removes a skill by id and returns changed=true', () => {
    const skills: SkillsManifest = { sources: [], skills: [{ id: 'a' }, { id: 'b' }] }
    const result = removeLocalSkill(skills, 'a')
    expect(result.changed).toBe(true)
    expect(result.data.skills).toEqual([{ id: 'b' }])
  })
  it('returns changed=false when id not found', () => {
    const result = removeLocalSkill(emptySkills, 'missing')
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
  it('does not mutate the input', () => {
    const skills: SkillsManifest = { sources: [], skills: [{ id: 'a' }] }
    removeLocalSkill(skills, 'a')
    expect(skills.skills).toHaveLength(1)
  })
})

describe('addSource', () => {
  it('adds a source and returns changed=true', () => {
    const result = addSource(emptySkills, { url: 'https://github.com/test/repo', ref: 'main' })
    expect(result.changed).toBe(true)
    expect(result.data.sources).toHaveLength(1)
    expect(result.data.sources[0]).toEqual({ url: 'https://github.com/test/repo', ref: 'main' })
  })
  it('persists an explicit source name', () => {
    const result = addSource(emptySkills, {
      name: 'openai-skills',
      url: 'https://github.com/test/repo',
      ref: 'main',
    })
    expect(result.data.sources[0]).toEqual({
      name: 'openai-skills',
      url: 'https://github.com/test/repo',
      ref: 'main',
    })
  })
  it('preserves existing sources via spread', () => {
    const skills: SkillsManifest = {
      sources: [{ url: 'https://github.com/a/b', ref: 'v1', custom: 'keep' } as any],
      skills: [],
    }
    const result = addSource(skills, { url: 'https://github.com/c/d', ref: 'main' })
    expect(result.data.sources[0]).toHaveProperty('custom', 'keep')
    expect(result.data.sources).toHaveLength(2)
  })
})

describe('updateSourceMeta', () => {
  it('updates a source name without touching members', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          name: 'old-name',
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [{ name: 'skill-a', targets: ['codex' as AgentId] }],
        },
      ],
      skills: [],
    }
    const result = updateSourceMeta(skills, 'https://github.com/test/repo', {
      name: 'new-name',
    })
    expect(result.data.sources[0]).toEqual({
      name: 'new-name',
      url: 'https://github.com/test/repo',
      ref: 'main',
      members: [{ name: 'skill-a', targets: ['codex'] }],
    })
  })
})

describe('removeSource', () => {
  it('removes a source by url and returns changed=true', () => {
    const skills: SkillsManifest = {
      sources: [
        { url: 'https://github.com/a/b', ref: 'main' },
        { url: 'https://github.com/c/d', ref: 'main' },
      ],
      skills: [],
    }
    const result = removeSource(skills, 'https://github.com/a/b')
    expect(result.changed).toBe(true)
    expect(result.data.sources).toHaveLength(1)
    expect(result.data.sources[0].url).toBe('https://github.com/c/d')
  })
  it('returns changed=false when url not found', () => {
    const result = removeSource(emptySkills, 'missing')
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setSourceMembers', () => {
  it('preserves existing member targets for retained names', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [{ name: 'skill-a', targets: ['codex' as AgentId] }],
        },
      ],
      skills: [],
    }
    const result = setSourceMembers(skills, 'https://github.com/test/repo', ['skill-a', 'skill-b'])
    const members = result.data.sources[0].members!
    expect(members[0]).toEqual({ name: 'skill-a', targets: ['codex'] })
    expect(members[1]).toEqual({ name: 'skill-b' })
  })
  it('drops members not in the new selection', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [{ name: 'skill-a', targets: ['codex' as AgentId] }, { name: 'skill-b' }],
        },
      ],
      skills: [],
    }
    const result = setSourceMembers(skills, 'https://github.com/test/repo', ['skill-a'])
    expect(result.data.sources[0].members!).toHaveLength(1)
    expect(result.data.sources[0].members![0].name).toBe('skill-a')
  })
  it('returns changed=false when source not found', () => {
    const result = setSourceMembers(emptySkills, 'missing', ['a'])
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setSkillTargets', () => {
  it('sets targets on an existing member', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [{ name: 'skill-a' }],
        },
      ],
      skills: [],
    }
    const result = setSkillTargets(skills, 'https://github.com/test/repo', 'skill-a', [
      'codex' as AgentId,
    ])
    expect(result.changed).toBe(true)
    expect(result.data.sources[0].members![0].targets).toEqual(['codex'])
  })
  it('creates the member when it does not exist', () => {
    const skills: SkillsManifest = {
      sources: [{ url: 'https://github.com/test/repo', ref: 'main' }],
      skills: [],
    }
    const result = setSkillTargets(skills, 'https://github.com/test/repo', 'skill-a', [
      'codex' as AgentId,
    ])
    expect(result.data.sources[0].members!).toHaveLength(1)
    expect(result.data.sources[0].members![0]).toEqual({ name: 'skill-a', targets: ['codex'] })
  })
  it('sets source-level targets when memberName is empty', () => {
    const skills: SkillsManifest = {
      sources: [{ url: 'https://github.com/test/repo', ref: 'main' }],
      skills: [],
    }
    const result = setSkillTargets(skills, 'https://github.com/test/repo', '', ['codex' as AgentId])
    expect(result.changed).toBe(true)
    expect((result.data.sources[0] as any).targets).toEqual(['codex'])
  })
  it('returns changed=false when source not found', () => {
    const result = setSkillTargets(emptySkills, 'missing', 'skill-a', ['codex' as AgentId])
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setSourceMemberTargets', () => {
  it('updates multiple existing source members in one mutation', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [
            { name: 'skill-a', targets: ['claude-code' as AgentId] },
            { name: 'skill-b', enabled: false, targets: [] },
            { name: 'skill-c', targets: [] },
          ],
        },
      ],
      skills: [],
    }

    const result = setSourceMemberTargets(skills, 'https://github.com/test/repo', [
      { memberName: 'skill-a', targets: ['codex' as AgentId] },
      { memberName: 'skill-c', targets: ['codex' as AgentId, 'opencode' as AgentId] },
    ])

    expect(result.changed).toBe(true)
    expect(result.data.sources[0].members).toEqual([
      { name: 'skill-a', targets: ['codex'] },
      { name: 'skill-b', enabled: false, targets: [] },
      { name: 'skill-c', targets: ['codex', 'opencode'] },
    ])
  })

  it('returns changed=false when source not found', () => {
    const result = setSourceMemberTargets(emptySkills, 'missing', [
      { memberName: 'skill-a', targets: ['codex' as AgentId] },
    ])

    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setLocalSkillTargets', () => {
  it('sets targets on an existing local skill', () => {
    const skills: SkillsManifest = { sources: [], skills: [{ id: 'my-skill' }] }
    const result = setLocalSkillTargets(skills, 'my-skill', ['codex' as AgentId])
    expect(result.changed).toBe(true)
    expect(result.data.skills[0].targets).toEqual(['codex'])
  })
  it('registers an auto-discovered local skill when first assigning targets', () => {
    const result = setLocalSkillTargets(emptySkills, 'frontend-design', ['codex' as AgentId])
    expect(result.changed).toBe(true)
    expect(result.data.skills).toEqual([{ id: 'frontend-design', targets: ['codex'] }])
  })
  it('preserves other fields on the skill via spread', () => {
    const skills: SkillsManifest = {
      sources: [],
      skills: [{ id: 'my-skill', path: '/some/path' } as any],
    }
    const result = setLocalSkillTargets(skills, 'my-skill', ['codex' as AgentId])
    expect(result.data.skills[0].path).toBe('/some/path')
    expect(result.data.skills[0].targets).toEqual(['codex'])
  })
})

describe('pinSourceCommit', () => {
  it('returns changed=false when source not found', () => {
    const result = pinSourceCommit(emptySkills, 'missing-url', 'abc123')
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
  it('sets pinned_commit and ref when provided', () => {
    const skills: SkillsManifest = {
      sources: [{ url: 'https://github.com/test/repo', ref: 'main' }],
      skills: [],
    }
    const result = pinSourceCommit(skills, 'https://github.com/test/repo', 'abc123', 'v2')
    expect(result.data.sources[0].pinned_commit).toBe('abc123')
    expect(result.data.sources[0].ref).toBe('v2')
  })
  it('does not change ref when not provided', () => {
    const skills: SkillsManifest = {
      sources: [{ url: 'https://github.com/test/repo', ref: 'main' }],
      skills: [],
    }
    const result = pinSourceCommit(skills, 'https://github.com/test/repo', 'abc123')
    expect(result.data.sources[0].ref).toBe('main')
    expect(result.data.sources[0].pinned_commit).toBe('abc123')
  })
})

describe('addMcpServer', () => {
  it('adds a server and returns changed=true', () => {
    const server: McpServer = { id: 'playwright', type: 'stdio', command: 'npx' }
    const result = addMcpServer([], server)
    expect(result.changed).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toBe(server)
  })
})

describe('removeMcpServer', () => {
  it('removes a server by id and returns changed=true', () => {
    const mcp: McpServer[] = [
      { id: 'a', type: 'stdio', command: 'c' },
      { id: 'b', type: 'stdio', command: 'd' },
    ]
    const result = removeMcpServer(mcp, 'a')
    expect(result.changed).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe('b')
  })
  it('returns changed=false when id not found', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const result = removeMcpServer(mcp, 'missing')
    expect(result.changed).toBe(false)
    expect(result.data).toBe(mcp)
  })
})

describe('updateMcpServer', () => {
  it('replaces an existing server while keeping its id stable', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'old' }]
    const replacement: McpServer = {
      id: 'a',
      type: 'http',
      url: 'https://example.test/mcp',
      targets: ['codex'],
    }

    const result = updateMcpServer(mcp, 'a', replacement)

    expect(result.changed).toBe(true)
    expect(result.data).toEqual([replacement])
  })

  it('returns changed=false when the server does not exist', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'old' }]
    const result = updateMcpServer(mcp, 'missing', {
      id: 'missing',
      type: 'stdio',
      command: 'new',
    })

    expect(result.changed).toBe(false)
    expect(result.data).toBe(mcp)
  })
})

describe('setMcpTargets', () => {
  it('sets targets on an existing server', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const result = setMcpTargets(mcp, 'a', ['codex' as AgentId])
    expect(result.changed).toBe(true)
    expect(result.data[0].targets).toEqual(['codex'])
  })
  it('preserves other fields via spread', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c', args: ['x'] }]
    const result = setMcpTargets(mcp, 'a', ['codex' as AgentId])
    expect(result.data[0].command).toBe('c')
    expect(result.data[0].args).toEqual(['x'])
  })
  it('returns changed=false when server not found', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const result = setMcpTargets(mcp, 'missing', ['codex' as AgentId])
    expect(result.changed).toBe(false)
    expect(result.data).toBe(mcp)
  })
})

describe('setConfigField', () => {
  it('sets a field', () => {
    const result = setConfigField({ profile: 'default' }, 'active_repo', 'myrepo')
    expect(result.changed).toBe(true)
    expect(result.data.active_repo).toBe('myrepo')
  })
  it('deletes field when value is null', () => {
    const result = setConfigField({ profile: 'default', active_repo: 'x' }, 'active_repo', null)
    expect(result.changed).toBe(true)
    expect(result.data).not.toHaveProperty('active_repo')
  })
  it('returns changed=false when deleting a non-existent field', () => {
    const result = setConfigField({ profile: 'default' }, 'active_repo', null)
    expect(result.changed).toBe(false)
  })
  it('returns changed=false when setting the same value', () => {
    const result = setConfigField({ profile: 'default' }, 'profile', 'default')
    expect(result.changed).toBe(false)
  })
  it('preserves other fields via spread', () => {
    const result = setConfigField({ profile: 'default', targets: ['codex'] }, 'active_repo', 'r')
    expect(result.data.profile).toBe('default')
    expect(result.data.targets).toEqual(['codex'])
  })
  it('sets a nested field via dot path', () => {
    const result = setConfigField(
      { projection: { strategy: 'link' } },
      'projection.strategy',
      'copy',
    )
    expect(result.changed).toBe(true)
    expect(result.data).toEqual({ projection: { strategy: 'copy' } })
  })
  it('creates intermediate objects when setting a dot path on missing parent', () => {
    const result = setConfigField({}, 'proxy.http', 'http://127.0.0.1:7890')
    expect(result.changed).toBe(true)
    expect(result.data).toEqual({ proxy: { http: 'http://127.0.0.1:7890' } })
  })
  it('preserves sibling keys when setting a nested field', () => {
    const result = setConfigField({ proxy: { http: 'a', https: 'b' } }, 'proxy.http', 'c')
    expect(result.data).toEqual({ proxy: { http: 'c', https: 'b' } })
  })
  it('deletes a nested field via dot path when value is null', () => {
    const result = setConfigField({ proxy: { http: 'a', https: 'b' } }, 'proxy.http', null)
    expect(result.changed).toBe(true)
    expect(result.data).toEqual({ proxy: { https: 'b' } })
  })
  it('returns changed=false when deleting a non-existent nested field', () => {
    const result = setConfigField({ proxy: { https: 'b' } }, 'proxy.http', null)
    expect(result.changed).toBe(false)
  })
  it('returns changed=false when setting the same nested value', () => {
    const result = setConfigField(
      { projection: { strategy: 'link' } },
      'projection.strategy',
      'link',
    )
    expect(result.changed).toBe(false)
  })
  it('still handles top-level fields (no dot)', () => {
    const result = setConfigField({ profile: 'default' }, 'active_repo', 'myrepo')
    expect(result.changed).toBe(true)
    expect(result.data.active_repo).toBe('myrepo')
  })
})
