import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import {
  checkUpdates,
  compareProjectionPaths,
  detectResourceBoundaryChanges,
  prepareSourceUpdate,
} from '../../src/remote/update'
import { deriveRepoId, type SkillSource } from '@loom/core'
import type { SkillMemberSnapshot } from '../../src/skills/reconciliation'
import { createBareRepo } from '../helpers/git'

describe.concurrent('checkUpdates', () => {
  it('hasUpdate when remote tag commit != pinned_commit', async () => {
    const lsRemote = vi.fn(async () => ({ tags: { 'v5.1.4': 'bbb' }, head: 'bbb' }))
    const mockGit = { lsRemote } as any
    const sources: SkillSource[] = [
      { url: 'https://git.example.com/x/y.git', ref: 'v5.1.4', pinned_commit: 'aaa' },
    ]
    const r = await checkUpdates(sources, mockGit)
    expect(r[0].hasUpdate).toBe(true)
    expect(lsRemote).toHaveBeenCalledWith('https://git.example.com/x/y.git')
  })
  it('no update when pinned_commit matches latest tag commit', async () => {
    const mockGit = { lsRemote: async () => ({ tags: { 'v5.1.4': 'aaa' }, head: 'aaa' }) } as any
    const r = await checkUpdates(
      [{ url: 'https://git.example.com/x/y.git', ref: 'v5.1.4', pinned_commit: 'aaa' }],
      mockGit,
    )
    expect(r[0].hasUpdate).toBe(false)
  })
})

describe.concurrent('prepareSourceUpdate', () => {
  let bare: string
  beforeAll(async () => {
    bare = await createBareRepo([
      {
        message: 'v1',
        files: {
          'skills/brainstorming/SKILL.md': '---\nname: brainstorming\n---\nv1\n',
          'skills/brainstorming/reference.md': 'old resource',
        },
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
      {
        message: 'invalid nested bundle',
        files: {
          'skills/outer/SKILL.md': '---\nname: outer\n---\n',
          'skills/outer/inner/SKILL.md': '---\nname: inner\n---\n',
        },
        tags: ['v3.0.0'],
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
    const cacheDir = join(repoPath, 'remote-cache', deriveRepoId(bare))
    await git.clone(bare, cacheDir, false)
    await git.checkout(cacheDir, 'v1.0.0')
    const liveCommit = await git.revParseHead(cacheDir)
    const oldMembers: SkillMemberSnapshot[] = [
      {
        name: 'brainstorming',
        entry: 'skills/brainstorming/SKILL.md',
        path: 'skills/brainstorming/SKILL.md',
      },
    ]
    const res = await prepareSourceUpdate(
      git,
      fs,
      { url: bare, ref: 'v1.0.0', pinned_commit: liveCommit },
      'v2.0.0',
      repoPath,
      oldMembers,
    )
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await git.revParseHead(cacheDir)).toBe(liveCommit)
    expect(res.changes.removed.map((o) => o.name)).toEqual(['brainstorming'])
    expect(res.changes.added.map((o) => o.name)).toEqual(['tdd'])
    expect(await fs.readFile(join(res.stagingDir, 'skills', 'brainstorming', 'reference.md'))).toBe(
      'old resource',
    )
    await rm(repoPath, { recursive: true, force: true })
  })

  it('rejects an invalid candidate SourceTree before finalize', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'updrepo-invalid-'))
    const git = new NodeGit()
    const fs = new NodeFileSystem()

    await expect(
      prepareSourceUpdate(
        git,
        fs,
        { url: bare, ref: 'v2.0.0', pinned_commit: 'old', members: [] },
        'v3.0.0',
        repoPath,
        [],
      ),
    ).rejects.toThrow(/nested/i)
    expect(await fs.exists(join(repoPath, 'temp', 'source-updates'))).toBe(true)
    expect(await fs.readDir(join(repoPath, 'temp', 'source-updates'))).toEqual([])
    await rm(repoPath, { recursive: true, force: true })
  })

  it('snapshots a removed root bundle without copying Git metadata', async () => {
    const rootBare = await createBareRepo([
      {
        message: 'root bundle',
        files: { 'SKILL.md': '---\nname: root-skill\n---\n', 'guide.md': 'guide' },
        tags: ['v1'],
      },
      {
        message: 'replace root bundle',
        files: { 'SKILL.md': null, 'next/SKILL.md': '---\nname: next\n---\n' },
        tags: ['v2'],
      },
    ])
    const repoPath = await mkdtemp(join(tmpdir(), 'updrepo-root-'))
    const git = new NodeGit()
    const fs = new NodeFileSystem()
    const cacheDir = join(repoPath, 'remote-cache', deriveRepoId(rootBare))
    await git.clone(rootBare, cacheDir, false)
    await git.checkout(cacheDir, 'v1')

    const result = await prepareSourceUpdate(
      git,
      fs,
      {
        url: rootBare,
        ref: 'v1',
        members: [{ name: 'root-skill', entry: 'SKILL.md' }],
      },
      'v2',
      repoPath,
      [{ name: 'root-skill', entry: 'SKILL.md', path: 'SKILL.md' }],
    )

    expect(await fs.readFile(join(result.stagingDir, 'SKILL.md'))).toContain('root-skill')
    expect(await fs.readFile(join(result.stagingDir, 'guide.md'))).toBe('guide')
    expect(await fs.exists(join(result.stagingDir, '.git'))).toBe(false)
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(rootBare, { recursive: true, force: true }),
    ])
  })
})

describe('compareProjectionPaths', () => {
  it('reports retained entries whose destination moves after projection base changes', () => {
    const source: SkillSource = {
      url: 'https://example.test/skills.git',
      ref: 'main',
      members: [
        { name: 'alpha', entry: 'group/alpha/SKILL.md', agents: ['codex'] },
        { name: 'beta', entry: 'other/beta/SKILL.md', agents: ['codex'] },
      ],
    }
    const bundle = (name: string, path: string) => ({
      kind: 'bundle' as const,
      name,
      path,
      entry: `${path}/SKILL.md`,
      mode: '040000',
      oid: `${name}-oid`,
    })
    const previousTree = {
      commit: 'old',
      diagnostics: [],
      nodes: [bundle('alpha', 'group/alpha'), bundle('beta', 'other/beta')],
    }
    const nextTree = {
      commit: 'new',
      diagnostics: [],
      nodes: [bundle('alpha', 'group/alpha')],
    }

    expect(
      compareProjectionPaths(source, previousTree, nextTree, [
        { name: 'alpha', entry: 'group/alpha/SKILL.md' },
      ]),
    ).toEqual([
      {
        agent: 'codex',
        kind: 'bundle',
        sourcePath: 'group/alpha',
        previousTargetPath: 'group/alpha',
        nextTargetPath: 'alpha',
      },
      {
        agent: 'codex',
        kind: 'bundle',
        sourcePath: 'other/beta',
        previousTargetPath: 'other/beta',
      },
    ])
  })
})

describe('detectResourceBoundaryChanges', () => {
  const bundles = [
    { name: 'existing', entry: 'shared/existing/SKILL.md' },
    { name: 'new-skill', entry: 'shared/new-skill/SKILL.md' },
  ]

  it('reports a new bundle inside an included resource directory', () => {
    expect(
      detectResourceBoundaryChanges(
        {
          resources: {
            include: [{ path: 'shared', kind: 'directory' }],
            exclude: [],
          },
        },
        new Set(['shared/existing/SKILL.md']),
        bundles,
      ),
    ).toEqual([
      {
        name: 'new-skill',
        entry: 'shared/new-skill/SKILL.md',
        path: 'shared/new-skill',
      },
    ])
  })

  it('reports a boundary when a selected descendant becomes part of a bundle', () => {
    expect(
      detectResourceBoundaryChanges(
        {
          resources: {
            include: [{ path: 'shared/new-skill/prompt.md', kind: 'file' }],
            exclude: [],
          },
        },
        new Set(),
        bundles,
      ),
    ).toHaveLength(1)
  })

  it('ignores existing bundles and excluded subtrees', () => {
    expect(
      detectResourceBoundaryChanges(
        {
          resources: {
            include: [{ path: 'shared', kind: 'directory' }],
            exclude: [{ path: 'shared/new-skill', kind: 'directory' }],
          },
        },
        new Set(['shared/existing/SKILL.md']),
        bundles,
      ),
    ).toEqual([])
  })
})
