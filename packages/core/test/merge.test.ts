import { describe, it, expect } from 'vitest'
import { threeWayMerge } from '../src/merge'

describe('threeWayMerge', () => {
  it('both add different mcp servers -> auto merge both', () => {
    const base = '[]'
    const ours = '- id: a\n  type: stdio\n  command: c\n  targets: [claude-code]\n'
    const theirs = '- id: b\n  type: stdio\n  command: c\n  targets: [claude-code]\n'
    const r = threeWayMerge(base, ours, theirs, 'mcp')
    expect(r.merged).toContain('id: a'); expect(r.merged).toContain('id: b')
    expect(r.conflicts).toHaveLength(0)
  })
  it('both change same mcp id same field -> conflict', () => {
    const base = '- id: a\n  type: stdio\n  command: old\n  targets: [claude-code]\n'
    const ours = '- id: a\n  type: stdio\n  command: ours\n  targets: [claude-code]\n'
    const theirs = '- id: a\n  type: stdio\n  command: theirs\n  targets: [claude-code]\n'
    const r = threeWayMerge(base, ours, theirs, 'mcp')
    expect(r.conflicts.length).toBeGreaterThan(0)
    expect(r.conflicts[0].path).toContain('a')
    expect(r.conflicts[0].field).toBe('command')
  })
  it('vars top-level key merge', () => {
    const base = 'a: 1\n'
    const ours = 'a: 1\nb: 2\n'
    const theirs = 'a: 1\nc: 3\n'
    const r = threeWayMerge(base, ours, theirs, 'vars')
    expect(r.merged).toContain('b: 2'); expect(r.merged).toContain('c: 3')
    expect(r.conflicts).toHaveLength(0)
  })
  it('skills sources merge by url', () => {
    const base = 'sources: []\nskills: []\n'
    const ours = 'sources:\n  - url: github:x/y\n    ref: v1\nskills: []\n'
    const theirs = 'sources:\n  - url: github:z/w\n    ref: v1\nskills: []\n'
    const r = threeWayMerge(base, ours, theirs, 'skills')
    expect(r.merged).toContain('github:x/y'); expect(r.merged).toContain('github:z/w')
  })
  it('config: both add different top-level fields -> auto merge', () => {
    const r = threeWayMerge('profile: local\n', 'profile: local\ntargets: [claude-code]\n', 'profile: local\nupdate_check:\n  enabled: true\n', 'config')
    expect(r.merged).toContain('targets'); expect(r.merged).toContain('update_check')
    expect(r.conflicts).toHaveLength(0)
  })
  it('config: both change same top-level field -> conflict', () => {
    const r = threeWayMerge('targets: [claude-code]\n', 'targets: [codex]\n', 'targets: [opencode]\n', 'config')
    expect(r.conflicts.length).toBeGreaterThan(0)
    expect(r.conflicts[0].path).toBe('targets')
  })
  it('config: nested object deep merge, sibling subfield no conflict', () => {
    const base = 'proxy:\n  http: r\n  https: r\n'
    const r = threeWayMerge(base, 'proxy:\n  http: L\n  https: r\n', 'proxy:\n  http: r\n  https: L2\n', 'config')
    expect(r.merged).toContain('http: L'); expect(r.merged).toContain('https: L2')
    expect(r.conflicts).toHaveLength(0)
  })
  it('mcp: both delete same id -> not in merged', () => {
    const r = threeWayMerge('- id: x\n  type: stdio\n  command: c\n  targets: [claude-code]\n', '[]', '[]', 'mcp')
    expect(r.merged).not.toContain('id: x')
  })
  it('skills: same url both change ref differently -> conflict on ref', () => {
    const base = 'sources:\n  - url: github:x/y\n    ref: v1\nskills: []\n'
    const ours = 'sources:\n  - url: github:x/y\n    ref: v2\nskills: []\n'
    const theirs = 'sources:\n  - url: github:x/y\n    ref: v3\nskills: []\n'
    const r = threeWayMerge(base, ours, theirs, 'skills')
    expect(r.conflicts.some(c => c.path.includes('github:x/y') && c.field === 'ref')).toBe(true)
  })
  it('vars: one side delete, other side modify -> modify wins', () => {
    const base = 'a: 1\nb: 2\n'
    const ours = 'a: 1\n'
    const theirs = 'a: 1\nb: 22\n'
    const r = threeWayMerge(base, ours, theirs, 'vars')
    expect(r.merged).toContain('b: 22')
    expect(r.conflicts).toHaveLength(0)
  })
})
