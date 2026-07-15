import { describe, expect, it, vi } from 'vitest'
import { discoverSkills, discoverSourceTree } from '../../src/remote/discover.js'
import { formatSourceMemberSkillId } from '@loom/core'
import type { IFileSystem } from '../../src/ports/fs.js'
import type { GitTreeEntry, IGit } from '../../src/ports/git.js'

describe('remote source discovery', () => {
  it.each(['https://gitlab.example.com/owner/skills.git', 'git@gitcode.com:owner/skills.git'])(
    'passes the configured Git URL through unchanged: %s',
    async (url) => {
      const git = sourceGit()

      await discoverSourceTree(git, { url, ref: 'main' })

      expect(git.clone).toHaveBeenCalledWith(url, expect.any(String), false)
    },
  )

  it('checks out the requested ref and scans that commit tree', async () => {
    const git = sourceGit()

    const tree = await discoverSourceTree(git, {
      url: 'https://example.test/skills.git',
      ref: 'v1.0.1',
      type: 'tag',
    })

    expect(git.checkout).toHaveBeenCalledWith(expect.any(String), 'v1.0.1')
    expect(git.readTree).toHaveBeenCalledWith(expect.any(String), 'v1.0.1')
    expect(tree).toMatchObject({
      commit: 'commit-oid',
      nodes: [
        {
          kind: 'container',
          path: 'skills',
          children: [
            {
              kind: 'bundle',
              name: 'brainstorming',
              entry: 'skills/brainstorming/SKILL.md',
              description: 'A skill',
            },
          ],
        },
      ],
      diagnostics: [],
    })
  })

  it('derives legacy member results from bundles without changing their entry identity', async () => {
    const url = 'https://example.test/skills.git'
    const members = await discoverSkills(
      sourceGit(),
      {} as IFileSystem,
      { url, ref: 'main' },
      new Set([formatSourceMemberSkillId(url, 'brainstorming', 'hyphen')]),
    )

    expect(members).toEqual([
      {
        name: 'brainstorming',
        description: 'A skill',
        path: 'skills/brainstorming/SKILL.md',
        installed: true,
      },
    ])
  })
})

function sourceGit(): IGit {
  const entries: GitTreeEntry[] = [
    { mode: '040000', type: 'tree', oid: 'skills-oid', path: 'skills' },
    {
      mode: '040000',
      type: 'tree',
      oid: 'bundle-oid',
      path: 'skills/brainstorming',
    },
    {
      mode: '100644',
      type: 'blob',
      oid: 'skill-oid',
      path: 'skills/brainstorming/SKILL.md',
    },
  ]
  return {
    clone: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    readTree: vi.fn(async () => entries),
    revParse: vi.fn(async (_repoPath: string, ref: string) =>
      ref.endsWith('^{tree}') ? 'root-tree-oid' : 'commit-oid',
    ),
    show: vi.fn(async () => '---\ndescription: A skill\n---\nbody'),
  } as unknown as IGit
}
