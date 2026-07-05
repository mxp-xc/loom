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

  it('no memories dir: empty list, active=null, no error', () => {
    const rm = loadRepoManifest({ 'config.yaml': '' })
    const mf = buildManifest(rm, {})
    expect(mf.memory.memories).toEqual([])
    expect(mf.memory.active).toBeNull()
  })
})
