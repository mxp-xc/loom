import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { installSkill } from '../../src/remote/install'

describe('installSkill', () => {
  let bare: string
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'instbare-'))
    await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
    const w = await mkdtemp(join(tmpdir(), 'instw-'))
    const g = simpleGit(w); await g.raw(['init', '-b', 'main'])
    await g.addConfig('user.email', 't@t.t'); await g.addConfig('user.name', 't')
    await mkdir(join(w, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(join(w, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\n---\n')
    await g.add('.'); await g.commit('init'); await g.addTag('v1.0.0')
    await g.addRemote('origin', bare); await g.push('origin', 'HEAD:main'); await g.pushTags('origin')
  })

  it('clones + checks out ref + returns pinned_commit (HEAD hash)', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'instrepo-'))
    const res = await installSkill(new NodeGit(), new NodeFileSystem(), bare, 'v1.0.0', repoPath, 'superpowers')
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(res.cacheDir).toBe(join(repoPath, 'remote-cache', 'superpowers'))
    await rm(repoPath, { recursive: true, force: true })
  })
  it('failure (bad ref) cleans up remote-cache half-product', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'instrepo2-'))
    const fs = new NodeFileSystem()
    await expect(installSkill(new NodeGit(), fs, bare, 'nonexistent-ref', repoPath, 'superpowers')).rejects.toThrow()
    expect(await fs.exists(join(repoPath, 'remote-cache', 'superpowers'))).toBe(false)
    await rm(repoPath, { recursive: true, force: true })
  })
})
