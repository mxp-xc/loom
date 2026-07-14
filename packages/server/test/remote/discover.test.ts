import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from '../../src/remote/discover'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { formatSourceMemberSkillId } from '@loom/core'
import type { IGit } from '../../src/ports/git'

let srcTmp: string
beforeEach(async () => {
  srcTmp = await mkdtemp(join(tmpdir(), 'discsrc-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(srcTmp, { recursive: true, force: true }).catch(() => {})
})

describe('discoverSkills', () => {
  const cloneLocalSource = {
    clone: async (_u: string, dest: string) => {
      await cp(srcTmp, dest, { recursive: true })
    },
    checkout: vi.fn(async () => {}),
  } as unknown as IGit

  it.each(['https://gitlab.example.com/owner/skills.git', 'git@gitcode.com:owner/skills.git'])(
    'passes the configured Git URL through unchanged: %s',
    async (url) => {
      const clone = vi.fn(async (_url: string, dest: string) => {
        await cp(srcTmp, dest, { recursive: true })
      })
      const git = { clone, checkout: vi.fn(async () => {}) } as unknown as IGit

      await discoverSkills(git, new NodeFileSystem(), { url, ref: 'main' })

      expect(clone).toHaveBeenCalledWith(url, expect.any(String), false)
    },
  )

  it('returns SKILL.md members from any directory using the parent directory name', async () => {
    await mkdir(join(srcTmp, 'skills', 'engineering', 'foo'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'engineering', 'foo', 'SKILL.md'),
      '---\nname: foo\ndescription: A skill\n---\nbody\n',
    )

    const members = await discoverSkills(cloneLocalSource, new NodeFileSystem(), {
      url: 'github:obra/superpowers',
      ref: 'v1.0.1',
    } as any)

    expect(members.map((m) => m.name)).toEqual(['foo'])
    expect(members[0].description).toBe('A skill')
    expect(members[0].path).toBe('skills/engineering/foo/SKILL.md')
  })

  it('uses custom scan patterns to restrict discovered members', async () => {
    await mkdir(join(srcTmp, 'packages', 'foo'), { recursive: true })
    await writeFile(
      join(srcTmp, 'packages', 'foo', 'SKILL.md'),
      '---\nname: foo\ndescription: A skill\n---\nbody\n',
    )
    await mkdir(join(srcTmp, 'skills', 'bar'), { recursive: true })
    await writeFile(join(srcTmp, 'skills', 'bar', 'SKILL.md'), '---\nname: bar\n---\nbody\n')

    const members = await discoverSkills(cloneLocalSource, new NodeFileSystem(), {
      url: 'github:obra/superpowers',
      ref: 'main',
      scan: 'packages/**/SKILL.md',
    } as any)

    expect(members.map((m) => m.name)).toEqual(['foo'])
  })

  it('filters invalid path member names', async () => {
    await mkdir(join(srcTmp, 'skills', 'BadName'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'BadName', 'SKILL.md'),
      '---\nname: BadName\ndescription: x\n---\n',
    )

    const members = await discoverSkills(
      cloneLocalSource,
      new NodeFileSystem(),
      'github:obra/superpowers',
    )

    expect(members).toEqual([])
  })

  it('uses the path member name when frontmatter name differs', async () => {
    await mkdir(join(srcTmp, 'skills', 'foo'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'foo', 'SKILL.md'),
      '---\nname: bar\ndescription: A skill\n---\nbody\n',
    )
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const members = await discoverSkills(
      cloneLocalSource,
      new NodeFileSystem(),
      'github:obra/superpowers',
    )

    expect(members.map((m) => m.name)).toEqual(['foo'])
    expect(members[0].description).toBe('A skill')
    const output = write.mock.calls.map(([value]) => String(value)).join('')
    expect(output).toContain('source skill frontmatter name differs from path member name')
    expect(output).toContain('path=skills/foo/SKILL.md')
    expect(output).toContain('frontmatterName=bar')
    expect(output).toContain('memberName=foo')
  })

  it('checks out the requested ref before scanning', async () => {
    const checkout = vi.fn(async () => {})
    const git = {
      clone: async (_u: string, dest: string) => {
        await cp(srcTmp, dest, { recursive: true })
      },
      checkout,
    } as unknown as IGit
    await mkdir(join(srcTmp, 'skills', 'foo'), { recursive: true })
    await writeFile(join(srcTmp, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n')

    await discoverSkills(git, new NodeFileSystem(), {
      url: 'github:obra/superpowers',
      ref: 'v1.0.1',
      type: 'tag',
    } as any)

    expect(checkout).toHaveBeenCalledWith(expect.any(String), 'v1.0.1')
  })

  it('marks mismatched frontmatter members installed by the returned path member name', async () => {
    await mkdir(join(srcTmp, 'skills', 'foo'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'foo', 'SKILL.md'),
      '---\nname: bar\ndescription: A skill\n---\nbody\n',
    )
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const members = await discoverSkills(
      cloneLocalSource,
      new NodeFileSystem(),
      'github:obra/superpowers',
      new Set([formatSourceMemberSkillId('github:obra/superpowers', 'foo', 'hyphen')]),
    )

    expect(members.map((m) => ({ name: m.name, installed: m.installed }))).toEqual([
      { name: 'foo', installed: true },
    ])
  })

  it('marks supported members as installed', async () => {
    await mkdir(join(srcTmp, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\ndescription: A skill\n---\nbody\n',
    )

    const members = await discoverSkills(
      cloneLocalSource,
      new NodeFileSystem(),
      'github:obra/superpowers',
      new Set([formatSourceMemberSkillId('github:obra/superpowers', 'brainstorming', 'hyphen')]),
    )

    expect(members.map((m) => ({ name: m.name, installed: m.installed }))).toEqual([
      { name: 'brainstorming', installed: true },
    ])
  })
})
