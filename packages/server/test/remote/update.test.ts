import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { createSourceUpdateWorkspace } from '../../src/skills/source-update-workspace.js'

const updateLog = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: vi.fn(() => updateLog) },
}))

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
    const repoPath = await realpath(await mkdtemp(join(tmpdir(), 'updrepo-')))
    const git = new NodeGit(),
      fs = new NodeFileSystem()
    const cacheDir = join(repoPath, 'remote-cache', deriveRepoId(bare))
    await git.clone(bare, cacheDir, false)
    await git.checkout(cacheDir, 'v1.0.0')
    const liveCommit = await git.revParseHead(cacheDir)
    const sentinel = join(repoPath, 'outside.txt')
    await writeFile(sentinel, 'outside')
    await writeFile(join(cacheDir, 'skills', 'brainstorming', 'reference.md'), 'dirty checkout')
    await writeFile(join(cacheDir, 'skills', 'brainstorming', 'untracked.md'), 'untracked')
    if (process.platform !== 'win32') {
      await symlink(sentinel, join(cacheDir, 'skills', 'brainstorming', 'outside-link.md'))
    }
    const workspace = await createSourceUpdateWorkspace(fs, repoPath, bare)
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
      workspace,
      oldMembers,
    )
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await git.revParseHead(cacheDir)).toBe(liveCommit)
    expect(res.changes.removed.map((o) => o.name)).toEqual(['brainstorming'])
    expect(res.changes.added.map((o) => o.name)).toEqual(['tdd'])
    expect(
      await fs.readFile(join(workspace.stagingDir, 'skills', 'brainstorming', 'reference.md')),
    ).toBe('old resource')
    expect(
      await fs.inspectEntry(join(workspace.stagingDir, 'skills', 'brainstorming', 'untracked.md')),
    ).toBeNull()
    if (process.platform !== 'win32') {
      expect(
        await fs.inspectEntry(
          join(workspace.stagingDir, 'skills', 'brainstorming', 'outside-link.md'),
        ),
      ).toBeNull()
    }
    await rm(repoPath, { recursive: true, force: true })
  })

  it('rejects an invalid candidate SourceTree before finalize', async () => {
    const repoPath = await realpath(await mkdtemp(join(tmpdir(), 'updrepo-invalid-')))
    const git = new NodeGit()
    const fs = new NodeFileSystem()
    const workspace = await createSourceUpdateWorkspace(fs, repoPath, bare)

    await expect(
      prepareSourceUpdate(
        git,
        fs,
        { url: bare, ref: 'v2.0.0', pinned_commit: 'old', members: [] },
        'v3.0.0',
        workspace,
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
    const repoPath = await realpath(await mkdtemp(join(tmpdir(), 'updrepo-root-')))
    const git = new NodeGit()
    const fs = new NodeFileSystem()
    const cacheDir = join(repoPath, 'remote-cache', deriveRepoId(rootBare))
    await git.clone(rootBare, cacheDir, false)
    await git.checkout(cacheDir, 'v1')
    const liveCommit = await git.revParseHead(cacheDir)
    const workspace = await createSourceUpdateWorkspace(fs, repoPath, rootBare)

    const result = await prepareSourceUpdate(
      git,
      fs,
      {
        name: 'root-skill',
        url: rootBare,
        ref: 'v1',
        pinned_commit: liveCommit,
        members: [{ name: 'root-skill', entry: 'SKILL.md' }],
      },
      'v2',
      workspace,
      [{ name: 'root-skill', entry: 'SKILL.md', path: 'SKILL.md' }],
    )

    expect(result.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await fs.readFile(join(workspace.stagingDir, 'SKILL.md'))).toContain('root-skill')
    expect(await fs.readFile(join(workspace.stagingDir, 'guide.md'))).toBe('guide')
    expect(await fs.exists(join(workspace.stagingDir, '.git'))).toBe(false)
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(rootBare, { recursive: true, force: true }),
    ])
  })
})

describe('source update workspace ownership', () => {
  it('preserves a replacement when workspace initialization cleanup loses identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loom-update-workspace-race-'))
    const repoPath = join(root, 'repo')
    const primary = new Error('owner write failed')
    await mkdir(repoPath)
    const canonicalRepo = await realpath(repoPath)
    class WorkspaceReplacementFileSystem extends NodeFileSystem {
      override async writeFileExclusive(path: string, content: string, mode?: number) {
        if (path.endsWith('.loom-source-update-owner.json')) {
          const sessionRoot = dirname(path)
          const replacementRoot = `${sessionRoot}-replacement`
          await mkdir(replacementRoot)
          await writeFile(join(replacementRoot, 'replacement.txt'), 'keep')
          await rm(sessionRoot, { recursive: true, force: true })
          await rename(replacementRoot, sessionRoot)
          throw primary
        }
        return super.writeFileExclusive(path, content, mode)
      }
    }

    try {
      const failure = await createSourceUpdateWorkspace(
        new WorkspaceReplacementFileSystem(),
        canonicalRepo,
        'https://example.test/source.git',
      ).catch((error) => error)

      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.cause).toBe(primary)
      const sessionsRoot = join(canonicalRepo, 'temp', 'source-updates')
      const [sessionId] = await new NodeFileSystem().readDir(sessionsRoot)
      await expect(
        new NodeFileSystem().readFile(join(sessionsRoot, sessionId!, 'replacement.txt')),
      ).resolves.toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
