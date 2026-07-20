import { describe, it, expect } from 'vitest'
import { loadRepoManifest, validateManifest, mergeConfig, buildManifest } from '../src/manifest'
import type { RepoManifest, Config } from '../src/types'

const files = {
  'skills.yaml':
    'sources:\n  - url: github:obra/superpowers\n    ref: v5.1.4\nskills:\n  - id: frontend-design\n',
  'mcp.yaml':
    '- id: playwright\n  type: stdio\n  command: npx\n  args: ["p"]\n  agents: [claude-code]\n',
  'vars/default.yaml': 'browsers_path: ~/.cache/ms-playwright\n',
  'config.yaml': 'profile: local\nagents: [claude-code, codex]\nprojection:\n  strategy: link\n',
}

describe('loadRepoManifest', () => {
  it('parses skills/mcp/vars/config from file map', () => {
    const m = loadRepoManifest(files)
    expect(m.skills.sources[0].url).toBe('github:obra/superpowers')
    expect(m.mcp[0].id).toBe('playwright')
    expect(m.varsFiles.default).toEqual({
      format: 'legacy',
      entries: { browsers_path: { type: 'string', value: '~/.cache/ms-playwright' } },
    })
    expect(m.repoConfig.agents).toEqual(['claude-code', 'codex'])
  })
})

describe('loadRepoManifest safeParse', () => {
  it('does not throw on malformed source (missing ref)', () => {
    const files = {
      'skills.yaml': 'sources:\n  - url: https://github.com/test/repo\n',
    }
    const result = loadRepoManifest(files)
    expect(result.skills.sources).toHaveLength(1)
    expect(result.skills.sources[0].url).toBe('https://github.com/test/repo')
    // should not throw — error collected in validateManifest
  })

  it.each([
    ['empty skills', { 'skills.yaml': '' }, 'skills.yaml', 'manifest_container_invalid'],
    ['scalar skills', { 'skills.yaml': 'invalid\n' }, 'skills.yaml', 'manifest_container_invalid'],
    ['list skills', { 'skills.yaml': '[]\n' }, 'skills.yaml', 'manifest_container_invalid'],
    ['object mcp', { 'mcp.yaml': 'servers: []\n' }, 'mcp.yaml', 'manifest_container_invalid'],
    ['scalar config', { 'config.yaml': 'invalid\n' }, 'config.yaml', 'manifest_container_invalid'],
    ['null config', { 'config.yaml': 'null\n' }, 'config.yaml', 'manifest_container_invalid'],
  ])('uses safe fallbacks and diagnostics for %s', (_label, input, file, code) => {
    const result = loadRepoManifest(input)
    expect(result.skills).toEqual({ sources: [], skills: [] })
    expect(result.mcp).toEqual([])
    expect(result.repoConfig).toEqual({})
    expect(result.loadDiagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ file, code })]),
    )
    expect(() => buildManifest(result, {})).not.toThrow()
    expect(buildManifest(result, {}).errors).toEqual(
      expect.arrayContaining([expect.stringContaining(file)]),
    )
  })

  it('reports malformed fields and filters non-object items without hiding object field errors', () => {
    const result = loadRepoManifest({
      'skills.yaml': [
        'sources: wrong',
        'skills:',
        '  - null',
        '  - invalid',
        '  - id: valid-shape',
        '    unknown: true',
        'group_order: wrong',
      ].join('\n'),
      'mcp.yaml': ['- null', '- invalid', '- id: missing-transport'].join('\n'),
    })

    expect(result.skills.sources).toEqual([])
    expect(result.skills.skills).toEqual([{ id: 'valid-shape', unknown: true }])
    expect(result.mcp).toEqual([{ id: 'missing-transport' }])
    expect(result.loadDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'manifest_field_invalid', path: 'sources' }),
        expect.objectContaining({ code: 'manifest_item_invalid', path: 'skills[0]' }),
        expect.objectContaining({ code: 'manifest_item_invalid', path: 'skills[1]' }),
        expect.objectContaining({ code: 'manifest_field_invalid', path: 'group_order' }),
        expect.objectContaining({ code: 'manifest_item_invalid', file: 'mcp.yaml', path: '[0]' }),
        expect.objectContaining({ code: 'manifest_item_invalid', file: 'mcp.yaml', path: '[1]' }),
      ]),
    )
    const errors = validateManifest(result)
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/skills\.skills\[2\]\.\:.*unknown/)]),
    )
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('mcp[2]')]))
  })

  it('accepts an empty config document and preserves forward-compatible own fields', () => {
    expect(loadRepoManifest({ 'config.yaml': '' }).loadDiagnostics).toEqual([])
    const result = loadRepoManifest({
      'config.yaml': ['future:', '  enabled: true', '"__proto__":', '  safe: true'].join('\n'),
    })
    const config = result.repoConfig as Config & Record<string, unknown>
    expect(Object.getPrototypeOf(config)).toBeNull()
    expect(config.future).toEqual({ enabled: true })
    expect(Object.hasOwn(config, '__proto__')).toBe(true)
    expect(config.__proto__).toEqual({ safe: true })
    expect((Object.prototype as Record<string, unknown>).safe).toBeUndefined()
  })

  it('uses prototype-safe dictionaries for vars and memory filenames', () => {
    const result = loadRepoManifest({
      'config.yaml': 'profile: __proto__\nactive_memory: __proto__\n',
      'vars/__proto__.yaml': 'VALUE: safe\n',
      'memories/__proto__.md': '# safe',
    })
    expect(Object.getPrototypeOf(result.varsFiles)).toBeNull()
    expect(Object.getPrototypeOf(result.memoriesFiles)).toBeNull()
    expect(Object.hasOwn(result.varsFiles, '__proto__')).toBe(true)
    expect(Object.hasOwn(result.memoriesFiles, '__proto__')).toBe(true)
    const manifest = buildManifest(result, {})
    expect(manifest.vars.active).toEqual({ VALUE: 'safe' })
    expect(manifest.memory.active).toMatchObject({ name: '__proto__', content: '# safe' })
  })
})

describe('validateManifest (zod discriminatedUnion)', () => {
  it.each(['nested/skill', '../skill', '.', 'BadSkill', 'bad_skill', 'bad skill'])(
    'rejects invalid local skill id %s',
    (id) => {
      const manifest = loadRepoManifest({
        'skills.yaml': `sources: []\nskills:\n  - id: ${JSON.stringify(id)}\n`,
        'mcp.yaml': '[]\n',
      })

      expect(validateManifest(manifest)).toEqual([expect.stringContaining('skills.skills[0].id')])
    },
  )

  it('rejects duplicate local skill identities', () => {
    const manifest = loadRepoManifest({
      'skills.yaml': 'sources: []\nskills:\n  - id: shared\n  - id: shared\n',
      'mcp.yaml': '[]\n',
    })

    expect(validateManifest(manifest)).toEqual([
      expect.stringContaining('duplicate local skill id: shared'),
    ])
  })

  it('flags mcp stdio missing command', () => {
    const m = loadRepoManifest({
      'mcp.yaml': '- id: x\n  type: stdio\n',
      'skills.yaml': 'sources: []\nskills: []\n',
    })
    expect(validateManifest(m).some((e) => e.includes('mcp[0]') && e.includes('command'))).toBe(
      true,
    )
  })
  it('flags mcp sse missing url', () => {
    const m = loadRepoManifest({
      'mcp.yaml': '- id: x\n  type: sse\n',
      'skills.yaml': 'sources: []\nskills: []\n',
    })
    expect(validateManifest(m).some((e) => e.includes('url'))).toBe(true)
  })
  it('accepts mcp without agents', () => {
    const m = loadRepoManifest({
      'mcp.yaml': '- id: x\n  type: stdio\n  command: c\n',
      'skills.yaml': 'sources: []\nskills: []\n',
    })
    expect(validateManifest(m)).toHaveLength(0)
  })
  it('rejects unknown fields in mcp definitions', () => {
    const m = loadRepoManifest({
      'mcp.yaml': '- id: x\n  type: stdio\n  command: c\n  agentz: [codex]\n',
      'skills.yaml': 'sources: []\nskills: []\n',
    })
    expect(validateManifest(m)).toEqual([
      expect.stringContaining("mcp[0].: Unrecognized key(s) in object: 'agentz'"),
    ])
  })
  it('rejects unknown agents in local skills', () => {
    const m = loadRepoManifest({
      'mcp.yaml': '[]\n',
      'skills.yaml': 'sources: []\nskills:\n  - id: local\n    agents: [hermes]\n',
    })
    expect(validateManifest(m)).toEqual([expect.stringContaining('skills.skills[0].agents.0')])
  })
  it('flags source missing ref', () => {
    const m = loadRepoManifest({
      'skills.yaml': 'sources:\n  - url: github:x/y\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(m).some((e) => e.includes('source[0]') && e.includes('ref'))).toBe(true)
  })
  it('flags source missing url', () => {
    const m = loadRepoManifest({
      'skills.yaml': 'sources:\n  - ref: v1\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(m).some((e) => e.includes('source[0]') && e.includes('url'))).toBe(true)
  })
  it('flags source name with unsafe path characters', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - name: bad/name\n    url: github:x/y\n    ref: main\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(m).some((e) => e.includes('source[0].name'))).toBe(true)
  })
  it('flags duplicate source names using derived names for legacy sources', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:a/shared\n    ref: main\n  - name: shared\n    url: github:b/other\n    ref: main\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(m).some((e) => e.includes('duplicate source name: shared'))).toBe(true)
  })
  it('reports a legacy source URL without a repository name instead of throwing', () => {
    const manifest = loadRepoManifest({
      'skills.yaml': 'sources:\n  - url: https://github.com/\n    ref: main\nskills: []\n',
      'mcp.yaml': '[]\n',
    })

    expect(() => validateManifest(manifest)).not.toThrow()
    expect(validateManifest(manifest)).toEqual(['source[0].url: invalid repository URL'])
    expect(() => buildManifest(manifest, {})).not.toThrow()
    expect(buildManifest(manifest, {}).errors).toEqual(['source[0].url: invalid repository URL'])
  })
  it('flags duplicate source urls', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - name: first\n    url: github:a/shared\n    ref: main\n  - name: second\n    url: github:a/shared\n    ref: main\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(m)).toEqual(
      expect.arrayContaining(['source[1].url: duplicate source URL already used by source[0]']),
    )
  })
  it('does not expose source URL credentials in manifest errors', () => {
    const secret = 'manifest-secret-7e27'
    const url = `https://user:${secret}@example.test/`
    const manifest = loadRepoManifest({
      'skills.yaml': [
        'sources:',
        `  - url: ${url}`,
        '    ref: main',
        `  - url: ${url}`,
        '    ref: main',
        'skills: []',
      ].join('\n'),
      'mcp.yaml': '[]\n',
    })

    const errors = buildManifest(manifest, {}).errors
    expect(errors).toEqual(
      expect.arrayContaining([
        'source[0].url: invalid repository URL',
        'source[1].url: duplicate source URL already used by source[0]',
        'source[1].url: invalid repository URL',
      ]),
    )
    expect(errors.join('\n')).not.toContain(secret)
    expect(errors.join('\n')).not.toContain(url)
  })

  it('keeps original indexes after filtering invalid list items', () => {
    const manifest = loadRepoManifest({
      'skills.yaml': [
        'sources:',
        '  - null',
        '  - ref: main',
        'skills:',
        '  - null',
        '  - id: BadSkill',
      ].join('\n'),
      'mcp.yaml': ['- null', '- id: missing-transport'].join('\n'),
    })

    expect(validateManifest(manifest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('source[1].url'),
        expect.stringContaining('skills.skills[1].id'),
        expect.stringContaining('mcp[1].type'),
      ]),
    )
  })
  it('rejects the removed source scan field instead of silently stripping it', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:x/y\n    ref: main\n    scan: "skills/**/SKILL.md"\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(m).some((e) => e.includes('source[0]') && e.includes('scan'))).toBe(
      true,
    )
  })
  it('rejects removed member fields and requires canonical entry identity', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:x/y\n    ref: main\n    members:\n      - name: skill-a\n        enabled: true\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    const errors = validateManifest(m)
    expect(errors.some((e) => e.includes('entry'))).toBe(true)
    expect(errors.some((e) => e.includes('enabled'))).toBe(true)
  })
  it('rejects duplicate member names and entries independently', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:x/y\n    ref: main\n    members:\n      - name: skill-a\n        entry: a/SKILL.md\n      - name: skill-a\n        entry: b/SKILL.md\n      - name: skill-c\n        entry: a/SKILL.md\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    const errors = validateManifest(m)
    expect(errors.some((e) => e.includes('duplicate member name: skill-a'))).toBe(true)
    expect(errors.some((e) => e.includes('duplicate member entry: a/SKILL.md'))).toBe(true)
  })
  it('validates resource paths and kinds', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:x/y\n    ref: main\n    resources:\n      include:\n        - path: ../outside\n          kind: directory\n      exclude:\n        - path: shared/file.md\n          kind: blob\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    const errors = validateManifest(m)
    expect(errors.some((e) => e.includes('resources.include.0.path'))).toBe(true)
    expect(errors.some((e) => e.includes('resources.exclude.0.kind'))).toBe(true)
  })
  it('rejects non-normalized source paths', () => {
    for (const path of ['shared/', 'shared//prompt.md', './shared/prompt.md']) {
      const manifest = loadRepoManifest({
        'skills.yaml': `sources:\n  - url: github:x/y\n    ref: main\n    resources:\n      include:\n        - path: ${path}\n          kind: directory\n      exclude: []\nskills: []\n`,
        'mcp.yaml': '[]\n',
      })
      expect(validateManifest(manifest)).toEqual(
        expect.arrayContaining([expect.stringContaining('path must be normalized')]),
      )
    }
  })
  it('rejects conflicting, redundant, or unstably ordered resource rules', () => {
    const conflicting = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:x/y\n    ref: main\n    resources:\n      include:\n        - path: shared\n          kind: directory\n      exclude:\n        - path: shared\n          kind: directory\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(conflicting)).toEqual(
      expect.arrayContaining([expect.stringContaining('resource path conflicts')]),
    )

    const nonCanonical = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - url: github:x/y\n    ref: main\n    resources:\n      include:\n        - path: z.md\n          kind: file\n        - path: shared\n          kind: directory\n        - path: shared/prompt.md\n          kind: file\n      exclude: []\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(validateManifest(nonCanonical)).toEqual(
      expect.arrayContaining([expect.stringContaining('normalized and stably sorted')]),
    )
  })
})

describe('mergeConfig (two-level, deep merge)', () => {
  it('local overrides repo top-level field', () => {
    expect(mergeConfig({ profile: 'a', agents: ['claude-code'] }, { profile: 'b' }).profile).toBe(
      'b',
    )
  })
  it('local deep-merges nested object, keeps repo sibling fields (snake_case)', () => {
    const r = mergeConfig(
      { proxy: { http: 'r', https: 'r', no_proxy: 'n' } },
      { proxy: { http: 'L' } },
    )
    expect(r.proxy).toEqual({ http: 'L', https: 'r', no_proxy: 'n' })
  })
  it('array is replaced wholesale, not element-merged', () => {
    expect(mergeConfig({ agents: ['claude-code'] }, { agents: ['codex'] }).agents).toEqual([
      'codex',
    ])
  })
  it('local omits a key => inherits repo', () => {
    expect(mergeConfig({ active_repo: 'r', profile: 'r' }, { active_repo: 'L' }).profile).toBe('r')
  })
  it('local explicit null overrides as null (null is explicit value, not fallback)', () => {
    expect(
      mergeConfig({ profile: 'repo' }, { profile: null as unknown as string } as Config).profile,
    ).toBe(null)
  })

  it('keeps own __proto__ fields without changing merged object prototypes', () => {
    const repo = Object.create(null) as Config & Record<string, unknown>
    repo.proxy = { http: 'repo', https: 'repo' }
    repo.__proto__ = { repo: true }
    const local = Object.create(null) as Config & Record<string, unknown>
    local.proxy = { http: 'local' }
    local.__proto__ = { local: true }

    const result = mergeConfig(repo, local) as Config & Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(Object.getPrototypeOf(result.proxy)).toBeNull()
    expect(result.proxy).toEqual({ http: 'local', https: 'repo' })
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result.__proto__).toEqual({ repo: true, local: true })
    expect((Object.prototype as Record<string, unknown>).repo).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).local).toBeUndefined()
  })
})

describe('buildManifest (RepoManifest -> Manifest)', () => {
  it('effective config = mergeConfig(repo, local); active profile from config.profile', () => {
    const repo: RepoManifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      varsFiles: {
        default: { format: 'legacy', entries: { a: { type: 'string', value: 'd' } } },
        local: {
          format: 'typed',
          entries: {
            a: { type: 'number', value: 2 },
            b: { type: 'boolean', value: true },
            c: { type: 'json', value: { nested: 'x' } },
          },
        },
      },
      repoConfig: { profile: 'local', agents: ['claude-code'] },
      memoriesFiles: {},
    }
    const m = buildManifest(repo, { agents: ['codex'] })
    expect(m.config.agents).toEqual(['codex'])
    expect(m.config.profile).toBe('local')
    expect(m.vars.default).toEqual({ a: 'd' })
    expect(m.vars.active).toEqual({ a: '2', b: 'true', c: '{"nested":"x"}' })
  })
  it('profile default falls back to default vars', () => {
    const repo: RepoManifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      varsFiles: {
        default: { format: 'legacy', entries: { a: { type: 'string', value: 'd' } } },
      },
      repoConfig: {},
      memoriesFiles: {},
    }
    const m = buildManifest(repo, {})
    expect(m.vars.active).toEqual({ a: 'd' })
  })
})
