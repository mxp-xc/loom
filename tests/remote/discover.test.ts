import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from '../../src/remote/discover'
import { resolveGitUrl } from '../../src/remote/resolve-url'
import { NodeFileSystem } from '../../src/platform/node/fs'
import type { IGit } from '../../src/platform/interfaces'

let srcTmp: string
beforeAll(async () => { srcTmp = await mkdtemp(join(tmpdir(), 'discsrc-')) })
afterAll(async () => { await rm(srcTmp, { recursive: true, force: true }).catch(() => {}) })

describe('resolveGitUrl', () => {
  it('github:owner/repo -> https URL', () => {
    expect(resolveGitUrl('github:obra/superpowers')).toBe('https://github.com/obra/superpowers.git')
  })
  it('gitee:owner/repo -> https URL', () => {
    expect(resolveGitUrl('gitee:obra/superpowers')).toBe('https://gitee.com/obra/superpowers.git')
  })
  it('bare URL passthrough', () => {
    expect(resolveGitUrl('/tmp/bare-repo')).toBe('/tmp/bare-repo')
    expect(resolveGitUrl('https://github.com/x/y.git')).toBe('https://github.com/x/y.git')
  })
})

describe('discoverSkills', () => {
  it('shallow clone + scan + parse frontmatter, filter invalid name, mark installed', async () => {
    await mkdir(join(srcTmp, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(join(srcTmp, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: A skill\n---\nbody\n')
    await mkdir(join(srcTmp, 'skills', 'bad-name'), { recursive: true })
    await writeFile(join(srcTmp, 'skills', 'bad-name', 'SKILL.md'), '---\nname: BadName\ndescription: x\n---\n')
    const mockGit = { clone: async (_u: string, dest: string) => { await cp(srcTmp, dest, { recursive: true }) } } as unknown as IGit
    const members = await discoverSkills(mockGit, new NodeFileSystem(), 'github:obra/superpowers', new Set(['superpowers-brainstorming']))
    expect(members.map(m => m.name)).toEqual(['brainstorming'])
    expect(members[0].description).toBe('A skill')
    expect(members[0].installed).toBe(true)
  })
})
