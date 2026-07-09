import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { checkUpdates, performUpdate } from '../../src/remote/update'
import type { SkillSource } from '@loom/core'
import type { ScannedMember } from '../../src/projection/scan'
import { createBareRepo } from '../helpers/git'

describe.concurrent('checkUpdates', () => {
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

describe.concurrent('performUpdate', () => {
  let bare: string
  beforeAll(async () => {
    bare = await createBareRepo([
      {
        message: 'v1',
        files: { 'skills/brainstorming/SKILL.md': '---\nname: brainstorming\n---\nv1\n' },
        tags: ['v1.0.0'],
      },
      {
        message: 'v2',
        files: {
          'skills/brainstorming/SKILL.md': null,
          'skills/tdd/SKILL.md': '---\nname: tdd\n---\nv2\n',
        },
        tags: ['v2.0.0'],
      },
    ])
  })
  afterAll(async () => {
    await rm(bare, { recursive: true, force: true })
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
