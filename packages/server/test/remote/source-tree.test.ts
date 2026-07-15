import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeGit } from '../../src/platform/node/git.js'
import { scanSourceTree } from '../../src/remote/source-tree.js'
import type { GitTreeEntry, IGit } from '../../src/ports/git.js'
import { createBareRepo } from '../helpers/git.js'

vi.mock('../../src/lib/logger.js', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
    child: () => logger,
  }
  return { logger }
})

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('scanSourceTree', () => {
  it('builds bundles and resources exclusively from the target commit tree', async () => {
    const bare = await createBareRepo([
      {
        message: 'source',
        files: {
          'skills/alpha/SKILL.md': '---\ndescription: Alpha workflow\n---\nbody',
          'skills/alpha/prompts/system.md': 'prompt',
          'skills/beta/skill.md': 'wrong case',
          'shared/workflow.md': 'shared',
        },
      },
    ])
    cleanup.push(bare)
    const checkout = await mkdtemp(join(tmpdir(), 'source-tree-'))
    cleanup.push(checkout)
    const git = new NodeGit()
    await git.clone(bare, checkout)
    await writeFile(join(checkout, 'untracked.md'), 'not part of source')

    const tree = await scanSourceTree(git, checkout, 'HEAD', { url: bare })

    expect(tree.commit).toMatch(/^[0-9a-f]{40,64}$/)
    expect(tree.diagnostics).toEqual([])
    expect(tree.nodes).toMatchObject([
      {
        kind: 'container',
        name: 'shared',
        path: 'shared',
        children: [{ kind: 'resource', path: 'shared/workflow.md' }],
      },
      {
        kind: 'container',
        name: 'skills',
        path: 'skills',
        children: [
          {
            kind: 'bundle',
            name: 'alpha',
            path: 'skills/alpha',
            entry: 'skills/alpha/SKILL.md',
            description: 'Alpha workflow',
          },
          {
            kind: 'container',
            name: 'beta',
            children: [{ kind: 'resource', path: 'skills/beta/skill.md' }],
          },
        ],
      },
    ])
    expect(JSON.stringify(tree.nodes)).not.toContain('untracked.md')
    expect(JSON.stringify(tree.nodes)).not.toContain('skills/alpha/prompts')
  })

  it('represents a root-level SKILL.md as one collapsed bundle', async () => {
    const entries: GitTreeEntry[] = [
      blob('SKILL.md', 'skill-oid'),
      tree('templates', 'templates-oid'),
      blob('templates/example.md', 'example-oid'),
    ]
    const git = mockGit(entries, {
      'SKILL.md': '---\ndescription: Root bundle\n---\nbody',
    })

    const sourceTree = await scanSourceTree(git, '/repo', 'v1', {
      name: 'root-skill',
      url: 'https://example.test/acme/my_skills.git',
    })

    expect(git.revParse).toHaveBeenCalledWith('/repo', 'v1^{commit}')
    expect(sourceTree.nodes).toEqual([
      expect.objectContaining({
        kind: 'bundle',
        name: 'root-skill',
        path: '',
        entry: 'SKILL.md',
        description: 'Root bundle',
      }),
    ])
  })

  it('reports nested bundle candidates and leaves the invalid outer candidate expanded', async () => {
    const entries: GitTreeEntry[] = [
      tree('project', 'project-oid'),
      blob('project/SKILL.md', 'outer-skill'),
      tree('project/child', 'child-oid'),
      blob('project/child/SKILL.md', 'child-skill'),
      blob('project/readme.md', 'readme-oid'),
    ]

    const sourceTree = await scanSourceTree(mockGit(entries), '/repo', 'HEAD', {
      url: 'https://example.test/source.git',
    })

    expect(sourceTree.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid-nested-bundle',
        path: 'project/SKILL.md',
        relatedPaths: ['project/child/SKILL.md'],
      }),
    ])
    const project = sourceTree.nodes[0]
    expect(project).toMatchObject({ kind: 'container', path: 'project' })
    if (project.kind !== 'container') throw new Error('expected project container')
    expect(project.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'resource', path: 'project/SKILL.md' }),
        expect.objectContaining({
          kind: 'bundle',
          path: 'project/child',
          entry: 'project/child/SKILL.md',
        }),
        expect.objectContaining({ kind: 'resource', path: 'project/readme.md' }),
      ]),
    )
  })

  it('reports symlinks and submodules inside a bundle without exposing its children', async () => {
    const entries: GitTreeEntry[] = [
      tree('skill', 'skill-dir'),
      blob('skill/SKILL.md', 'skill-file'),
      { mode: '120000', type: 'blob', oid: 'link-oid', path: 'skill/shared-link' },
      { mode: '160000', type: 'commit', oid: 'submodule-oid', path: 'skill/vendor' },
    ]

    const sourceTree = await scanSourceTree(mockGit(entries), '/repo', 'HEAD', {
      url: 'https://example.test/source.git',
    })

    expect(sourceTree.nodes).toMatchObject([
      { kind: 'bundle', path: 'skill', entry: 'skill/SKILL.md' },
    ])
    expect(sourceTree.diagnostics.map((item) => [item.code, item.path])).toEqual([
      ['bundle-symlink', 'skill/shared-link'],
      ['bundle-submodule', 'skill/vendor'],
    ])
  })

  it('reads bundle metadata concurrently with a global bounded worker count', async () => {
    const entries: GitTreeEntry[] = []
    const files: Record<string, string> = {}
    for (let index = 0; index < 12; index++) {
      const name = `skill-${String(index).padStart(2, '0')}`
      entries.push(tree(name, `${name}-dir`), blob(`${name}/SKILL.md`, `${name}-file`))
      files[`${name}/SKILL.md`] = `---\ndescription: ${name}\n---\nbody`
    }
    const git = mockGit(entries, files)
    let active = 0
    let maxActive = 0
    vi.mocked(git.show).mockImplementation(async (_repoPath, _ref, path) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return files[path] ?? 'body'
    })

    const source = { url: 'https://example.test/source.git' }
    const [firstTree, secondTree] = await Promise.all([
      scanSourceTree(git, '/repo', 'HEAD', source),
      scanSourceTree(git, '/repo', 'HEAD', source),
    ])

    expect(maxActive).toBeGreaterThan(1)
    expect(maxActive).toBeLessThanOrEqual(8)
    const expectedPaths = Array.from(
      { length: 12 },
      (_, index) => `skill-${String(index).padStart(2, '0')}`,
    )
    expect(firstTree.nodes.map((node) => node.path)).toEqual(expectedPaths)
    expect(secondTree.nodes.map((node) => node.path)).toEqual(expectedPaths)
    expect(git.show).toHaveBeenCalledTimes(24)
  })

  it('rejects duplicate bundle names derived from different entry paths', async () => {
    const entries: GitTreeEntry[] = [
      tree('a', 'a-dir'),
      tree('a/demo', 'a-demo-dir'),
      blob('a/demo/SKILL.md', 'a-skill'),
      tree('b', 'b-dir'),
      tree('b/demo', 'b-demo-dir'),
      blob('b/demo/SKILL.md', 'b-skill'),
    ]

    const git = mockGit(entries)

    await expect(
      scanSourceTree(git, '/repo', 'HEAD', {
        url: 'https://example.test/source.git',
      }),
    ).rejects.toThrow(
      'Duplicate source skill member name "demo" from a/demo/SKILL.md and b/demo/SKILL.md',
    )
    expect(git.show).not.toHaveBeenCalled()
  })
})

function mockGit(entries: GitTreeEntry[], files: Record<string, string> = {}): IGit {
  return {
    readTree: vi.fn(async () => entries),
    revParse: vi.fn(async (_repoPath: string, ref: string) =>
      ref.endsWith('^{tree}') ? 'root-tree-oid' : 'commit-oid',
    ),
    show: vi.fn(async (_repoPath: string, _ref: string, path: string) => files[path] ?? 'body'),
  } as unknown as IGit
}

function tree(path: string, oid: string): GitTreeEntry {
  return { mode: '040000', type: 'tree', oid, path }
}

function blob(path: string, oid: string): GitTreeEntry {
  return { mode: '100644', type: 'blob', oid, path }
}
