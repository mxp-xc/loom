import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { threeWayMerge } from '../src/merge'

function parsed<T>(value: string): T {
  return yaml.load(value) as T
}

describe('threeWayMerge', () => {
  it('both add different mcp servers -> auto merge both', () => {
    const base = '[]'
    const ours = '- id: a\n  type: stdio\n  command: c\n  agents: [claude-code]\n'
    const theirs = '- id: b\n  type: stdio\n  command: c\n  agents: [claude-code]\n'
    const r = threeWayMerge(base, ours, theirs, 'mcp')
    expect(r.merged).toContain('id: a')
    expect(r.merged).toContain('id: b')
    expect(r.conflicts).toHaveLength(0)
  })
  it('both change same mcp id same field -> conflict', () => {
    const base = '- id: a\n  type: stdio\n  command: old\n  agents: [claude-code]\n'
    const ours = '- id: a\n  type: stdio\n  command: ours\n  agents: [claude-code]\n'
    const theirs = '- id: a\n  type: stdio\n  command: theirs\n  agents: [claude-code]\n'
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
    expect(r.merged).toContain('b: 2')
    expect(r.merged).toContain('c: 3')
    expect(r.conflicts).toHaveLength(0)
  })
  it('skills sources merge by url', () => {
    const base = 'sources: []\nskills: []\n'
    const ours = 'sources:\n  - url: github:x/y\n    ref: v1\nskills: []\n'
    const theirs = 'sources:\n  - url: github:z/w\n    ref: v1\nskills: []\n'
    const r = threeWayMerge(base, ours, theirs, 'skills')
    expect(r.merged).toContain('github:x/y')
    expect(r.merged).toContain('github:z/w')
  })
  it('config: both add different top-level fields -> auto merge', () => {
    const r = threeWayMerge(
      'profile: local\n',
      'profile: local\nagents: [claude-code]\n',
      'profile: local\nupdate_check:\n  enabled: true\n',
      'config',
    )
    expect(r.merged).toContain('agents')
    expect(r.merged).toContain('update_check')
    expect(r.conflicts).toHaveLength(0)
  })
  it('config: both change same top-level field -> conflict', () => {
    const r = threeWayMerge(
      'agents: [claude-code]\n',
      'agents: [codex]\n',
      'agents: [opencode]\n',
      'config',
    )
    expect(r.conflicts.length).toBeGreaterThan(0)
    expect(r.conflicts[0].path).toBe('agents')
  })
  it('config: nested object deep merge, sibling subfield no conflict', () => {
    const base = 'proxy:\n  http: r\n  https: r\n'
    const r = threeWayMerge(
      base,
      'proxy:\n  http: L\n  https: r\n',
      'proxy:\n  http: r\n  https: L2\n',
      'config',
    )
    expect(r.merged).toContain('http: L')
    expect(r.merged).toContain('https: L2')
    expect(r.conflicts).toHaveLength(0)
  })
  it('config: object key order alone is not a conflict', () => {
    const r = threeWayMerge(
      'settings:\n  a: 1\n  b: 2\n',
      'settings:\n  b: 2\n  a: 1\n',
      'settings:\n  a: 1\n  b: 2\n',
      'config',
    )

    expect(r.conflicts).toHaveLength(0)
    expect(r.merged).toContain('settings:')
  })
  it.each([
    ['', '', '', {}],
    ['', 'profile: local\n', '', { profile: 'local' }],
    ['profile: local\n', '', 'profile: local\n', {}],
    ['profile: local\n', 'profile: local\n', '', {}],
  ])('config: treats empty documents as empty objects', (base, ours, theirs, expected) => {
    const result = threeWayMerge(base, ours, theirs, 'config')

    expect(parsed(result.merged)).toEqual(expected)
    expect(result.conflicts).toEqual([])
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'config: preserves an own %s key without reading inherited values',
    (key) => {
      const field = JSON.stringify(key)
      const added = threeWayMerge('{}\n', `${field}: ours\n`, '{}\n', 'config')
      const addedValue = parsed<Record<string, unknown>>(added.merged)
      expect(Object.hasOwn(addedValue, key)).toBe(true)
      expect(addedValue[key]).toBe('ours')
      expect(added.conflicts).toEqual([])

      const deleted = threeWayMerge(`${field}: base\n`, '{}\n', `${field}: base\n`, 'config')
      expect(parsed(deleted.merged)).toEqual({})
      expect(deleted.conflicts).toEqual([])

      const conflicted = threeWayMerge(
        `${field}: base\n`,
        `${field}: ours\n`,
        `${field}: theirs\n`,
        'config',
      )
      const conflictedValue = parsed<Record<string, unknown>>(conflicted.merged)
      expect(Object.hasOwn(conflictedValue, key)).toBe(true)
      expect(conflictedValue[key]).toBe('ours')
      expect(conflicted.conflicts).toEqual([
        { file: 'config.yaml', path: key, field: '', base: 'base', ours: 'ours', theirs: 'theirs' },
      ])
    },
  )
  it('mcp: both delete same id -> not in merged', () => {
    const r = threeWayMerge(
      '- id: x\n  type: stdio\n  command: c\n  agents: [claude-code]\n',
      '[]',
      '[]',
      'mcp',
    )
    expect(r.merged).not.toContain('id: x')
  })
  it('skills: same url both change ref differently -> conflict on ref', () => {
    const base = 'sources:\n  - url: github:x/y\n    ref: v1\nskills: []\n'
    const ours = 'sources:\n  - url: github:x/y\n    ref: v2\nskills: []\n'
    const theirs = 'sources:\n  - url: github:x/y\n    ref: v3\nskills: []\n'
    const r = threeWayMerge(base, ours, theirs, 'skills')
    expect(r.conflicts.some((c) => c.path.includes('github:x/y') && c.field === 'ref')).toBe(true)
  })
  it('vars: delete and modify conflict, preserving ours as the fallback', () => {
    const base = 'a: 1\nb: 2\n'
    const ours = 'a: 1\n'
    const theirs = 'a: 1\nb: 22\n'
    const r = threeWayMerge(base, ours, theirs, 'vars')
    expect(parsed<Record<string, unknown>>(r.merged)).toEqual({ a: 1 })
    expect(r.conflicts).toEqual([
      { file: 'vars', path: 'b', field: '', base: 2, ours: undefined, theirs: 22 },
    ])
  })

  it.each([
    ['ours deletes, theirs unchanged', '[]', '- id: x\n  command: old\n', [], 0],
    ['ours unchanged, theirs deletes', '- id: x\n  command: old\n', '[]', [], 0],
    ['ours deletes, theirs modifies', '[]', '- id: x\n  command: new\n', [], 1],
    [
      'ours modifies, theirs deletes',
      '- id: x\n  command: new\n',
      '[]',
      [{ id: 'x', command: 'new' }],
      1,
    ],
  ])('%s', (_label, ours, theirs, expected, conflictCount) => {
    const result = threeWayMerge('- id: x\n  command: old\n', ours, theirs, 'mcp')
    expect(parsed(result.merged)).toEqual(expected)
    expect(result.conflicts).toHaveLength(conflictCount)
  })

  it('preserves and three-way merges skills group_order', () => {
    const base = 'sources: []\nskills: []\ngroup_order: [source:a, local]\n'
    const result = threeWayMerge(
      base,
      'sources: []\nskills: []\ngroup_order: [local, source:a]\n',
      base,
      'skills',
    )

    expect(parsed(result.merged)).toEqual({
      group_order: ['local', 'source:a'],
      sources: [],
      skills: [],
    })
    expect(result.conflicts).toEqual([])
  })

  it('reports conflicting group_order changes and preserves ours as the fallback', () => {
    const result = threeWayMerge(
      'sources: []\nskills: []\ngroup_order: [source:a, local]\n',
      'sources: []\nskills: []\ngroup_order: [local, source:a]\n',
      'sources: []\nskills: []\ngroup_order: [source:b, local]\n',
      'skills',
    )

    expect(parsed(result.merged)).toMatchObject({ group_order: ['local', 'source:a'] })
    expect(result.conflicts).toMatchObject([
      { file: 'skills.yaml', path: 'group_order', field: '' },
    ])
  })

  it.each([
    ['mcp', '{}', 'base mcp must be an array'],
    ['vars', '[]', 'base vars must be an object'],
    ['config', 'scalar', 'base config must be an object'],
    ['skills', '[]', 'base skills must be an object'],
    ['skills', 'sources: {}\nskills: []\n', 'base skills.sources must be an array'],
  ] as const)('rejects invalid %s input shapes', (kind, base, message) => {
    expect(() => threeWayMerge(base, base, base, kind)).toThrow(message)
  })

  it.each([
    ['vars', 'base vars must be an object'],
    ['config', 'base config must be an object'],
    ['skills', 'base skills must be an object'],
  ] as const)('rejects YAML timestamp scalars for %s', (kind, message) => {
    expect(() => threeWayMerge('2026-01-01', '2026-01-01', '2026-01-01', kind)).toThrow(message)
  })

  it.each([
    ['mcp', '- null\n', 'base mcp[0] must be an object'],
    ['mcp', '- command: node\n', 'base mcp[0].id must be a non-empty string'],
    ['mcp', '- id: same\n- id: same\n', 'base mcp contains duplicate id: same'],
    [
      'skills',
      'sources:\n  - ref: main\nskills: []\n',
      'base skills.sources[0].url must be a non-empty string',
    ],
    [
      'skills',
      'sources: []\nskills:\n  - id: same\n  - id: same\n',
      'base skills.skills contains duplicate id: same',
    ],
  ] as const)('rejects invalid %s list entries', (kind, base, message) => {
    expect(() => threeWayMerge(base, base, base, kind)).toThrow(message)
  })
})
