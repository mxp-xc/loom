import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  root = await mkdtemp(join(tmpdir(), 'scan-'))
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
})

describe('loadProjectionManifest', () => {
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
    expect(git.revParseHead).toHaveBeenCalledWith(join(root, 'remote-cache', 'skills'))
    expect(git.checkout).toHaveBeenCalledWith(join(root, 'remote-cache', 'skills'), 'commit-1')
    expect(git.clone).not.toHaveBeenCalled()
  })

  it('reports a missing source cache without installing it', async () => {
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
    const git = sourceTreeGit([treeEntry('skills/selected/SKILL.md', 'selected-skill')])
    await expect(loadProjectionManifest(deps(git), root)).rejects.toThrow(
      'Source cache unavailable: https://example.test/skills.git',
    )

    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
    expect(git.readTree).not.toHaveBeenCalled()
  })
})

describe('projectRepository', () => {
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
  it('enriches configured members from the existing checkout without scanning the Git tree', async () => {
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
    expect(git.readTree).not.toHaveBeenCalled()
    expect(git.show).not.toHaveBeenCalled()
  })
})

function deps(git: IGit) {
  return {
    fs: new NodeFileSystem(),
    git,
    proc: { isCommandInstalled: async () => false },
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
