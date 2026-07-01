import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { checkUpdates, performUpdate } from '../../src/remote/update'
import type { SkillSource } from '@loom/core'
import type { ScannedMember } from '../../src/projection/scan'

describe('checkUpdates', () => {
  it('hasUpdate when remote tag commit != pinned_commit', async () => {
    const mockGit = { lsRemote: async () => ({ tags: { 'v5.1.4': 'bbb' }, head: 'bbb' }) } as any
    const sources: SkillSource[] = [{ url: 'github:x/y', ref: 'v5.1.4', pinned_commit: 'aaa' }]
    const r = await checkUpdates(sources, mockGit)
    expect(r[0].hasUpdate).toBe(true)
  })
  it('no update when pinned_commit matches latest tag commit', async () => {
    const mockGit = { lsRemote: async () => ({ tags: { 'v5.1.4': 'aaa' }, head: 'aaa' }) } as any
    const r = await checkUpdates(
      [{ url: 'github:x/y', ref: 'v5.1.4', pinned_commit: 'aaa' }],
      mockGit,
    )
    expect(r[0].hasUpdate).toBe(false)
  })
})

describe('performUpdate', () => {
  let bare: string
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'updbare-'))
    await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
    const w = await mkdtemp(join(tmpdir(), 'updw-'))
    const g = simpleGit(w)
    await g.raw(['init', '-b', 'main'])
    await g.addConfig('user.email', 't@t.t')
    await g.addConfig('user.name', 't')
    await mkdir(join(w, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(w, 'skills', 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\n---\nv1\n',
    )
    await g.add('.')
    await g.commit('v1')
    await g.addTag('v1.0.0')
    await rm(join(w, 'skills', 'brainstorming', 'SKILL.md'))
    await mkdir(join(w, 'skills', 'tdd'), { recursive: true })
    await writeFile(join(w, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\n---\nv2\n')
    await g.add('.')
    await g.commit('v2')
    await g.addTag('v2.0.0')
    await g.addRemote('origin', bare)
    await g.push('origin', 'HEAD:main')
    await g.pushTags('origin')
  })

  it('fetch + checkout new ref + detect orphan members', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'updrepo-'))
    const git = new NodeGit(),
      fs = new NodeFileSystem()
    await git.clone(bare, join(repoPath, 'remote-cache', 'superpowers'), false)
    await git.checkout(join(repoPath, 'remote-cache', 'superpowers'), 'v1.0.0')
    const oldMembers: ScannedMember[] = [
      {
        name: 'brainstorming',
        path: join(repoPath, 'remote-cache', 'superpowers', 'skills', 'brainstorming'),
      },
    ]
    const res = await performUpdate(
      git,
      fs,
      { url: bare, ref: 'v1.0.0', pinned_commit: 'old' },
      'v2.0.0',
      repoPath,
      'superpowers',
      oldMembers,
    )
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(res.orphans.map((o) => o.name)).toEqual(['brainstorming'])
    await rm(repoPath, { recursive: true, force: true })
  })
})
