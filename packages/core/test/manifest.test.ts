import { describe, it, expect } from 'vitest'
import { loadRepoManifest, validateManifest, mergeConfig, buildManifest } from '../src/manifest'
import type { RepoManifest, Config } from '../src/types'

const files = {
  'skills.yaml':
    'sources:\n  - url: github:obra/superpowers\n    ref: v5.1.4\nskills:\n  - id: frontend-design\n',
  'mcp.yaml':
    '- id: playwright\n  type: stdio\n  command: npx\n  args: ["p"]\n  targets: [claude-code]\n',
  'vars/default.yaml': 'browsers_path: ~/.cache/ms-playwright\n',
  'config.yaml': 'profile: local\ntargets: [claude-code, codex]\nprojection:\n  strategy: link\n',
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
    expect(m.repoConfig.targets).toEqual(['claude-code', 'codex'])
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
})

describe('validateManifest (zod discriminatedUnion)', () => {
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
  it('accepts mcp without targets', () => {
    const m = loadRepoManifest({
      'mcp.yaml': '- id: x\n  type: stdio\n  command: c\n',
      'skills.yaml': 'sources: []\nskills: []\n',
    })
    expect(validateManifest(m)).toHaveLength(0)
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
  it('flags duplicate source urls', () => {
    const m = loadRepoManifest({
      'skills.yaml':
        'sources:\n  - name: first\n    url: github:a/shared\n    ref: main\n  - name: second\n    url: github:a/shared\n    ref: main\nskills: []\n',
      'mcp.yaml': '[]\n',
    })
    expect(
      validateManifest(m).some((e) => e.includes('duplicate source url: github:a/shared')),
    ).toBe(true)
  })
})

describe('mergeConfig (two-level, deep merge)', () => {
  it('local overrides repo top-level field', () => {
    expect(mergeConfig({ profile: 'a', targets: ['claude-code'] }, { profile: 'b' }).profile).toBe(
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
    expect(mergeConfig({ targets: ['claude-code'] }, { targets: ['codex'] }).targets).toEqual([
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
      repoConfig: { profile: 'local', targets: ['claude-code'] },
      memoriesFiles: {},
    }
    const m = buildManifest(repo, { targets: ['codex'] })
    expect(m.config.targets).toEqual(['codex'])
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
