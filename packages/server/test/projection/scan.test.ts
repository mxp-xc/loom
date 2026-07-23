import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanLocalSkills } from '../../src/projection/scan.js'
import {
  loadDisplayManifest,
  loadProjectionManifest,
  projectRepository,
} from '../../src/projection/workflow.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IGit } from '../../src/ports/git.js'
import type { ProjectionWorkflowDeps } from '../../src/projection/workflow.js'

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

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scan-')))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('scanLocalSkills', () => {
  it('discovers local skills and ignores dependency/cache directories', async () => {
    await mkdir(join(root, 'engineering', 'tdd'), { recursive: true })
    await writeFile(join(root, 'engineering', 'tdd', 'SKILL.md'), 'x')
    await mkdir(join(root, 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'brainstorming', 'SKILL.md'), 'x')
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'ignored', 'SKILL.md'), 'x')
    await mkdir(join(root, '.cache', 'ignored'), { recursive: true })
    await writeFile(join(root, '.cache', 'ignored', 'SKILL.md'), 'x')

    await expect(scanLocalSkills(root)).resolves.toEqual([
      { name: 'brainstorming', path: join(root, 'brainstorming') },
      { name: 'tdd', path: join(root, 'engineering', 'tdd') },
    ])
  })

  it('does not follow directory links while scanning external skill roots', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'scan-outside-'))
    try {
      await mkdir(join(outside, 'linked-skill'), { recursive: true })
      await writeFile(join(outside, 'linked-skill', 'SKILL.md'), 'outside')
      await symlink(
        outside,
        join(root, 'linked-root'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )

      await expect(scanLocalSkills(root)).resolves.toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('loadProjectionManifest', () => {
  it('reports an unsafe URL-derived cache identity before any Git operation', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/..',
        '    ref: main',
        '    members: []',
        'skills: []',
        '',
      ].join('\n'),
    )
    const git = sourceTreeGit([])

    await expect(loadProjectionManifest(deps(git), root)).resolves.toMatchObject({
      errors: ['source[0].url: invalid repository URL'],
    })

    expect(git.revParse).not.toHaveBeenCalled()
    expect(git.revParseHead).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
    expect(git.readTree).not.toHaveBeenCalled()
  })

  it.each(['parent', 'entry'] as const)(
    'rejects a linked remote-cache %s before any Git operation',
    async (linkedPath) => {
      const outside = await mkdtemp(join(tmpdir(), 'projection-cache-outside-'))
      try {
        await writeFile(
          join(root, 'skills.yaml'),
          [
            'sources:',
            '  - url: https://example.test/skills.git',
            '    ref: main',
            '    members: []',
            'skills: []',
            '',
          ].join('\n'),
        )
        if (linkedPath === 'parent') {
          await symlink(
            outside,
            join(root, 'remote-cache'),
            process.platform === 'win32' ? 'junction' : 'dir',
          )
        } else {
          await mkdir(join(root, 'remote-cache'), { recursive: true })
          await symlink(
            outside,
            join(root, 'remote-cache', 'skills'),
            process.platform === 'win32' ? 'junction' : 'dir',
          )
        }
        const git = sourceTreeGit([])

        await expect(loadProjectionManifest(deps(git), root)).rejects.toThrow(
          /not a real directory/,
        )

        expect(git.revParse).not.toHaveBeenCalled()
        expect(git.revParseHead).not.toHaveBeenCalled()
        expect(git.checkout).not.toHaveBeenCalled()
        expect(git.readTree).not.toHaveBeenCalled()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    },
  )

  it('attaches a runtime SourceTree and enriches only configured member entries', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: main',
        '    pinned_commit: commit-1',
        '    members:',
        '      - name: selected',
        '        entry: skills/selected/SKILL.md',
        '        agents: [codex]',
        'skills: []',
        '',
      ].join('\n'),
    )
    await mkdir(join(root, 'remote-cache', 'skills'), { recursive: true })
    const canonicalCache = await new NodeFileSystem().realPath(join(root, 'remote-cache', 'skills'))
    const git = sourceTreeGit([
      treeEntry('skills/selected/SKILL.md', 'selected-skill'),
      treeEntry('skills/unselected/SKILL.md', 'unselected-skill'),
    ])

    const manifest = await loadProjectionManifest(deps(git), root)
    const source = manifest.skills.sources[0]

    expect(source.sourceTree?.commit).toBe('commit-1')
    expect(source.members).toEqual([
      {
        name: 'selected',
        entry: 'skills/selected/SKILL.md',
        agents: ['codex'],
        path: 'skills/selected/SKILL.md',
        description: 'selected description',
      },
    ])
    expect(source.members).not.toContainEqual(expect.objectContaining({ name: 'unselected' }))
    expect(git.revParseHead).toHaveBeenCalledWith(canonicalCache)
    expect(git.checkout).toHaveBeenCalledWith(canonicalCache, 'commit-1')
    expect(git.clone).not.toHaveBeenCalled()
  })

  it('marks a missing source cache unavailable without blocking other sources', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - name: private-skills',
        '    url: git@example.test:team/private-skills.git',
        '    ref: main',
        '    members:',
        '      - name: selected',
        '        entry: skills/selected/SKILL.md',
        '        agents: [codex]',
        '  - name: public-skills',
        '    url: https://example.test/public-skills.git',
        '    ref: main',
        '    pinned_commit: commit-1',
        '    members:',
        '      - name: available',
        '        entry: skills/available/SKILL.md',
        '        agents: [codex]',
        'skills: []',
        '',
      ].join('\n'),
    )
    await mkdir(join(root, 'remote-cache', 'public-skills'), { recursive: true })
    const git = sourceTreeGit([treeEntry('skills/available/SKILL.md', 'available-skill')])

    const manifest = await loadProjectionManifest(deps(git), root)

    expect(manifest.skills.sources[0].availability).toMatchObject({
      available: false,
      reason: 'cache-unavailable',
    })
    expect(manifest.skills.sources[1].sourceTree?.commit).toBe('commit-1')

    expect(git.clone).not.toHaveBeenCalled()
    expect(git.readTree).toHaveBeenCalledTimes(1)
  })
})

describe('projectRepository', () => {
  it.each([
    ['skills.yaml', 'invalid\n'],
    ['mcp.yaml', 'servers: []\n'],
    ['config.yaml', 'invalid\n'],
  ])('fails before process, Git, or projection writes for malformed %s', async (file, source) => {
    await writeFile(join(root, file), source)
    const git = sourceTreeGit([])
    const projectDeps = deps(git)

    const result = await projectRepository(projectDeps, root, { scope: 'all' })

    expect(result).toMatchObject({
      ok: false,
      failure: { failedStep: 'manifest-invalid', rollbackReport: { undone: 0 } },
    })
    expect(projectDeps.proc.isCommandInstalled).not.toHaveBeenCalled()
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
    expect(git.readTree).not.toHaveBeenCalled()
    expect(await projectDeps.fs.exists(join(root, '.codex'))).toBe(false)
  })

  it('projects available local skills while preserving an unavailable remote source', async () => {
    await writeFile(join(root, 'config.yaml'), 'agents: [codex]\n')
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - name: private-skills',
        '    url: git@example.test:team/private-skills.git',
        '    ref: main',
        '    members:',
        '      - name: selected',
        '        entry: skills/selected/SKILL.md',
        '        agents: [codex]',
        'skills:',
        '  - id: local-skill',
        '    agents: [codex]',
        '',
      ].join('\n'),
    )
    const localSkill = join(root, 'assets', 'skills', 'local-skill')
    await mkdir(localSkill, { recursive: true })
    await writeFile(join(localSkill, 'SKILL.md'), '# Local skill\n')
    const git = sourceTreeGit([])
    const projectDeps = deps(git)
    projectDeps.proc.isCommandInstalled = async (command) => command === 'codex'
    const projectionManifest = await loadProjectionManifest(projectDeps, root, 'skills')
    expect(projectionManifest.config.agents).toEqual(['codex'])
    expect(projectionManifest.skills.skills).toContainEqual(
      expect.objectContaining({ id: 'local-skill', agents: ['codex'] }),
    )

    const result = await projectRepository(projectDeps, root, {
      scope: 'skills',
      installedAgents: ['codex'],
    })

    expect(result).toEqual({
      ok: true,
      warnings: [
        expect.objectContaining({
          code: 'source-unavailable',
          sourceName: 'private-skills',
        }),
      ],
    })
    await expect(
      projectDeps.fs.readFile(join(root, '.codex', 'skills', 'local-skill', 'SKILL.md')),
    ).resolves.toBe('# Local skill\n')
    expect(git.clone).not.toHaveBeenCalled()
  })

  it('projects an explicit local skill path from its authorized manifest entry', async () => {
    await writeFile(join(root, 'config.yaml'), 'agents: [codex]\n')
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources: []',
        'skills:',
        '  - id: external-skill',
        '    path: ./external',
        '    agents: [codex]',
        '',
      ].join('\n'),
    )
    await mkdir(join(root, 'external'), { recursive: true })
    await writeFile(join(root, 'external', 'SKILL.md'), '# External skill\n')
    const projectDeps = deps(sourceTreeGit([]))
    projectDeps.proc.isCommandInstalled = vi.fn(async () => true)

    const result = await projectRepository(projectDeps, root, {
      scope: 'skills',
      installedAgents: ['codex'],
    })

    expect(result).toEqual({ ok: true })
    await expect(
      projectDeps.fs.readFile(join(root, '.codex', 'skills', 'external-skill', 'SKILL.md')),
    ).resolves.toBe('# External skill\n')
  })

  it('agent-scoped projection ignores another agent user-owned destination', async () => {
    await writeFile(join(root, 'config.yaml'), 'agents: [codex, opencode]\n')
    await writeFile(
      join(root, 'skills.yaml'),
      ['sources: []', 'skills:', '  - id: local-skill', '    agents: [codex, opencode]', ''].join(
        '\n',
      ),
    )
    const localSkill = join(root, 'assets', 'skills', 'local-skill')
    await mkdir(localSkill, { recursive: true })
    await writeFile(join(localSkill, 'SKILL.md'), '# Local skill\n')
    const codexDestination = join(root, '.codex', 'skills', 'local-skill')
    await mkdir(codexDestination, { recursive: true })
    await writeFile(join(codexDestination, 'SKILL.md'), '# User owned\n')

    const projectDeps = deps(sourceTreeGit([]))
    projectDeps.proc.isCommandInstalled = vi.fn(async () => true)
    const result = await projectRepository(projectDeps, root, {
      scope: 'skills',
      agent: 'opencode',
      installedAgents: ['codex', 'opencode'],
    })

    expect(result).toEqual({ ok: true })
    await expect(readFile(join(codexDestination, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# User owned\n',
    )
    await expect(
      readFile(join(root, '.config', 'opencode', 'skills', 'local-skill', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Local skill\n')
  })

  it('rejects a local projection plan whose path differs from the authorized manifest entry', async () => {
    await writeFile(join(root, 'config.yaml'), 'agents: [codex]\n')
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources: []',
        'skills:',
        '  - id: external-skill',
        '    path: ./external',
        '    agents: [codex]',
        '',
      ].join('\n'),
    )
    await mkdir(join(root, 'external'), { recursive: true })
    await writeFile(join(root, 'external', 'SKILL.md'), '# External skill\n')
    const projectDeps = deps(sourceTreeGit([]))

    const result = await projectRepository(projectDeps, root, {
      scope: 'skills',
      installedAgents: ['codex'],
      plan: {
        links: [
          {
            skillId: 'external-skill',
            localPath: './other',
            source: 'local',
            agents: ['codex'],
          },
        ],
        sourcePlans: [],
        preservedSourceNamespaces: [],
        mcpEntries: [],
        memoryPlan: { active: null, content: null, agents: [] },
        skippedAgents: [],
        strategy: 'link',
      },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        failedStep: 'projection',
        rollbackReport: { undone: 0, rollbackFailures: [] },
      },
    })
    expect(await projectDeps.fs.exists(join(root, '.codex'))).toBe(false)
  })

  it.each(['mcp', 'memory'] as const)(
    'does not read or install skill source trees for %s-only projection',
    async (scope) => {
      await writeFile(
        join(root, 'skills.yaml'),
        [
          'sources:',
          '  - url: https://example.test/skills.git',
          '    ref: main',
          '    pinned_commit: commit-1',
          '    members:',
          '      - name: selected',
          '        entry: skills/selected/SKILL.md',
          '        agents: [codex]',
          'skills: []',
          '',
        ].join('\n'),
      )
      const git = sourceTreeGit([treeEntry('skills/selected/SKILL.md', 'selected-skill')])

      await expect(projectRepository(deps(git), root, { scope })).resolves.toEqual({ ok: true })

      expect(git.clone).not.toHaveBeenCalled()
      expect(git.checkout).not.toHaveBeenCalled()
      expect(git.readTree).not.toHaveBeenCalled()
      expect(git.show).not.toHaveBeenCalled()
    },
  )
})

describe('loadDisplayManifest', () => {
  it('returns stable diagnostics instead of throwing for malformed containers', async () => {
    await writeFile(join(root, 'skills.yaml'), 'invalid\n')

    const manifest = await loadDisplayManifest(deps(sourceTreeGit([])), root)

    expect(manifest.skills).toEqual({ sources: [], skills: [], group_order: [] })
    expect(manifest.errors).toEqual([expect.stringContaining('skills.yaml')])
  })

  it('validates the pinned local tree without scanning it and enriches configured members', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - url: https://example.test/skills.git',
        '    ref: main',
        '    members:',
        '      - name: selected',
        '        entry: skills/selected/SKILL.md',
        'skills: []',
        '',
      ].join('\n'),
    )
    const skillDir = join(root, 'remote-cache', 'skills', 'skills', 'selected')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: selected\ndescription: selected description\n---\n',
    )
    const git = sourceTreeGit([])

    const manifest = await loadDisplayManifest(deps(git), root)

    expect(manifest.skills.sources[0].members).toEqual([
      {
        name: 'selected',
        entry: 'skills/selected/SKILL.md',
        path: 'skills/selected/SKILL.md',
        description: 'selected description',
      },
    ])
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
    expect(git.revParse).toHaveBeenCalledTimes(2)
    expect(git.readTree).not.toHaveBeenCalled()
    expect(git.show).not.toHaveBeenCalled()
  })

  it('marks an existing but unreadable source cache invalid', async () => {
    await writeFile(
      join(root, 'skills.yaml'),
      [
        'sources:',
        '  - name: private-skills',
        '    url: git@example.test:team/private-skills.git',
        '    ref: main',
        '    pinned_commit: commit-1',
        '    members:',
        '      - name: selected',
        '        entry: skills/selected/SKILL.md',
        'skills: []',
        '',
      ].join('\n'),
    )
    await mkdir(join(root, 'remote-cache', 'private-skills'), { recursive: true })
    const git = sourceTreeGit([])
    git.revParse = vi.fn(async () => {
      throw new Error('not a readable Git cache')
    })

    const manifest = await loadDisplayManifest(deps(git), root)

    expect(manifest.skills.sources[0]).toMatchObject({
      availability: {
        available: false,
        reason: 'cache-invalid',
        message: 'not a readable Git cache',
      },
      members: [{ name: 'selected', path: 'skills/selected/SKILL.md' }],
    })
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
  })
})

function deps(git: IGit): ProjectionWorkflowDeps {
  return {
    fs: new NodeFileSystem(),
    git,
    proc: { isCommandInstalled: vi.fn(async () => false) },
    home: root,
  }
}

function treeEntry(path: string, name: string) {
  return { mode: '100644', type: 'blob' as const, oid: `${name}-oid`, path }
}

function sourceTreeGit(entries: ReturnType<typeof treeEntry>[]): IGit {
  return {
    clone: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    revParseHead: vi.fn(async () => 'abc123'),
    revParse: vi.fn(async (_repoPath, ref) => {
      if (ref.endsWith('^{tree}')) return 'root-tree'
      const peeled = ref.replace(/\^\{commit\}$/, '')
      return peeled === 'HEAD' ? 'abc123' : peeled
    }),
    readTree: vi.fn(async () => entries),
    show: vi.fn(async (_repoPath, _ref, path) => {
      const name = path.split('/').at(-2) ?? 'skill'
      return `---\nname: ${name}\ndescription: ${name} description\n---\n`
    }),
  } as Partial<IGit> as IGit
}
