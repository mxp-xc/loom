import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import {
  authorizeRepository,
  listRepos,
  resolveRepoPath,
  revalidateRepositoryAuthorization,
} from '../../src/api/repo.js'

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

  it('excludes files, unsafe names, and directory links from repository discovery', async () => {
    const reposDir = join(home, '.loom', 'repos')
    const outside = join(home, 'outside')
    mkdirSync(join(reposDir, 'default'), { recursive: true })
    mkdirSync(join(reposDir, '.hidden'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(reposDir, 'not-a-repo'), 'data')
    symlinkSync(
      outside,
      join(reposDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    expect(await listRepos(fs, home)).toEqual(['default'])
  })

  it('resolves valid repo name to path', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    const p = await resolveRepoPath(fs, 'default', home)
    expect(p).toBe(realpathSync(join(home, '.loom', 'repos', 'default')))
  })

  it('rejects a repository whose physical identity changes after authorization', async () => {
    const repository = join(home, '.loom', 'repos', 'default')
    mkdirSync(repository, { recursive: true })
    const authorization = await authorizeRepository(fs, 'default', home)
    rmSync(repository, { recursive: true })
    mkdirSync(repository)

    await expect(revalidateRepositoryAuthorization(fs, home, authorization)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
    })
  })

  it('rejects a repository entry that is a link outside the managed root', async () => {
    const reposDir = join(home, '.loom', 'repos')
    const outside = join(home, 'outside')
    mkdirSync(reposDir, { recursive: true })
    mkdirSync(outside)
    symlinkSync(
      outside,
      join(reposDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(resolveRepoPath(fs, 'linked', home)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_repo',
    })
  })

  it('rejects a linked managed repositories root', async () => {
    const loomDir = join(home, '.loom')
    const outside = join(home, 'outside')
    mkdirSync(loomDir, { recursive: true })
    mkdirSync(join(outside, 'default'), { recursive: true })
    symlinkSync(outside, join(loomDir, 'repos'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(resolveRepoPath(fs, 'default', home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
    })
    await expect(listRepos(fs, home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
    })
  })

  it('rejects unknown repo (path traversal safe)', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    await expect(resolveRepoPath(fs, '../etc', home)).rejects.toThrow(/invalid repo/)
    await expect(resolveRepoPath(fs, 'nonexistent', home)).rejects.toThrow(/invalid repo/)
  })

  it.each([
    '',
    '.',
    '..',
    '.hidden',
    'team/repo',
    'team\\repo',
    '/absolute',
    'C:\\repo',
    ' leading',
    'trailing ',
    'line\nbreak',
  ])('rejects unsafe repository name %j', async (name) => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    await expect(resolveRepoPath(fs, name, home)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_repo',
      message: 'invalid repo',
    })
  })

  it('treats non-directory managed roots as unavailable', async () => {
    writeFileSync(join(home, '.loom'), 'not a directory')
    await expect(resolveRepoPath(fs, 'default', home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
      message: 'repository is unavailable',
    })

    rmSync(join(home, '.loom'), { force: true })
    mkdirSync(join(home, '.loom'), { recursive: true })
    writeFileSync(join(home, '.loom', 'repos'), 'not a directory')
    await expect(resolveRepoPath(fs, 'default', home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
      message: 'repository is unavailable',
    })
  })

  it('fails closed on repository root IO errors', async () => {
    const reposDir = join(home, '.loom', 'repos')
    mkdirSync(join(reposDir, 'default'), { recursive: true })
    class FailingReadFileSystem extends NodeFileSystem {
      override async readDir(path: string): Promise<string[]> {
        if (path === realpathSync(reposDir)) {
          throw Object.assign(new Error('private repository path'), { code: 'EIO' })
        }
        return super.readDir(path)
      }
    }

    await expect(
      resolveRepoPath(new FailingReadFileSystem(), 'default', home),
    ).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
      message: 'repository is unavailable',
    })
  })

  it('keeps repository listing and exact resolution in parity', async () => {
    const reposDir = join(home, '.loom', 'repos')
    mkdirSync(join(reposDir, 'default'), { recursive: true })
    mkdirSync(join(reposDir, 'work'))
    writeFileSync(join(reposDir, 'file'), 'not a repository')

    const listed = await listRepos(fs, home)
    expect(listed).toEqual(['default', 'work'])
    await expect(
      Promise.all(listed.map((name) => resolveRepoPath(fs, name, home))),
    ).resolves.toEqual(listed.map((name) => realpathSync(join(reposDir, name))))
    await expect(resolveRepoPath(fs, 'file', home)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_repo',
    })
  })

  it('rejects a linked managed .loom root', async () => {
    const outside = join(home, 'outside')
    mkdirSync(join(outside, 'repos', 'default'), { recursive: true })
    symlinkSync(outside, join(home, '.loom'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(resolveRepoPath(fs, 'default', home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
    })
  })

  it('fails closed when a repository identity changes during validation', async () => {
    const repository = join(home, '.loom', 'repos', 'default')
    mkdirSync(repository, { recursive: true })
    const canonicalRepository = realpathSync(repository)
    let inspections = 0
    class RacingFileSystem extends NodeFileSystem {
      override async inspectEntry(path: string) {
        const entry = await super.inspectEntry(path)
        if (path === canonicalRepository && entry && ++inspections >= 3) {
          return { ...entry, identity: `${entry.identity}-changed` }
        }
        return entry
      }
    }

    await expect(resolveRepoPath(new RacingFileSystem(), 'default', home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
    })
  })

  it('rejects duplicate physical repository identities', async () => {
    const reposDir = join(home, '.loom', 'repos')
    const first = join(reposDir, 'default')
    const second = join(reposDir, 'work')
    mkdirSync(first, { recursive: true })
    mkdirSync(second)
    const canonicalFirst = realpathSync(first)
    const canonicalSecond = realpathSync(second)
    class DuplicateIdentityFileSystem extends NodeFileSystem {
      override async inspectEntry(path: string) {
        const entry = await super.inspectEntry(path)
        if ((path === canonicalFirst || path === canonicalSecond) && entry) {
          return { ...entry, identity: 'same-dir' }
        }
        return entry
      }
    }

    await expect(listRepos(new DuplicateIdentityFileSystem(), home)).rejects.toMatchObject({
      status: 500,
      code: 'repo_unavailable',
    })
  })
})
