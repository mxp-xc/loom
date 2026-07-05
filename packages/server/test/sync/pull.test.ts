import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { abortConflictMerge, saveConflict, syncPull } from '../../src/sync/pull'

const created: string[] = []
afterAll(async () => {
  for (const p of created.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

async function setupRepo(contentBase: string, ours: string, theirs: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'syncrepo-'))
  const g = simpleGit(repo)
  await g.raw(['init', '-b', 'main'])
  await g.addConfig('user.email', 't@t.t')
  await g.addConfig('user.name', 't')
  await writeFile(join(repo, 'skills.yaml'), contentBase)
  await g.add('.')
  await g.commit('base')
  const bare = await mkdtemp(join(tmpdir(), 'syncbare-'))
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
  await g.addRemote('origin', bare)
  await g.push('origin', 'HEAD:main')
  await writeFile(join(repo, 'skills.yaml'), ours)
  await g.add('.')
  await g.commit('ours')
  const w2 = await mkdtemp(join(tmpdir(), 'syncw2-'))
  const gw2 = simpleGit(w2)
  await gw2.clone(bare, '.')
  await gw2.addConfig('user.email', 't@t.t')
  await gw2.addConfig('user.name', 't')
  await writeFile(join(w2, 'skills.yaml'), theirs)
  await gw2.add('.')
  await gw2.commit('theirs')
  await gw2.push('origin', 'HEAD:main')
  await g.fetch('origin')
  created.push(repo, bare, w2)
  return repo
}

async function setupRepoMulti(
  files: { path: string; base?: string; ours?: string; theirs?: string }[],
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'syncrepo-'))
  const g = simpleGit(repo)
  await g.raw(['init', '-b', 'main'])
  await g.addConfig('user.email', 't@t.t')
  await g.addConfig('user.name', 't')
  const writeAt = async (root: string, p: string, c: string) => {
    await mkdir(join(root, dirname(p)), { recursive: true }).catch(() => {})
    await writeFile(join(root, p), c)
  }
  for (const f of files) if (f.base !== undefined) await writeAt(repo, f.path, f.base)
  await g.add('.')
  await g.commit('base')
  const bare = await mkdtemp(join(tmpdir(), 'syncbare-'))
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
  await g.addRemote('origin', bare)
  await g.push('origin', 'HEAD:main')
  for (const f of files) if (f.ours !== undefined) await writeAt(repo, f.path, f.ours)
  await g.add('.')
  await g.commit('ours')
  const w2 = await mkdtemp(join(tmpdir(), 'syncw2-'))
  const gw2 = simpleGit(w2)
  await gw2.clone(bare, '.')
  await gw2.addConfig('user.email', 't@t.t')
  await gw2.addConfig('user.name', 't')
  for (const f of files) if (f.theirs !== undefined) await writeAt(w2, f.path, f.theirs)
  await gw2.add('.')
  await gw2.commit('theirs')
  await gw2.push('origin', 'HEAD:main')
  await g.fetch('origin')
  created.push(repo, bare, w2)
  return repo
}

const A = 'sources:\n  - url: github:x/a\n    ref: v1\nskills: []\n'
const B =
  'sources:\n  - url: github:x/a\n    ref: v1\n  - url: github:x/b\n    ref: v1\nskills: []\n'
const C =
  'sources:\n  - url: github:x/a\n    ref: v1\n  - url: github:x/c\n    ref: v1\nskills: []\n'

describe('syncPull', () => {
  it('keeps native Git conflict state for competing line edits', async () => {
    const repo = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const result = await syncPull(repo, new NodeGit(), new NodeFileSystem())

    expect(result.clean).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      path: 'skills.yaml',
      base: 'value: base',
      ours: 'value: local',
      theirs: 'value: remote',
    })
    expect(result.conflicts[0].result).toContain('<<<<<<< HEAD')

    const resumed = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(resumed.clean).toBe(false)
    expect(resumed.conflicts.map((conflict) => conflict.path)).toEqual(['skills.yaml'])
  })

  it('no conflict: Git auto-merges changes on separate lines', async () => {
    const repo = await setupRepo(
      'first: base\ncontext: unchanged\nsecond: base\n',
      'first: local\ncontext: unchanged\nsecond: base\n',
      'first: base\ncontext: unchanged\nsecond: remote\n',
    )
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(true)
    const merged = await readFile(join(repo, 'skills.yaml'), 'utf8')
    expect(merged).toBe('first: local\ncontext: unchanged\nsecond: remote\n')
  })
  it('conflict: both change same ref -> Git conflict with worktree markers', async () => {
    const repo = await setupRepo(
      A,
      'sources:\n  - url: github:x/a\n    ref: v2\nskills: []\n',
      'sources:\n  - url: github:x/a\n    ref: v3\nskills: []\n',
    )
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(false)
    expect(res.conflicts.map((conflict) => conflict.path)).toContain('skills.yaml')
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toContain('<<<<<<< HEAD')
  })
  it('vars union: HEAD has no vars, theirs adds vars/local.yaml -> clean', async () => {
    const repo = await setupRepoMulti([
      { path: 'skills.yaml', base: A, ours: A, theirs: A },
      { path: 'vars/local.yaml', theirs: 'k: v\n' },
    ])
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(true)
    expect(await readFile(join(repo, 'vars', 'local.yaml'), 'utf8')).toContain('k: v')
  })
  it('assets both sides change -> native Git conflict', async () => {
    const repo = await setupRepoMulti([
      { path: 'skills.yaml', base: A, ours: A, theirs: A },
      { path: 'assets/skills/foo/SKILL.md', base: 'v1\n', ours: 'v2\n', theirs: 'v3\n' },
    ])
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(false)
    expect(res.conflicts.some((conflict) => conflict.path.includes('SKILL.md'))).toBe(true)
  })

  it('saves a resolved file and creates a two-parent merge commit', async () => {
    const repo = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const git = new NodeGit()
    const fs = new NodeFileSystem()
    await syncPull(repo, git, fs)

    await expect(saveConflict(repo, git, fs, 'skills.yaml', '<<<<<<< HEAD\n')).rejects.toThrow(
      '仍包含未解决的冲突标记',
    )

    const saved = await saveConflict(repo, git, fs, 'skills.yaml', 'value: chosen\n')
    expect(saved).toEqual({ clean: true, remaining: [] })
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: chosen\n')

    const parents = (await simpleGit(repo).raw(['rev-list', '--parents', '-n', '1', 'HEAD']))
      .trim()
      .split(' ')
    expect(parents).toHaveLength(3)
  })

  it('aborts an in-progress conflict merge', async () => {
    const repo = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const git = new NodeGit()
    await syncPull(repo, git, new NodeFileSystem())

    await abortConflictMerge(repo, git)

    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
    expect(await git.unmergedPaths(repo)).toEqual([])
  })
})
