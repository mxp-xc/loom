import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentId, Manifest, ProjectionPlan, SourceProjectionPlan } from '@loom/core'
import { executeProjection, type ProjectionDeps } from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'

let home: string
let cacheRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'loom-source-namespace-home-'))
  cacheRoot = await mkdtemp(join(tmpdir(), 'loom-source-namespace-cache-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ])
})

const manifest: Manifest = {
  skills: { sources: [], skills: [] },
  mcp: [],
  memory: { memories: [], active: null, activeContent: '' },
  vars: { default: {}, active: {} },
  config: { agents: ['claude-code'] },
  errors: [],
}

function sourcePlan(overrides: Partial<SourceProjectionPlan> = {}): SourceProjectionPlan {
  return {
    sourceName: 'workflow-source',
    sourceUrl: 'https://example.com/workflow-source.git',
    cacheId: 'workflow-source',
    commit: 'commit-oid',
    agent: 'claude-code',
    projectionBase: '',
    entries: [],
    ...overrides,
  }
}

function projectionPlan(
  sourcePlans: SourceProjectionPlan[],
  strategy: 'link' | 'copy',
): ProjectionPlan {
  return {
    links: [],
    sourcePlans,
    mcpEntries: [],
    memoryPlan: { active: null, content: null, agents: [] },
    skippedAgents: [],
    strategy,
  }
}

function deps(resolveSourceRoot: ProjectionDeps['resolveSourceRoot']): ProjectionDeps {
  return {
    fs: new NodeFileSystem(),
    ownerRepo: 'owner-repo',
    adapters: {},
    installedAgents: new Set<AgentId>(['claude-code']),
    resolveSkillSrc: () => null,
    resolveSourceRoot,
    resolveSourceFiles: () => listSourceFiles(cacheRoot),
  }
}

async function listSourceFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const sourcePath = relative ? `${relative}/${entry.name}` : entry.name
    if (sourcePath === '.git' || sourcePath.startsWith('.git/')) continue
    if (entry.isDirectory()) files.push(...(await listSourceFiles(root, sourcePath)))
    else files.push(sourcePath)
  }
  return files
}

function sourceMarker(sourceUrl = 'https://example.com/workflow-source.git') {
  return {
    version: 1,
    managedBy: 'loom',
    kind: 'skill-source',
    ownerRepo: 'owner-repo',
    sourceKey: createHash('sha256').update(sourceUrl).digest('hex'),
    sourceName: 'workflow-source',
  }
}

describe('source namespace projection', () => {
  it('builds source transactions outside the agent skills discovery root', async () => {
    await mkdir(join(cacheRoot, 'skill'), { recursive: true })
    await writeFile(join(cacheRoot, 'skill', 'SKILL.md'), 'skill')
    const created: string[] = []
    class RecordingFileSystem extends NodeFileSystem {
      override async mkdir(path: string, recursive?: boolean): Promise<void> {
        created.push(path)
        await super.mkdir(path, recursive)
      }
    }
    const fs = new RecordingFileSystem()

    const result = await executeProjection(
      projectionPlan(
        [
          {
            ...sourcePlan(),
            entries: [{ kind: 'bundle', sourcePath: 'skill', targetPath: 'skill' }],
          },
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      { ...deps(() => cacheRoot), fs },
      'skills',
    )

    const skillsDir = join(home, '.claude', 'skills')
    expect(result).toEqual({ ok: true })
    expect(
      created.some((path) =>
        path.startsWith(join(home, '.claude', '.loom-projection-transactions')),
      ),
    ).toBe(true)
    expect(created.some((path) => path.startsWith(join(skillsDir, 'workflow-source.loom-')))).toBe(
      false,
    )
  })

  it('materializes a root bundle without copying Git metadata into the namespace', async () => {
    await mkdir(join(cacheRoot, '.git'), { recursive: true })
    await mkdir(join(cacheRoot, 'references'), { recursive: true })
    await writeFile(join(cacheRoot, '.git', 'config'), 'private cache metadata')
    await writeFile(join(cacheRoot, 'SKILL.md'), 'root bundle')
    await writeFile(join(cacheRoot, 'references', 'guide.md'), 'guide')

    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [{ kind: 'bundle', sourcePath: '', targetPath: '' }],
          }),
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      deps(() => cacheRoot),
      'skills',
    )

    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    expect(result).toEqual({ ok: true })
    expect(await readFile(join(namespace, 'SKILL.md'), 'utf8')).toBe('root bundle')
    expect(await readFile(join(namespace, 'references', 'guide.md'), 'utf8')).toBe('guide')
    await expect(readFile(join(namespace, '.git', 'config'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('preserves selected root structure under the source namespace', async () => {
    await mkdir(join(cacheRoot, 'skill-dir1', 'shared'), { recursive: true })
    await mkdir(join(cacheRoot, 'skill-dir2', 'shared'), { recursive: true })
    await mkdir(join(cacheRoot, 'shared'), { recursive: true })
    await writeFile(join(cacheRoot, 'skill-dir1', 'SKILL.md'), 'one')
    await writeFile(join(cacheRoot, 'skill-dir1', 'shared', 'one.md'), 'one shared')
    await writeFile(join(cacheRoot, 'skill-dir2', 'SKILL.md'), 'two')
    await writeFile(join(cacheRoot, 'shared', 'workflow.md'), 'workflow')

    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [
              { kind: 'bundle', sourcePath: 'skill-dir1', targetPath: 'skill-dir1' },
              { kind: 'bundle', sourcePath: 'skill-dir2', targetPath: 'skill-dir2' },
              { kind: 'resource-directory', sourcePath: 'shared', targetPath: 'shared' },
            ],
          }),
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      deps(() => cacheRoot),
      'skills',
    )

    expect(result.ok).toBe(true)
    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    expect(await readFile(join(namespace, 'skill-dir1', 'shared', 'one.md'), 'utf8')).toBe(
      'one shared',
    )
    expect(await readFile(join(namespace, 'skill-dir2', 'SKILL.md'), 'utf8')).toBe('two')
    expect(await readFile(join(namespace, 'shared', 'workflow.md'), 'utf8')).toBe('workflow')
    expect(
      JSON.parse(await readFile(join(namespace, '.loom-projection.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      managedBy: 'loom',
      kind: 'skill-source',
      ownerRepo: 'owner-repo',
      sourceName: 'workflow-source',
    })
    expect(
      JSON.stringify(JSON.parse(await readFile(join(namespace, '.loom-projection.json'), 'utf8'))),
    ).not.toContain('https://')
  })

  it.each(['copy', 'link'] as const)(
    'materializes only tracked files for %s source directories',
    async (strategy) => {
      await mkdir(join(cacheRoot, 'skill', 'references'), { recursive: true })
      await mkdir(join(cacheRoot, 'shared'), { recursive: true })
      await writeFile(join(cacheRoot, 'skill', 'SKILL.md'), 'skill')
      await writeFile(join(cacheRoot, 'skill', 'references', 'tracked.md'), 'tracked')
      await writeFile(join(cacheRoot, 'skill', 'references', 'untracked.md'), 'untracked')
      await writeFile(join(cacheRoot, 'shared', 'tracked.md'), 'tracked')
      await writeFile(join(cacheRoot, 'shared', 'untracked.md'), 'untracked')

      const result = await executeProjection(
        projectionPlan(
          [
            sourcePlan({
              entries: [
                { kind: 'bundle', sourcePath: 'skill', targetPath: 'skill' },
                {
                  kind: 'resource-directory',
                  sourcePath: 'shared',
                  targetPath: 'shared',
                },
              ],
            }),
          ],
          strategy,
        ),
        manifest,
        { env: {}, activeProfile: {}, defaultProfile: {} },
        {
          ...deps(() => cacheRoot),
          resolveSourceFiles: async () => [
            'shared/tracked.md',
            'skill/SKILL.md',
            'skill/references/tracked.md',
          ],
        },
        'skills',
      )

      const namespace = join(home, '.claude', 'skills', 'workflow-source')
      const fs = new NodeFileSystem()
      expect(result).toEqual({ ok: true })
      expect(await fs.exists(join(namespace, 'skill', 'SKILL.md'))).toBe(true)
      expect(await fs.exists(join(namespace, 'skill', 'references', 'tracked.md'))).toBe(true)
      expect(await fs.exists(join(namespace, 'shared', 'tracked.md'))).toBe(true)
      expect(await fs.exists(join(namespace, 'skill', 'references', 'untracked.md'))).toBe(false)
      expect(await fs.exists(join(namespace, 'shared', 'untracked.md'))).toBe(false)
    },
  )

  it('links tracked files from directory and file roots when link strategy is selected', async () => {
    await mkdir(join(cacheRoot, 'skill'), { recursive: true })
    await writeFile(join(cacheRoot, 'skill', 'SKILL.md'), 'skill')
    await writeFile(join(cacheRoot, 'workflow.md'), 'workflow')
    const fs = new NodeFileSystem()
    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [
              { kind: 'bundle', sourcePath: 'skill', targetPath: 'skill' },
              { kind: 'resource-file', sourcePath: 'workflow.md', targetPath: 'workflow.md' },
            ],
          }),
        ],
        'link',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      { ...deps(() => cacheRoot), fs },
      'skills',
    )

    expect(result.ok).toBe(true)
    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    expect(await fs.isLink(join(namespace, 'skill'))).toBe(false)
    expect(await readFile(join(namespace, 'skill', 'SKILL.md'), 'utf8')).toBe('skill')
    expect(await readFile(join(namespace, 'workflow.md'), 'utf8')).toBe('workflow')
  })

  it.each(['.loom-projection.json', '.LOOM-PROJECTION.JSON'])(
    'rejects the reserved namespace ownership marker path %s',
    async (markerPath) => {
      const reservedResource = join(cacheRoot, markerPath)
      await writeFile(reservedResource, 'source-owned content')

      const result = await executeProjection(
        projectionPlan(
          [
            sourcePlan({
              entries: [
                {
                  kind: 'resource-file',
                  sourcePath: markerPath,
                  targetPath: markerPath,
                },
              ],
            }),
          ],
          'link',
        ),
        manifest,
        { env: {}, activeProfile: {}, defaultProfile: {} },
        deps(() => cacheRoot),
        'skills',
      )

      expect(result.ok).toBe(false)
      expect(await readFile(reservedResource, 'utf8')).toBe('source-owned content')
    },
  )

  it('does not overwrite an unmarked user-owned namespace', async () => {
    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'notes.md'), 'mine')
    await mkdir(join(cacheRoot, 'skill'), { recursive: true })
    await writeFile(join(cacheRoot, 'skill', 'SKILL.md'), 'skill')

    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [{ kind: 'bundle', sourcePath: 'skill', targetPath: 'skill' }],
          }),
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      deps(() => cacheRoot),
      'skills',
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(namespace, 'notes.md'), 'utf8')).toBe('mine')
  })

  it('fails before changing an existing namespace when the tracked resolver is unavailable', async () => {
    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'old.md'), 'old')
    await writeFile(join(namespace, '.loom-projection.json'), JSON.stringify(sourceMarker()))
    await mkdir(join(cacheRoot, 'skill'), { recursive: true })
    await writeFile(join(cacheRoot, 'skill', 'SKILL.md'), 'skill')
    const projectionDeps = deps(() => cacheRoot)
    delete projectionDeps.resolveSourceFiles

    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [{ kind: 'bundle', sourcePath: 'skill', targetPath: 'skill' }],
          }),
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      projectionDeps,
      'skills',
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(namespace, 'old.md'), 'utf8')).toBe('old')
    expect(await new NodeFileSystem().exists(join(namespace, 'skill'))).toBe(false)
  })

  it('restores a previous namespace when a later source replacement fails', async () => {
    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'old.md'), 'old')
    await writeFile(join(namespace, '.loom-projection.json'), JSON.stringify(sourceMarker()))
    await mkdir(join(cacheRoot, 'next'), { recursive: true })
    await writeFile(join(cacheRoot, 'next', 'SKILL.md'), 'next')

    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [{ kind: 'bundle', sourcePath: 'next', targetPath: 'next' }],
          }),
          sourcePlan({
            sourceName: 'broken-source',
            sourceUrl: 'https://example.com/broken.git',
            entries: [{ kind: 'bundle', sourcePath: 'missing', targetPath: 'missing' }],
          }),
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      deps(() => cacheRoot),
      'skills',
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(namespace, 'old.md'), 'utf8')).toBe('old')
    expect(await new NodeFileSystem().exists(join(namespace, 'next'))).toBe(false)
  })

  it('retries namespace restoration through the outer journal when the immediate restore fails', async () => {
    const namespace = join(home, '.claude', 'skills', 'workflow-source')
    await mkdir(namespace, { recursive: true })
    await writeFile(join(namespace, 'old.md'), 'old')
    await writeFile(join(namespace, '.loom-projection.json'), JSON.stringify(sourceMarker()))
    await mkdir(join(cacheRoot, 'next'), { recursive: true })
    await writeFile(join(cacheRoot, 'next', 'SKILL.md'), 'next')

    class FailingNamespaceSwapFileSystem extends NodeFileSystem {
      private stagingMoveFailed = false
      private immediateRestoreFailed = false

      override async move(src: string, dest: string): Promise<void> {
        if (src.includes('.loom-staging-')) {
          this.stagingMoveFailed = true
          throw new Error('simulated staging move failure')
        }
        if (
          this.stagingMoveFailed &&
          !this.immediateRestoreFailed &&
          src.includes('.loom-backup-')
        ) {
          this.immediateRestoreFailed = true
          throw new Error('simulated immediate restore failure')
        }
        await super.move(src, dest)
      }
    }

    const result = await executeProjection(
      projectionPlan(
        [
          sourcePlan({
            entries: [{ kind: 'bundle', sourcePath: 'next', targetPath: 'next' }],
          }),
        ],
        'copy',
      ),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      { ...deps(() => cacheRoot), fs: new FailingNamespaceSwapFileSystem() },
      'skills',
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(namespace, 'old.md'), 'utf8')).toBe('old')
  })

  it('removes orphaned managed namespaces but preserves unmarked directories', async () => {
    const skillsDir = join(home, '.claude', 'skills')
    const managed = join(skillsDir, 'old-source')
    const userOwned = join(skillsDir, 'user-source')
    await mkdir(managed, { recursive: true })
    await mkdir(userOwned, { recursive: true })
    await writeFile(
      join(managed, '.loom-projection.json'),
      JSON.stringify({ ...sourceMarker('https://example.com/old.git'), sourceName: 'old-source' }),
    )
    await writeFile(join(userOwned, 'notes.md'), 'mine')

    const result = await executeProjection(
      projectionPlan([], 'copy'),
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      deps(() => cacheRoot),
      'skills',
    )

    expect(result.ok).toBe(true)
    const fs = new NodeFileSystem()
    expect(await fs.exists(managed)).toBe(false)
    expect(await fs.exists(join(userOwned, 'notes.md'))).toBe(true)
  })
})
