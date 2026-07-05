import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { resolveRepoPath, listRepos } from '../../src/api/repo.js'

describe('repo resolution', () => {
  let home: string
  let fs: NodeFileSystem

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-repo-'))
    fs = new NodeFileSystem()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists actual subdirectories under ~/.loom/repos', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    mkdirSync(join(home, '.loom', 'repos', 'work'), { recursive: true })
    const repos = await listRepos(fs, home)
    expect(repos.sort()).toEqual(['default', 'work'])
  })

  it('resolves valid repo name to path', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    const p = await resolveRepoPath(fs, 'default', home)
    expect(p).toBe(join(home, '.loom', 'repos', 'default'))
  })

  it('rejects unknown repo (path traversal safe)', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    await expect(resolveRepoPath(fs, '../etc', home)).rejects.toThrow(/invalid repo/)
    await expect(resolveRepoPath(fs, 'nonexistent', home)).rejects.toThrow(/invalid repo/)
  })
})
