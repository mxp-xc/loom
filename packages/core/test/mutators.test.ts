import { describe, it, expect } from 'vitest'
import {
  addLocalSkill,
  removeLocalSkill,
  addSource,
  removeSource,
  setSourceMembers,
  setSourceMemberAgents,
  setSkillAgents,
  setLocalSkillAgents,
  pinSourceCommit,
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  setMcpAgents,
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
  it('does not mutate the input', () => {
    const result = addLocalSkill(emptySkills, { id: 'test' })
    expect(emptySkills.skills).toHaveLength(0)
    expect(result.data).not.toBe(emptySkills)
  })
  it('does not append a duplicate identity', () => {
    const skills: SkillsManifest = { sources: [], skills: [{ id: 'test' }] }
    const result = addLocalSkill(skills, { id: 'test', path: '/other' })

    expect(result).toEqual({ changed: false, data: skills })
  })
  it.each(['nested/skill', '../skill', 'BadSkill'])(
    'rejects invalid identity %s before mutation',
    (id) => {
      expect(() => addLocalSkill(emptySkills, { id })).toThrow('Invalid local skill id')
    },
  )
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
  it('rejects invalid identity before mutation', () => {
    expect(() => removeLocalSkill(emptySkills, '../outside')).toThrow('Invalid local skill id')
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
  it('persists optional source metadata', () => {
    const source = {
      name: 'repo',
      url: 'https://github.com/test/repo',
      ref: 'v1.0.0',
      type: 'tag' as const,
      pinned_commit: 'abc123',
      members: [{ name: 'skill', entry: 'skill/SKILL.md' }],
      resources: { include: [{ path: 'shared', kind: 'directory' as const }], exclude: [] },
    }

    expect(addSource(emptySkills, source).data.sources[0]).toEqual(source)
  })
})

describe('updateSourceMeta', () => {
  it('updates source metadata without touching members', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          name: 'old-name',
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [
            { name: 'skill-a', entry: 'skills/skill-a/SKILL.md', agents: ['codex' as AgentId] },
          ],
        },
      ],
      skills: [],
    }
    const result = updateSourceMeta(skills, 'https://github.com/test/repo', {
      name: 'new-name',
      ref: 'v2.0.0',
      type: 'tag',
    })
    expect(result.data.sources[0]).toEqual({
      name: 'new-name',
      url: 'https://github.com/test/repo',
      ref: 'v2.0.0',
      type: 'tag',
      members: [{ name: 'skill-a', entry: 'skills/skill-a/SKILL.md', agents: ['codex'] }],
    })
  })
  it('returns changed=false when the source does not exist', () => {
    expect(updateSourceMeta(emptySkills, 'missing', { ref: 'next' })).toEqual({
      changed: false,
      data: emptySkills,
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
  it('preserves existing member agents for retained entries and refreshes names', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [
            { name: 'old-name', entry: 'skills/skill-a/SKILL.md', agents: ['codex' as AgentId] },
          ],
        },
      ],
      skills: [],
    }
    const result = setSourceMembers(skills, 'https://github.com/test/repo', [
      { name: 'skill-a', entry: 'skills/skill-a/SKILL.md' },
      { name: 'skill-b', entry: 'skills/skill-b/SKILL.md' },
    ])
    const members = result.data.sources[0].members!
    expect(members[0]).toEqual({
      name: 'skill-a',
      entry: 'skills/skill-a/SKILL.md',
      agents: ['codex'],
    })
    expect(members[1]).toEqual({ name: 'skill-b', entry: 'skills/skill-b/SKILL.md' })
  })
  it('drops members not in the new selection', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [
            { name: 'skill-a', entry: 'skills/skill-a/SKILL.md', agents: ['codex' as AgentId] },
            { name: 'skill-b', entry: 'skills/skill-b/SKILL.md' },
          ],
        },
      ],
      skills: [],
    }
    const result = setSourceMembers(skills, 'https://github.com/test/repo', [
      { name: 'skill-a', entry: 'skills/skill-a/SKILL.md' },
    ])
    expect(result.data.sources[0].members!).toHaveLength(1)
    expect(result.data.sources[0].members![0].name).toBe('skill-a')
  })
  it('returns changed=false when source not found', () => {
    const result = setSourceMembers(emptySkills, 'missing', [{ name: 'a', entry: 'a/SKILL.md' }])
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setSkillAgents', () => {
  it('sets agents on an existing member', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [{ name: 'skill-a', entry: 'skills/skill-a/SKILL.md' }],
        },
      ],
      skills: [],
    }
    const result = setSkillAgents(
      skills,
      'https://github.com/test/repo',
      'skills/skill-a/SKILL.md',
      ['codex' as AgentId],
    )
    expect(result.changed).toBe(true)
    expect(result.data.sources[0].members![0].agents).toEqual(['codex'])
  })
  it('does not create an unknown member entry', () => {
    const skills: SkillsManifest = {
      sources: [{ url: 'https://github.com/test/repo', ref: 'main' }],
      skills: [],
    }
    const result = setSkillAgents(
      skills,
      'https://github.com/test/repo',
      'skills/skill-a/SKILL.md',
      ['codex' as AgentId],
    )
    expect(result.changed).toBe(false)
    expect(result.data).toBe(skills)
  })
  it('returns changed=false when source not found', () => {
    const result = setSkillAgents(emptySkills, 'missing', 'skills/skill-a/SKILL.md', [
      'codex' as AgentId,
    ])
    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setSourceMemberAgents', () => {
  it('updates multiple existing source members in one mutation', () => {
    const skills: SkillsManifest = {
      sources: [
        {
          url: 'https://github.com/test/repo',
          ref: 'main',
          members: [
            { name: 'skill-a', entry: 'a/SKILL.md', agents: ['claude-code' as AgentId] },
            { name: 'skill-b', entry: 'b/SKILL.md', agents: [] },
            { name: 'skill-c', entry: 'c/SKILL.md', agents: [] },
          ],
        },
      ],
      skills: [],
    }

    const result = setSourceMemberAgents(skills, 'https://github.com/test/repo', [
      { memberEntry: 'a/SKILL.md', agents: ['codex' as AgentId] },
      { memberEntry: 'c/SKILL.md', agents: ['codex' as AgentId, 'opencode' as AgentId] },
    ])

    expect(result.changed).toBe(true)
    expect(result.data.sources[0].members).toEqual([
      { name: 'skill-a', entry: 'a/SKILL.md', agents: ['codex'] },
      { name: 'skill-b', entry: 'b/SKILL.md', agents: [] },
      { name: 'skill-c', entry: 'c/SKILL.md', agents: ['codex', 'opencode'] },
    ])
  })

  it('returns changed=false when source not found', () => {
    const result = setSourceMemberAgents(emptySkills, 'missing', [
      { memberEntry: 'a/SKILL.md', agents: ['codex' as AgentId] },
    ])

    expect(result.changed).toBe(false)
    expect(result.data).toBe(emptySkills)
  })
})

describe('setLocalSkillAgents', () => {
  it('sets agents on an existing local skill', () => {
    const skills: SkillsManifest = { sources: [], skills: [{ id: 'my-skill' }] }
    const result = setLocalSkillAgents(skills, 'my-skill', ['codex' as AgentId])
    expect(result.changed).toBe(true)
    expect(result.data.skills[0].agents).toEqual(['codex'])
  })
  it('does not implicitly register an unknown local skill', () => {
    const result = setLocalSkillAgents(emptySkills, 'frontend-design', ['codex' as AgentId])
    expect(result).toEqual({ changed: false, data: emptySkills })
  })
  it('preserves other fields on the skill via spread', () => {
    const skills: SkillsManifest = {
      sources: [],
      skills: [{ id: 'my-skill', path: '/some/path' } as any],
    }
    const result = setLocalSkillAgents(skills, 'my-skill', ['codex' as AgentId])
    expect(result.data.skills[0].path).toBe('/some/path')
    expect(result.data.skills[0].agents).toEqual(['codex'])
  })
  it('rejects invalid identity before mutation', () => {
    expect(() => setLocalSkillAgents(emptySkills, '../outside', ['codex' as AgentId])).toThrow(
      'Invalid local skill id',
    )
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
      id: 'replacement-id',
      type: 'http',
      url: 'https://example.test/mcp',
      agents: ['codex'],
    }

    const result = updateMcpServer(mcp, 'a', replacement)

    expect(result.changed).toBe(true)
    expect(result.data).toEqual([{ ...replacement, id: 'a' }])
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

describe('setMcpAgents', () => {
  it('sets agents on an existing server', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const result = setMcpAgents(mcp, 'a', ['codex' as AgentId])
    expect(result.changed).toBe(true)
    expect(result.data[0].agents).toEqual(['codex'])
  })
  it('preserves other fields via spread', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c', args: ['x'] }]
    const result = setMcpAgents(mcp, 'a', ['codex' as AgentId])
    expect(result.data[0].command).toBe('c')
    expect(result.data[0].args).toEqual(['x'])
  })
  it('returns changed=false when server not found', () => {
    const mcp: McpServer[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const result = setMcpAgents(mcp, 'missing', ['codex' as AgentId])
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
    const result = setConfigField({ profile: 'default', agents: ['codex'] }, 'active_repo', 'r')
    expect(result.data.profile).toBe('default')
    expect(result.data.agents).toEqual(['codex'])
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
  it('treats inherited fields as absent', () => {
    const config = Object.create({ profile: 'inherited' }) as Record<string, unknown>
    const result = setConfigField(config, 'profile', 'inherited')

    expect(result.changed).toBe(true)
    expect(Object.hasOwn(result.data, 'profile')).toBe(true)
  })
  it('does not delete inherited fields', () => {
    const config = Object.create({ profile: 'inherited' }) as Record<string, unknown>
    expect(setConfigField(config, 'profile', null)).toEqual({ changed: false, data: config })
  })
  it.each([{ proxy: [] }, { proxy: 'http://proxy.test' }, { proxy: new Date() }])(
    'rejects nested writes through a non-plain parent',
    (config) => {
      expect(() => setConfigField(config, 'proxy.http', 'http://localhost')).toThrow(
        'Config field proxy is not an object',
      )
    },
  )
  it.each(['__proto__.polluted', 'constructor.prototype.polluted', 'proxy..http'])(
    'rejects unsafe config path %s',
    (field) => {
      expect(() => setConfigField({}, field, true)).toThrow('Invalid config field path')
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    },
  )
  it('supports null-prototype nested records', () => {
    const proxy = Object.assign(Object.create(null) as Record<string, unknown>, { https: 'b' })
    const result = setConfigField({ proxy }, 'proxy.http', 'a')

    expect(result.data).toEqual({ proxy: { http: 'a', https: 'b' } })
  })
})
