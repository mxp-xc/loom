import { describe, it, expect, afterAll } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { abortConflictMerge, saveConflict, syncPull } from '../../src/sync/pull'
import { cleanupGitTestTemplates, createDivergedRepo, type DivergedFile } from '../helpers/git'

const created: string[] = []

afterAll(async () => {
  for (const p of created.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
  await cleanupGitTestTemplates()
})

async function setupRepo(contentBase: string, ours: string, theirs: string): Promise<string> {
  const { root, repo } = await createDivergedRepo([
    { path: 'skills.yaml', base: contentBase, ours, theirs },
  ])
  created.push(root)
  return repo
}

async function setupRepoMulti(files: DivergedFile[]): Promise<string> {
  const { root, repo } = await createDivergedRepo(files)
  created.push(root)
  return repo
}

const A = 'sources:\n  - url: github:x/a\n    ref: v1\nskills: []\n'
const B =
  'sources:\n  - url: github:x/a\n    ref: v1\n  - url: github:x/b\n    ref: v1\nskills: []\n'
const C =
  'sources:\n  - url: github:x/a\n    ref: v1\n  - url: github:x/c\n    ref: v1\nskills: []\n'

describe.concurrent('syncPull', () => {
  it('keeps native Git conflict state for competing line edits', async () => {
    const repo = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const git = new NodeGit()
    const fs = new NodeFileSystem()
    const result = await syncPull(repo, git, fs)

    expect(result.clean).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      path: 'skills.yaml',
      base: 'value: base',
      ours: 'value: local',
      theirs: 'value: remote',
    })
    expect(result.conflicts[0].result).toContain('<<<<<<< HEAD')

    const resumed = await syncPull(repo, git, fs)
    expect(resumed.clean).toBe(false)
    expect(resumed.conflicts.map((conflict) => conflict.path)).toEqual(['skills.yaml'])

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

  it('aborts an in-progress conflict merge', async () => {
    const repo = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const git = new NodeGit()
    await syncPull(repo, git, new NodeFileSystem())

    await abortConflictMerge(repo, git)

    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
    expect(await git.unmergedPaths(repo)).toEqual([])
  })
})
