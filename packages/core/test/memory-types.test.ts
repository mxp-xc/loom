import { describe, it, expect, expectTypeOf } from 'vitest'
import type { Memory, MemoryManifest, Manifest, Config, RepoManifest } from '../src/types.js'

describe('memory types', () => {
  it('Memory has name and optional content', () => {
    const m: Memory = { name: 'v1' }
    expect(m.name).toBe('v1')
    const m2: Memory = { name: 'v2', content: '...' }
    expect(m2.content).toBe('...')
    expectTypeOf(m).toMatchTypeOf<Memory>()
    expectTypeOf(m2).toMatchTypeOf<Memory>()
  })

  it('MemoryManifest has memories, active, activeContent', () => {
    const mm: MemoryManifest = {
      memories: [{ name: 'v1' }],
      active: { name: 'v1' },
      activeContent: 'text',
    }
    expect(mm.active?.name).toBe('v1')
    expectTypeOf(mm).toMatchTypeOf<MemoryManifest>()
  })

  it('Config has active_memory', () => {
    const c: Config = { active_memory: 'v1' }
    expect(c.active_memory).toBe('v1')
    expectTypeOf(c).toMatchTypeOf<Config>()
  })

  it('Manifest has memory field', () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [], active: null, activeContent: '' },
      vars: { default: {}, active: {} },
      config: {},
      errors: [],
    }
    expect(mf.memory.active).toBeNull()
    expectTypeOf(mf.memory).toMatchTypeOf<MemoryManifest>()
  })

  it('RepoManifest has memoriesFiles', () => {
    const rm: RepoManifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      varsFiles: {},
      repoConfig: {},
      memoriesFiles: {},
    }
    expect(rm.memoriesFiles).toBeDefined()
    expectTypeOf(rm.memoriesFiles).toMatchTypeOf<Record<string, string>>()
  })
})
