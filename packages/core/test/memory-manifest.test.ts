import { describe, it, expect } from 'vitest'
import { loadRepoManifest, buildManifest } from '../src/manifest.js'

describe('memory manifest', () => {
  it('loadRepoManifest reads memories/*.md into memoriesFiles', () => {
    const files = {
      'config.yaml': 'active_memory: v2\n',
      'memories/v1.md': '# v1 content',
      'memories/v2.md': '# v2 content',
    }
    const rm = loadRepoManifest(files)
    expect(Object.keys(rm.memoriesFiles).sort()).toEqual(['v1', 'v2'])
    expect(rm.memoriesFiles['v2']).toBe('# v2 content')
    expect((rm.repoConfig as any).active_memory).toBe('v2')
  })

  it('buildManifest sets memory.memories, active, activeContent', () => {
    const rm = loadRepoManifest({
      'config.yaml': 'active_memory: v2\n',
      'memories/v1.md': '# v1',
      'memories/v2.md': '# v2 ${LOOM_AGENT}',
    })
    const mf = buildManifest(rm, {})
    expect(mf.memory.memories.map((m) => m.name).sort()).toEqual(['v1', 'v2'])
    expect(mf.memory.active?.name).toBe('v2')
    expect(mf.memory.activeContent).toBe('# v2 ${LOOM_AGENT}')
  })

  it('active_memory pointing to missing memory: active=null, error recorded', () => {
    const rm = loadRepoManifest({ 'config.yaml': 'active_memory: nope\n', 'memories/v1.md': 'x' })
    const mf = buildManifest(rm, {})
    expect(mf.memory.active).toBeNull()
    expect(mf.errors.some((e) => e.includes('active_memory'))).toBe(true)
  })

  it('derives agent assignments for multiple memories', () => {
    const rm = loadRepoManifest({
      'config.yaml': [
        'agents:',
        '  - claude-code',
        '  - codex',
        '  - opencode',
        'memory_agents:',
        '  claude-code: team',
        '  codex: team',
        '  opencode: personal',
      ].join('\n'),
      'memories/team.md': '# team',
      'memories/personal.md': '# personal',
    })

    const mf = buildManifest(rm, {})

    expect(mf.memory.assignments).toEqual({
      'claude-code': 'team',
      codex: 'team',
      opencode: 'personal',
    })
    expect(mf.memory.memories.find((memory) => memory.name === 'team')?.agents).toEqual([
      'claude-code',
      'codex',
    ])
    expect(mf.memory.memories.find((memory) => memory.name === 'personal')?.agents).toEqual([
      'opencode',
    ])
  })

  it('uses memory_order before appending unordered memories', () => {
    const manifest = buildManifest(
      loadRepoManifest({
        'config.yaml': 'memory_order: [personal, team]\n',
        'memories/archive.md': '# archive',
        'memories/team.md': '# team',
        'memories/personal.md': '# personal',
      }),
      {},
    )

    expect(manifest.memory.memories.map((memory) => memory.name)).toEqual([
      'personal',
      'team',
      'archive',
    ])
  })

  it('assigns active_memory to legacy global agents when memory_agents is absent', () => {
    const manifest = buildManifest(
      loadRepoManifest({
        'config.yaml': ['agents: [codex, opencode]', 'active_memory: team'].join('\n'),
        'memories/team.md': '# team',
      }),
      {},
    )

    expect(manifest.memory.assignments).toEqual({ codex: 'team', opencode: 'team' })
    expect(manifest.memory.memories[0].agents).toEqual(['codex', 'opencode'])
  })

  it('records invalid memory agent references without assigning them', () => {
    const rm = loadRepoManifest({
      'config.yaml': ['memory_agents:', '  codex: missing', '  unknown-agent: team'].join('\n'),
      'memories/team.md': '# team',
    })

    const mf = buildManifest(rm, {})

    expect(mf.memory.assignments).toEqual({})
    expect(mf.errors).toContain('memory_agents.codex references unknown memory: missing')
    expect(mf.errors).toContain('memory_agents references unknown agent: unknown-agent')
  })

  it('no memories dir: empty list, active=null, no error', () => {
    const rm = loadRepoManifest({ 'config.yaml': '' })
    const mf = buildManifest(rm, {})
    expect(mf.memory.memories).toEqual([])
    expect(mf.memory.active).toBeNull()
  })
})
