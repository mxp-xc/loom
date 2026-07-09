import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { installSkill } from '../../src/remote/install'
import { createBareRepo } from '../helpers/git'

describe.concurrent('installSkill', () => {
  let bare: string
  beforeAll(async () => {
    bare = await createBareRepo([
      {
        message: 'init',
        files: { 'skills/brainstorming/SKILL.md': '---\nname: brainstorming\n---\n' },
        tags: ['v1.0.0'],
      },
    ])
  })
  afterAll(async () => {
    await rm(bare, { recursive: true, force: true })
  })

  it('clones + checks out ref + returns pinned_commit (HEAD hash)', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'instrepo-'))
    const res = await installSkill(
      new NodeGit(),
      new NodeFileSystem(),
      bare,
      'v1.0.0',
      repoPath,
      'superpowers',
    )
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(res.cacheDir).toBe(join(repoPath, 'remote-cache', 'superpowers'))
    await rm(repoPath, { recursive: true, force: true })
  })
  it('failure (bad ref) cleans up remote-cache half-product', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'instrepo2-'))
    const fs = new NodeFileSystem()
    await expect(
      installSkill(new NodeGit(), fs, bare, 'nonexistent-ref', repoPath, 'superpowers'),
    ).rejects.toThrow()
    expect(await fs.exists(join(repoPath, 'remote-cache', 'superpowers'))).toBe(false)
    await rm(repoPath, { recursive: true, force: true })
  })
})
