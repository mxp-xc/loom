import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentId, Manifest, ProjectionPlan } from '@loom/core'
import { GenericMcpAdapter } from '../../src/adapters/mcp.js'
import { agentMcpFile, type AgentPathContext } from '../../src/adapters/paths.js'
import {
  executeProjection,
  type ManagedSkillArtifacts,
  type ProjectionDeps,
} from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'

let home: string
let sourceRoot: string
let outside: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'loom-projection-boundary-home-'))
  sourceRoot = await mkdtemp(join(tmpdir(), 'loom-projection-boundary-source-'))
  outside = await mkdtemp(join(tmpdir(), 'loom-projection-boundary-outside-'))
  await mkdir(join(sourceRoot, 'skill'), { recursive: true })
  await writeFile(join(sourceRoot, 'skill', 'SKILL.md'), 'original')
})

afterEach(async () => {
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(sourceRoot, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ])
})

const varsCtx = { env: {}, activeProfile: {}, defaultProfile: {} }

function pathContext(env: Record<string, string | undefined> = {}): AgentPathContext {
  return { home, env, platform: process.platform }
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    skills: { sources: [], skills: [{ id: 'skill' }] },
    mcp: [],
    memory: { memories: [], active: null, activeContent: '' },
    vars: { default: {}, active: {} },
    config: { agents: ['codex'] },
    errors: [],
    ...overrides,
  }
}

function skillPlan(agent: AgentId, strategy: 'link' | 'copy' = 'link'): ProjectionPlan {
  return {
    links: [{ skillId: 'skill', source: 'local', agents: [agent] }],
    sourcePlans: [],
    mcpEntries: [],
    memoryPlan: { active: null, content: null, agents: [] },
    skippedAgents: [],
    strategy,
  }
}

function deps(
  agent: AgentId,
  context: AgentPathContext,
  overrides: Partial<ProjectionDeps> = {},
): ProjectionDeps {
  return {
    fs: new NodeFileSystem(),
    adapters: {},
    installedAgents: new Set([agent]),
    pathContext: context,
    resolveSkillSrc: () => join(sourceRoot, 'skill'),
    ...overrides,
  }
}

describe('projection filesystem boundary', () => {
  it('rejects an OpenCode .config ancestor link without writing through it', async () => {
    await symlink(outside, join(home, '.config'), 'dir')
    const context = pathContext()

    const result = await executeProjection(
      skillPlan('opencode'),
      manifest({ config: { agents: ['opencode'] } }),
      varsCtx,
      deps('opencode', context),
      'skills',
    )

    expect(result.ok).toBe(false)
    await expect(
      readFile(join(outside, 'opencode', 'skills', 'skill', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['copy', 'link'] as const)(
    'rejects a nested local source link before agent writes for %s strategy',
    async (strategy) => {
      const secret = join(outside, 'secret.txt')
      await writeFile(secret, 'outside secret')
      await symlink(secret, join(sourceRoot, 'skill', 'secret.txt'))
      const context = pathContext({ CODEX_HOME: join(home, 'codex') })

      const result = await executeProjection(
        skillPlan('codex', strategy),
        manifest(),
        varsCtx,
        deps('codex', context),
        'skills',
      )

      expect(result.ok).toBe(false)
      await expect(
        readFile(join(home, 'codex', 'skills', 'skill', 'SKILL.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(secret, 'utf8')).toBe('outside secret')
    },
  )

  it.each(['copy', 'link'] as const)(
    'rejects a hardlinked local source file before agent writes for %s strategy',
    async (strategy) => {
      const sourceFile = join(sourceRoot, 'skill', 'SKILL.md')
      const sentinel = join(outside, 'SKILL.md')
      await rm(sourceFile)
      await writeFile(sentinel, 'outside content')
      await link(sentinel, sourceFile)
      const context = pathContext({ CODEX_HOME: join(home, 'codex') })

      const result = await executeProjection(
        skillPlan('codex', strategy),
        manifest(),
        varsCtx,
        deps('codex', context),
        'skills',
      )

      expect(result.ok).toBe(false)
      await expect(
        readFile(join(home, 'codex', 'skills', 'skill', 'SKILL.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(sentinel, 'utf8')).toBe('outside content')
    },
  )

  it('copies a local source through stable no-follow file operations', async () => {
    class NoRecursiveCopyFileSystem extends NodeFileSystem {
      override async copyDir(): Promise<void> {
        throw new Error('recursive copy is not authorized')
      }
    }

    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const result = await executeProjection(
      skillPlan('codex', 'copy'),
      manifest(),
      varsCtx,
      deps('codex', context, { fs: new NoRecursiveCopyFileSystem() }),
      'skills',
    )

    expect(result.ok).toBe(true)
    expect(await readFile(join(home, 'codex', 'skills', 'skill', 'SKILL.md'), 'utf8')).toBe(
      'original',
    )
  })

  it('rejects a relative agent override before creating its destination', async () => {
    const context = pathContext({ CODEX_HOME: 'relative-codex-home' })
    const result = await executeProjection(
      skillPlan('codex'),
      manifest(),
      varsCtx,
      deps('codex', context),
      'skills',
    )

    expect(result.ok).toBe(false)
  })

  it('does not create through a missing agent root that becomes a link', async () => {
    const codexHome = join(home, 'codex')
    class RacingAncestorFileSystem extends NodeFileSystem {
      private raced = false

      override async mkdir(path: string, recursive?: boolean): Promise<void> {
        if (!this.raced && path === codexHome) {
          this.raced = true
          await symlink(outside, path, 'dir')
        }
        await super.mkdir(path, recursive)
      }
    }

    const context = pathContext({ CODEX_HOME: codexHome })
    const result = await executeProjection(
      skillPlan('codex', 'copy'),
      manifest(),
      varsCtx,
      deps('codex', context, { fs: new RacingAncestorFileSystem() }),
      'skills',
    )

    expect(result.ok).toBe(false)
    await expect(readFile(join(outside, 'skills', 'skill', 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('atomically replaces an MCP hardlink without modifying the external inode', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const file = agentMcpFile('codex', context)
    const sentinel = join(outside, 'config.toml')
    const original = '[mcp_servers.existing]\ncommand = "old"\n'
    await mkdir(join(home, 'codex'), { recursive: true })
    await writeFile(sentinel, original)
    await link(sentinel, file)
    const plan: ProjectionPlan = {
      ...skillPlan('codex'),
      links: [],
      mcpEntries: [{ id: 'next', agents: ['codex'] }],
    }
    const mcpManifest = manifest({
      mcp: [{ id: 'next', type: 'stdio', command: 'next-command', agents: ['codex'] }],
    })

    const result = await executeProjection(
      plan,
      mcpManifest,
      varsCtx,
      deps('codex', context, {
        adapters: { codex: new GenericMcpAdapter('codex', file) },
      }),
      'mcp',
    )

    expect(result.ok).toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe(original)
    expect(await readFile(file, 'utf8')).toContain('next-command')
  })

  it('atomically replaces a memory hardlink without modifying the external inode', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const file = join(home, 'codex', 'AGENTS.md')
    const sentinel = join(outside, 'AGENTS.md')
    await mkdir(join(home, 'codex'), { recursive: true })
    await writeFile(sentinel, 'external memory')
    await link(sentinel, file)
    const memory = { name: 'project-memory' }
    const plan: ProjectionPlan = {
      ...skillPlan('codex'),
      links: [],
      memoryPlan: {
        entries: [{ memory, content: 'projected memory', agents: ['codex'] }],
        active: memory,
        content: 'projected memory',
        agents: ['codex'],
      },
    }

    const result = await executeProjection(
      plan,
      manifest({
        memory: { memories: [memory], active: memory, activeContent: 'projected memory' },
      }),
      varsCtx,
      deps('codex', context),
      'memory',
    )

    expect(result.ok).toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe('external memory')
    expect(await readFile(file, 'utf8')).toBe('projected memory')
  })

  it('fails an enabled user-owned collision before a later MCP write', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const destination = join(home, 'codex', 'skills', 'skill')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'mine.txt'), 'mine')
    const file = agentMcpFile('codex', context)
    const plan: ProjectionPlan = {
      ...skillPlan('codex'),
      mcpEntries: [{ id: 'next', agents: ['codex'] }],
    }

    const result = await executeProjection(
      plan,
      manifest({
        mcp: [{ id: 'next', type: 'stdio', command: 'next-command', agents: ['codex'] }],
      }),
      varsCtx,
      deps('codex', context, {
        adapters: { codex: new GenericMcpAdapter('codex', file) },
      }),
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not replace a destination that appears while installing a local skill', async () => {
    class RacingDestinationFileSystem extends NodeFileSystem {
      private raced = false

      override async moveNoReplace(src: string, dest: string, expectedIdentity?: string) {
        if (!this.raced && src.includes('.loom-staging-')) {
          this.raced = true
          await mkdir(dest, { recursive: true })
          await writeFile(join(dest, 'mine.txt'), 'mine')
        }
        return super.moveNoReplace(src, dest, expectedIdentity)
      }
    }

    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const destination = join(home, 'codex', 'skills', 'skill')
    const result = await executeProjection(
      skillPlan('codex', 'copy'),
      manifest(),
      varsCtx,
      deps('codex', context, { fs: new RacingDestinationFileSystem() }),
      'skills',
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine')
  })

  it('preserves a user replacement that appears before rollback', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const destination = join(home, 'codex', 'skills', 'skill')
    const file = agentMcpFile('codex', context)
    class ReplacingAdapter extends GenericMcpAdapter {
      override async writeMcp(): Promise<void> {
        await rename(destination, `${destination}.projected`)
        await mkdir(destination)
        await writeFile(join(destination, 'mine.txt'), 'mine')
        throw new Error('simulated later projection failure')
      }
    }
    const plan: ProjectionPlan = {
      ...skillPlan('codex', 'copy'),
      mcpEntries: [{ id: 'next', agents: ['codex'] }],
    }

    const result = await executeProjection(
      plan,
      manifest({
        mcp: [{ id: 'next', type: 'stdio', command: 'next-command', agents: ['codex'] }],
      }),
      varsCtx,
      deps('codex', context, {
        adapters: { codex: new ReplacingAdapter('codex', file) },
      }),
    )

    expect(result.ok).toBe(false)
    expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine')
    if (!result.ok) {
      expect(result.failure.rollbackReport.rollbackFailures).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: destination })]),
      )
    }
  })

  it('restores managed MCP state when its setter fails after writing', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const file = agentMcpFile('codex', context)
    let managedIds = ['previous']
    const plan: ProjectionPlan = {
      ...skillPlan('codex'),
      links: [],
      mcpEntries: [{ id: 'next', agents: ['codex'] }],
    }

    const result = await executeProjection(
      plan,
      manifest({
        mcp: [{ id: 'next', type: 'stdio', command: 'next-command', agents: ['codex'] }],
      }),
      varsCtx,
      deps('codex', context, {
        adapters: { codex: new GenericMcpAdapter('codex', file) },
        getManagedMcpIds: async () => new Set(managedIds),
        setManagedMcpIds: async (_agent, ids) => {
          managedIds = [...ids]
          if (ids.includes('next')) throw new Error('managed MCP state write failed')
        },
      }),
      'mcp',
    )

    expect(result.ok).toBe(false)
    expect(managedIds).toEqual(['previous'])
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores managed skill state when its setter fails after writing', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const destination = join(home, 'codex', 'skills', 'skill')
    let artifacts: ManagedSkillArtifacts = {}

    const result = await executeProjection(
      skillPlan('codex'),
      manifest(),
      varsCtx,
      deps('codex', context, {
        ownerRepo: 'owner-repo',
        getManagedSkillArtifacts: async () => structuredClone(artifacts),
        setManagedSkillArtifacts: async (next) => {
          artifacts = structuredClone(next)
          if (artifacts.codex?.skill) throw new Error('managed skill state write failed')
        },
      }),
      'skills',
    )

    expect(result.ok).toBe(false)
    expect(artifacts).toEqual({})
    await expect(readFile(join(destination, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps skill parents available until a later failure can restore a removed artifact', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const destination = join(home, 'codex', 'skills', 'skill')
    const file = agentMcpFile('codex', context)
    let artifacts: ManagedSkillArtifacts = {}
    const projectionDeps = deps('codex', context, {
      ownerRepo: 'owner-repo',
      getManagedSkillArtifacts: async () => structuredClone(artifacts),
      setManagedSkillArtifacts: async (next) => {
        artifacts = structuredClone(next)
      },
    })
    expect(
      (await executeProjection(skillPlan('codex'), manifest(), varsCtx, projectionDeps, 'skills'))
        .ok,
    ).toBe(true)
    const previousArtifacts = structuredClone(artifacts)
    class FailingAdapter extends GenericMcpAdapter {
      override async writeMcp(): Promise<void> {
        throw new Error('later MCP write failed')
      }
    }
    projectionDeps.adapters = { codex: new FailingAdapter('codex', file) }
    const removalPlan: ProjectionPlan = {
      ...skillPlan('codex'),
      links: [],
      mcpEntries: [{ id: 'next', agents: ['codex'] }],
    }

    const result = await executeProjection(
      removalPlan,
      manifest({
        skills: { sources: [], skills: [] },
        mcp: [{ id: 'next', type: 'stdio', command: 'next-command', agents: ['codex'] }],
      }),
      varsCtx,
      projectionDeps,
    )

    expect(result.ok).toBe(false)
    expect(await projectionDeps.fs.isLink(destination)).toBe(true)
    expect(artifacts).toEqual(previousArtifacts)
  })

  it('preserves a managed destination and ledger while its desired source is unavailable', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    let artifacts: ManagedSkillArtifacts = {}
    const projectionDeps = deps('codex', context, {
      ownerRepo: 'owner-repo',
      getManagedSkillArtifacts: async () => structuredClone(artifacts),
      setManagedSkillArtifacts: async (next) => {
        artifacts = structuredClone(next)
      },
    })
    const plan = skillPlan('codex')
    const first = await executeProjection(plan, manifest(), varsCtx, projectionDeps, 'skills')
    const destination = join(home, 'codex', 'skills', 'skill')
    const previousArtifacts = structuredClone(artifacts)
    await rm(join(sourceRoot, 'skill'), { recursive: true })
    projectionDeps.resolveSkillSrc = () => null

    const second = await executeProjection(plan, manifest(), varsCtx, projectionDeps, 'skills')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.warnings?.[0]?.code).toBe('source-unavailable')
    expect(await projectionDeps.fs.isLink(destination)).toBe(true)
    expect(artifacts).toEqual(previousArtifacts)
  })

  it('fails when an unavailable desired source has drifted to a user-owned destination', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    let artifacts: ManagedSkillArtifacts = {}
    const projectionDeps = deps('codex', context, {
      ownerRepo: 'owner-repo',
      getManagedSkillArtifacts: async () => structuredClone(artifacts),
      setManagedSkillArtifacts: async (next) => {
        artifacts = structuredClone(next)
      },
    })
    const plan = skillPlan('codex')
    expect((await executeProjection(plan, manifest(), varsCtx, projectionDeps, 'skills')).ok).toBe(
      true,
    )
    const destination = join(home, 'codex', 'skills', 'skill')
    await rm(destination)
    await mkdir(destination)
    await writeFile(join(destination, 'mine.txt'), 'mine')
    projectionDeps.resolveSkillSrc = () => null

    const result = await executeProjection(plan, manifest(), varsCtx, projectionDeps, 'skills')

    expect(result.ok).toBe(false)
    expect(await readFile(join(destination, 'mine.txt'), 'utf8')).toBe('mine')
  })

  it('rejects a local source root replacement after preflight without projecting replacement data', async () => {
    const context = pathContext({ CODEX_HOME: join(home, 'codex') })
    const file = agentMcpFile('codex', context)
    let swapped = false
    class SwappingAdapter extends GenericMcpAdapter {
      override async readMcp(): Promise<Record<string, never>> {
        if (!swapped) {
          swapped = true
          await rename(join(sourceRoot, 'skill'), join(sourceRoot, 'original-skill'))
          await mkdir(join(sourceRoot, 'skill'))
          await writeFile(join(sourceRoot, 'skill', 'SKILL.md'), 'replacement')
        }
        return {}
      }
    }
    const plan: ProjectionPlan = {
      ...skillPlan('codex'),
      mcpEntries: [{ id: 'next', agents: ['codex'] }],
    }

    const result = await executeProjection(
      plan,
      manifest({
        mcp: [{ id: 'next', type: 'stdio', command: 'next-command', agents: ['codex'] }],
      }),
      varsCtx,
      deps('codex', context, { adapters: { codex: new SwappingAdapter('codex', file) } }),
    )

    expect(result.ok).toBe(false)
    await expect(
      readFile(join(home, 'codex', 'skills', 'skill', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
