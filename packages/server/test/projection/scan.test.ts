import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSourceMembers, resolveFullLinks } from '../../src/projection/scan'
import { NodeFileSystem } from '../../src/platform/node/fs'
import type { Manifest } from '@loom/core'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scan-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scanSourceMembers', () => {
  it('finds SKILL.md, member name = parent dir, excludes .git/node_modules/.cache', async () => {
    await mkdir(join(root, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'skills', 'brainstorming', 'SKILL.md'), 'x')
    await mkdir(join(root, '.git', 'foo'), { recursive: true })
    await writeFile(join(root, '.git', 'foo', 'SKILL.md'), 'x')
    await mkdir(join(root, 'node_modules', 'bar'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'bar', 'SKILL.md'), 'x')
    const members = await scanSourceMembers(new NodeFileSystem(), root, {
      url: 'github:obra/superpowers',
      ref: 'v1',
    })
    expect(members.map((m) => m.name)).toEqual(['brainstorming'])
    expect(members[0].path).toBe(join(root, 'skills', 'brainstorming'))
  })
})

describe('resolveFullLinks', () => {
  const mk = (sources: any[]): Manifest => ({
    skills: { sources, skills: [{ id: 'frontend-design' }] },
    mcp: [],
    memory: { memories: [], active: null, activeContent: '' },
    vars: { default: {}, active: {} },
    config: { targets: ['claude-code', 'codex'], skill_naming: 'hyphen' },
    errors: [],
  })
  it('source no members: scanned members default to no targets', () => {
    const manifest = mk([{ url: 'github:obra/superpowers', ref: 'v1' }])
    const scan = new Map([
      [
        'github:obra/superpowers',
        [
          { name: 'brainstorming', path: '/p' },
          { name: 'tdd', path: '/p2' },
        ],
      ],
    ])
    const p = resolveFullLinks(manifest, scan, manifest.config, new Set(['claude-code', 'codex']))
    expect(p.links.find((l) => l.skillId === 'superpowers-brainstorming')!.targets).toEqual([])
    expect(p.links.find((l) => l.skillId === 'superpowers-tdd')!.targets).toEqual([])
  })
  it('source with members override: disabled and unlisted members both have no targets', () => {
    const manifest = mk([
      { url: 'github:obra/superpowers', ref: 'v1', members: [{ name: 'tdd', enabled: false }] },
    ])
    const scan = new Map([
      [
        'github:obra/superpowers',
        [
          { name: 'brainstorming', path: '/p' },
          { name: 'tdd', path: '/p2' },
        ],
      ],
    ])
    const p = resolveFullLinks(manifest, scan, manifest.config, new Set(['claude-code', 'codex']))
    expect(p.links.find((l) => l.skillId === 'superpowers-tdd')!.targets).toEqual([])
    expect(p.links.find((l) => l.skillId === 'superpowers-brainstorming')!.targets).toEqual([])
  })
  it('local skill still projected', () => {
    const manifest = mk([{ url: 'github:obra/superpowers', ref: 'v1' }])
    const scan = new Map()
    const p = resolveFullLinks(manifest, scan, manifest.config, new Set(['claude-code', 'codex']))
    expect(p.links.some((l) => l.skillId === 'frontend-design')).toBe(true)
  })
  it('uninstalled agent goes to skippedAgents and filtered from link targets', () => {
    const manifest = mk([
      {
        url: 'github:obra/superpowers',
        ref: 'v1',
        members: [{ name: 'brainstorming', targets: ['claude-code', 'opencode'] }],
      },
    ])
    const scan = new Map([['github:obra/superpowers', [{ name: 'brainstorming', path: '/p' }]]])
    const p = resolveFullLinks(
      manifest,
      scan,
      { targets: ['claude-code', 'opencode'], skill_naming: 'hyphen' } as any,
      new Set(['claude-code']),
    )
    expect(p.skippedAgents).toContain('opencode')
    expect(p.links.find((l) => l.skillId === 'superpowers-brainstorming')!.targets).toEqual([
      'claude-code',
    ])
  })
})
