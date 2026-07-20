import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { executeProjection } from '../../src/projection/executor'
import { createProjectionDeps } from '../../src/projection/deps'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { GenericMcpAdapter } from '../../src/adapters/mcp'
import { agentMcpFile } from '../../src/adapters/paths'
import {
  resolveLayeredVars,
  type ProjectionPlan,
  type SourceProjectionPlan,
  type Manifest,
  type AgentId,
} from '@loom/core'

const projectionLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(async () => {}),
}))

vi.mock('../../src/lib/logger.js', () => ({
  logger: { ...projectionLog, child: vi.fn(() => projectionLog) },
}))

let home: string
let srcDir: string
class ClaudeCodeAdapter extends GenericMcpAdapter {
  constructor() {
    super('claude-code', agentMcpFile('claude-code'))
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  srcDir = await mkdtemp(join(tmpdir(), 'src-'))
  await mkdir(join(srcDir, 'frontend-design'), { recursive: true })
  await writeFile(join(srcDir, 'frontend-design', 'SKILL.md'), 'x')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(srcDir, { recursive: true, force: true }),
  ])
})

const plan: ProjectionPlan = {
  links: [{ skillId: 'frontend-design', source: 'local', agents: ['claude-code'] }],
  sourcePlans: [],
  mcpEntries: [{ id: 'playwright', agents: ['claude-code'] }],
  memoryPlan: { active: null, content: null, agents: [] },
  skippedAgents: [],
  strategy: 'link',
}
const manifest: Manifest = {
  skills: { sources: [], skills: [{ id: 'frontend-design' }] },
  mcp: [{ id: 'playwright', type: 'stdio', command: 'npx', args: ['p'], agents: ['claude-code'] }],
  memory: { memories: [], active: null, activeContent: '' },
  vars: { default: {}, active: {} },
  config: { agents: ['claude-code'] },
  errors: [],
}
const varsCtx = { env: {}, activeProfile: {}, defaultProfile: {} }
const installed = new Set<AgentId>(['claude-code'])

describe('executeProjection', () => {
  it('success: builds skill links + writes MCP', async () => {
    const fs = new NodeFileSystem()
    const res = await executeProjection(plan, manifest, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(true)
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(true)
    expect(
      JSON.parse(await fs.readFile(join(home, '.claude.json'))).mcpServers.playwright.command,
    ).toBe('npx')
  })
  it('creates parent directories for source skill ids that include a repo prefix', async () => {
    const fs = new NodeFileSystem()
    const remoteSkillDir = join(srcDir, 'remote-member')
    await mkdir(remoteSkillDir, { recursive: true })
    await writeFile(join(remoteSkillDir, 'SKILL.md'), 'remote')
    const remotePlan: ProjectionPlan = {
      links: [
        {
          skillId: 'superpowers/finishing-a-development-branch',
          source: { repoId: 'superpowers', memberName: 'finishing-a-development-branch' },
          agents: ['claude-code'],
        },
      ],
      sourcePlans: [],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, agents: [] },
      skippedAgents: [],
      strategy: 'link',
    }

    const res = await executeProjection(remotePlan, { ...manifest, mcp: [] }, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => remoteSkillDir,
    })

    expect(res.ok).toBe(true)
    expect(
      await fs.exists(
        join(home, '.claude', 'skills', 'superpowers', 'finishing-a-development-branch'),
      ),
    ).toBe(true)
  })
  it('failure rolls back: removes built links + restores MCP backup', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'old' } } }),
    )
    const failing = new ClaudeCodeAdapter()
    failing.writeMcp = async () => {
      throw new Error('simulated write failure')
    }
    const res = await executeProjection(plan, manifest, varsCtx, {
      fs,
      adapters: { 'claude-code': failing },
      installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(false)
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(false)
    const mcp = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(mcp.mcpServers.existing.command).toBe('old')
    expect(mcp.mcpServers.playwright).toBeUndefined()
  })
  it('preserves a pre-existing link when managed ownership state is unavailable', async () => {
    const fs = new NodeFileSystem()
    await fs.mkdir(join(home, '.claude', 'skills'), true)
    await fs.createLink(
      join(srcDir, 'frontend-design'),
      join(home, '.claude', 'skills', 'frontend-design'),
    )
    expect(await fs.isLink(join(home, '.claude', 'skills', 'frontend-design'))).toBe(true)
    const disabledPlan: ProjectionPlan = {
      links: [{ skillId: 'frontend-design', source: 'local', agents: [] }],
      sourcePlans: [],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, agents: [] },
      skippedAgents: [],
      strategy: 'link',
    }
    const res = await executeProjection(disabledPlan, { ...manifest, mcp: [] }, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => null,
    })
    expect(res.ok).toBe(true)
    expect(await fs.isLink(join(home, '.claude', 'skills', 'frontend-design'))).toBe(true)
  })
  it('preserves a managed link whose target drifted and drops its stale ownership record', async () => {
    const fs = new NodeFileSystem()
    const destination = join(home, '.claude', 'skills', 'frontend-design')
    const driftedSource = join(srcDir, 'drifted-source')
    await mkdir(driftedSource, { recursive: true })
    await writeFile(join(driftedSource, 'SKILL.md'), 'drifted')
    await mkdir(dirname(destination), { recursive: true })
    await fs.createLink(driftedSource, destination)
    let managedArtifacts = {
      'claude-code': {
        'frontend-design': { kind: 'link' as const, source: join(srcDir, 'frontend-design') },
      },
    }
    const disabledPlan: ProjectionPlan = {
      ...plan,
      links: [{ ...plan.links[0], agents: [] }],
      mcpEntries: [],
    }

    const result = await executeProjection(disabledPlan, { ...manifest, mcp: [] }, varsCtx, {
      fs,
      ownerRepo: 'test-owner',
      adapters: {},
      installedAgents: installed,
      resolveSkillSrc: () => null,
      getManagedSkillArtifacts: async () => structuredClone(managedArtifacts),
      setManagedSkillArtifacts: async (next) => {
        managedArtifacts = structuredClone(next) as typeof managedArtifacts
      },
    })

    expect(result.ok).toBe(true)
    expect(await fs.isLink(destination)).toBe(true)
    expect(await fs.readLink(destination)).toBe(driftedSource)
    expect(managedArtifacts).toEqual({})
  })
  it('preflights every skill source before creating the first destination', async () => {
    const fs = new NodeFileSystem()
    const twoSkillPlan: ProjectionPlan = {
      ...plan,
      links: [plan.links[0], { skillId: 'second-skill', source: 'local', agents: ['claude-code'] }],
      mcpEntries: [],
    }

    const result = await executeProjection(twoSkillPlan, { ...manifest, mcp: [] }, varsCtx, {
      fs,
      adapters: {},
      installedAgents: installed,
      resolveSkillSrc: (link) => {
        if (link.skillId === 'second-skill') throw new Error('second source is invalid')
        return join(srcDir, 'frontend-design')
      },
    })

    expect(result.ok).toBe(false)
    expect(await fs.exists(join(home, '.claude'))).toBe(false)
  })
  it('rejects a linked agent config parent without writing through it', async () => {
    const fs = new NodeFileSystem()
    const outside = await mkdtemp(join(tmpdir(), 'projection-outside-'))
    try {
      await symlink(outside, join(home, '.claude'), 'dir')

      const result = await executeProjection(
        { ...plan, mcpEntries: [] },
        { ...manifest, mcp: [] },
        varsCtx,
        {
          fs,
          adapters: {},
          installedAgents: installed,
          resolveSkillSrc: () => join(srcDir, 'frontend-design'),
        },
      )

      expect(result.ok).toBe(false)
      expect(await fs.exists(join(outside, 'skills'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
  it('marks link fallback copies and removes them only with matching ownership state', async () => {
    const fs = new NodeFileSystem({ forceLinkError: 'EPERM' })
    const destination = join(home, '.claude', 'skills', 'frontend-design')
    let managedArtifacts = {}
    const projectionDeps = {
      fs,
      ownerRepo: 'test-owner',
      adapters: {},
      installedAgents: installed,
      resolveSkillSrc: () => join(srcDir, 'frontend-design'),
      getManagedSkillArtifacts: async () => structuredClone(managedArtifacts),
      setManagedSkillArtifacts: async (next: typeof managedArtifacts) => {
        managedArtifacts = structuredClone(next)
      },
    }

    const created = await executeProjection(
      { ...plan, mcpEntries: [] },
      { ...manifest, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(created.ok).toBe(true)
    expect(await fs.isLink(destination)).toBe(false)
    expect(JSON.parse(await fs.readFile(join(destination, '.loom-projection.json')))).toMatchObject(
      {
        version: 1,
        managedBy: 'loom',
        kind: 'local-skill',
        ownerRepo: 'test-owner',
        skillId: 'frontend-design',
      },
    )

    const removed = await executeProjection(
      { ...plan, links: [{ ...plan.links[0], agents: [] }], mcpEntries: [] },
      { ...manifest, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(removed.ok).toBe(true)
    expect(await fs.exists(destination)).toBe(false)
  })

  it.each([
    ['wrong owner', { ownerRepo: 'other-owner' }],
    ['wrong skill id', { skillId: 'other-skill' }],
    ['wrong manager', { managedBy: 'other-tool' }],
  ])('preserves a managed copy with a %s marker and records the mismatch', async (_name, patch) => {
    const fs = new NodeFileSystem({ forceLinkError: 'EPERM' })
    const destination = join(home, '.claude', 'skills', 'frontend-design')
    const markerPath = join(destination, '.loom-projection.json')
    let managedArtifacts = {}
    const warn = vi.fn()
    const projectionDeps = {
      fs,
      ownerRepo: 'test-owner',
      adapters: {},
      installedAgents: installed,
      resolveSkillSrc: () => join(srcDir, 'frontend-design'),
      getManagedSkillArtifacts: async () => structuredClone(managedArtifacts),
      setManagedSkillArtifacts: async (next: typeof managedArtifacts) => {
        managedArtifacts = structuredClone(next)
      },
      logger: { error: vi.fn(), warn },
    }
    expect(
      (
        await executeProjection(
          { ...plan, mcpEntries: [] },
          { ...manifest, mcp: [] },
          varsCtx,
          projectionDeps,
        )
      ).ok,
    ).toBe(true)
    const marker = JSON.parse(await fs.readFile(markerPath)) as Record<string, unknown>
    await fs.writeFile(markerPath, JSON.stringify({ ...marker, ...patch }))

    const result = await executeProjection(
      { ...plan, links: [], mcpEntries: [] },
      { ...manifest, skills: { sources: [], skills: [] }, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(result.ok).toBe(true)
    expect(await fs.exists(destination)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      'managed skill ownership marker identity mismatch',
      expect.objectContaining({ destination, markerPath }),
    )
  })

  it('preserves a managed copy with malformed marker JSON and logs the parse error', async () => {
    const fs = new NodeFileSystem({ forceLinkError: 'EPERM' })
    const destination = join(home, '.claude', 'skills', 'frontend-design')
    const markerPath = join(destination, '.loom-projection.json')
    let managedArtifacts = {}
    const error = vi.fn()
    const projectionDeps = {
      fs,
      ownerRepo: 'test-owner',
      adapters: {},
      installedAgents: installed,
      resolveSkillSrc: () => join(srcDir, 'frontend-design'),
      getManagedSkillArtifacts: async () => structuredClone(managedArtifacts),
      setManagedSkillArtifacts: async (next: typeof managedArtifacts) => {
        managedArtifacts = structuredClone(next)
      },
      logger: { error, warn: vi.fn() },
    }
    expect(
      (
        await executeProjection(
          { ...plan, mcpEntries: [] },
          { ...manifest, mcp: [] },
          varsCtx,
          projectionDeps,
        )
      ).ok,
    ).toBe(true)
    await fs.writeFile(markerPath, '{')

    const result = await executeProjection(
      { ...plan, links: [], mcpEntries: [] },
      { ...manifest, skills: { sources: [], skills: [] }, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(result.ok).toBe(true)
    expect(await fs.exists(destination)).toBe(true)
    expect(error).toHaveBeenCalledWith(
      'failed to parse managed skill ownership marker',
      expect.objectContaining({ err: expect.any(SyntaxError), destination, markerPath }),
    )
  })

  it('preserves a managed copy when its marker cannot be read and reports the full error', async () => {
    let failMarkerRead = false
    class MarkerReadFaultFileSystem extends NodeFileSystem {
      override async readFile(path: string): Promise<string> {
        if (failMarkerRead && path.endsWith('.loom-projection.json')) {
          throw Object.assign(new Error('marker read failed'), { code: 'EACCES' })
        }
        return super.readFile(path)
      }
    }
    const fs = new MarkerReadFaultFileSystem({ forceLinkError: 'EPERM' })
    const destination = join(home, '.claude', 'skills', 'frontend-design')
    let managedArtifacts = {}
    const error = vi.fn()
    const projectionDeps = {
      fs,
      ownerRepo: 'test-owner',
      adapters: {},
      installedAgents: installed,
      resolveSkillSrc: () => join(srcDir, 'frontend-design'),
      getManagedSkillArtifacts: async () => structuredClone(managedArtifacts),
      setManagedSkillArtifacts: async (next: typeof managedArtifacts) => {
        managedArtifacts = structuredClone(next)
      },
      logger: { error, warn: vi.fn() },
    }
    expect(
      (
        await executeProjection(
          { ...plan, mcpEntries: [] },
          { ...manifest, mcp: [] },
          varsCtx,
          projectionDeps,
        )
      ).ok,
    ).toBe(true)
    failMarkerRead = true

    const result = await executeProjection(
      { ...plan, links: [], mcpEntries: [] },
      { ...manifest, skills: { sources: [], skills: [] }, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(result.ok).toBe(false)
    expect(await fs.exists(destination)).toBe(true)
    expect(error).toHaveBeenCalledWith(
      'projection failed, rolled back',
      expect.objectContaining({ err: expect.objectContaining({ message: 'marker read failed' }) }),
    )
  })
  it('mcp var resolve failure: fails projection instead of silently skipping the entry', async () => {
    const fs = new NodeFileSystem()
    const manifestUndef: Manifest = {
      ...manifest,
      mcp: [
        { id: 'broken', type: 'stdio', command: '${NOPE}', agents: ['claude-code'] },
        { id: 'ok', type: 'stdio', command: 'npx', agents: ['claude-code'] },
      ],
    }
    const planUndef: ProjectionPlan = {
      links: [],
      sourcePlans: [],
      mcpEntries: [
        { id: 'broken', agents: ['claude-code'] },
        { id: 'ok', agents: ['claude-code'] },
      ],
      memoryPlan: { active: null, content: null, agents: [] },
      skippedAgents: [],
      strategy: 'link',
    }
    const logs: string[] = []
    const res = await executeProjection(planUndef, manifestUndef, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => null,
      logger: { error: (_message, context) => logs.push(JSON.stringify(context)), warn: () => {} },
    })
    expect(res.ok).toBe(false)
    await expect(fs.readFile(join(home, '.claude.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(logs.some((l) => l.includes('broken'))).toBe(true)
  })

  it('mcp uses the agent-aware resolver when provided', async () => {
    const fs = new NodeFileSystem()
    const manifestVars: Manifest = {
      ...manifest,
      mcp: [{ id: 'playwright', type: 'stdio', command: '${command}', agents: ['claude-code'] }],
    }
    const res = await executeProjection(
      plan,
      manifestVars,
      {
        env: {},
        activeProfile: {},
        defaultProfile: {},
        resolveForAgent: async (agent: AgentId) =>
          resolveLayeredVars({
            agent,
            base: { command: { type: 'string', value: 'uvx' } },
          }),
      },
      {
        fs,
        adapters: { 'claude-code': new ClaudeCodeAdapter() },
        installedAgents: installed,
        resolveSkillSrc: () => null,
      },
      'mcp',
    )

    expect(res.ok).toBe(true)
    const mcp = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(mcp.mcpServers.playwright.command).toBe('uvx')
  })

  it('mcp projection fails instead of writing empty fragments when agent-aware resolver fails', async () => {
    const fs = new NodeFileSystem()
    const res = await executeProjection(
      plan,
      manifest,
      {
        env: {},
        activeProfile: {},
        defaultProfile: {},
        resolveForAgent: async (agent: AgentId) =>
          resolveLayeredVars({
            agent,
            base: { bad: { type: 'string', value: '${missing}' } },
          }),
      },
      {
        fs,
        adapters: { 'claude-code': new ClaudeCodeAdapter() },
        installedAgents: installed,
        resolveSkillSrc: () => null,
      },
      'mcp',
    )

    expect(res.ok).toBe(false)
    expect(await fs.exists(join(home, '.claude.json'))).toBe(false)
  })
  it('manifest errors: rejects projection before any IO', async () => {
    const fs = new NodeFileSystem()
    const badManifest: Manifest = { ...manifest, errors: ['mcp[0].command: required'] }
    const res = await executeProjection(plan, badManifest, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure.failedStep).toBe('manifest-invalid')
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(false)
  })
  it('strategy:copy copies skill dir (real dir, not link)', async () => {
    const fs = new NodeFileSystem()
    const copyPlan: ProjectionPlan = { ...plan, strategy: 'copy' }
    const res = await executeProjection(copyPlan, manifest, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(true)
    const dest = join(home, '.claude', 'skills', 'frontend-design')
    expect(await fs.isLink(dest)).toBe(false)
    expect(await fs.exists(join(dest, 'SKILL.md'))).toBe(true)
  })
  it('strategy:copy removes stale copied source members when agents are cleared', async () => {
    const fs = new NodeFileSystem()
    const remoteSkillDir = join(srcDir, 'remote-member')
    await mkdir(remoteSkillDir, { recursive: true })
    await writeFile(join(remoteSkillDir, 'SKILL.md'), 'remote')
    const sourcePlan: ProjectionPlan = {
      links: [
        {
          skillId: 'superpowers/executing-plans',
          source: { repoId: 'superpowers', memberName: 'executing-plans' },
          agents: ['claude-code'],
        },
      ],
      sourcePlans: [],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, agents: [] },
      skippedAgents: [],
      strategy: 'copy',
    }

    let managedArtifacts = {}
    const projectionDeps = {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => remoteSkillDir,
      ownerRepo: 'test-owner',
      getManagedSkillArtifacts: async () => structuredClone(managedArtifacts),
      setManagedSkillArtifacts: async (next: typeof managedArtifacts) => {
        managedArtifacts = structuredClone(next)
      },
    }
    const first = await executeProjection(
      sourcePlan,
      { ...manifest, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(first.ok).toBe(true)
    const dest = join(home, '.claude', 'skills', 'superpowers', 'executing-plans')
    expect(await fs.exists(join(dest, 'SKILL.md'))).toBe(true)

    const cleared = await executeProjection(
      { ...sourcePlan, links: [{ ...sourcePlan.links[0], agents: [] }] },
      { ...manifest, mcp: [] },
      varsCtx,
      projectionDeps,
    )

    expect(cleared.ok).toBe(true)
    expect(await fs.exists(dest)).toBe(false)
    expect(await fs.exists(join(home, '.claude', 'skills', 'superpowers'))).toBe(false)
    expect(await fs.exists(join(home, '.claude', 'skills'))).toBe(false)
  })
  it('projection deps resolve source skills from URL-derived cache id, not custom source name', async () => {
    const fs = new NodeFileSystem()
    const repoPath = join(srcDir, 'repo-with-cache')
    const cachedSkill = join(repoPath, 'remote-cache', 'superpowers', 'skills', 'brainstorming')
    await mkdir(cachedSkill, { recursive: true })
    await writeFile(join(cachedSkill, 'SKILL.md'), 'remote')
    const sourcePlan: ProjectionPlan = {
      links: [
        {
          skillId: 'openai-skills/brainstorming',
          source: { repoId: 'openai-skills', cacheId: 'superpowers', memberName: 'brainstorming' },
          agents: ['claude-code'],
        },
      ],
      sourcePlans: [],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, agents: [] },
      skippedAgents: [],
      strategy: 'copy',
    }

    const res = await executeProjection(
      sourcePlan,
      { ...manifest, mcp: [] },
      varsCtx,
      createProjectionDeps({ fs, git: {} as never, proc: {} as never }, repoPath, installed, home),
      'skills',
    )

    expect(res.ok).toBe(true)
    expect(
      await fs.exists(
        join(home, '.claude', 'skills', 'openai-skills', 'brainstorming', 'SKILL.md'),
      ),
    ).toBe(true)
  })
  it('projection deps read regular tracked files from the planned source commit', async () => {
    const fs = new NodeFileSystem()
    const repoPath = join(srcDir, 'repo-with-tracked-source')
    const cachePath = join(repoPath, 'remote-cache', 'superpowers')
    await mkdir(cachePath, { recursive: true })
    const revParseHead = vi.fn(async () => 'planned-commit')
    const readTree = vi.fn(async () => [
      { mode: '040000', type: 'tree' as const, oid: 'tree', path: 'skill' },
      { mode: '100644', type: 'blob' as const, oid: 'skill', path: 'skill/SKILL.md' },
      { mode: '120000', type: 'blob' as const, oid: 'link', path: 'skill/link.md' },
    ])
    const projectionDeps = createProjectionDeps(
      { fs, git: { revParseHead, readTree } as never, proc: {} as never },
      repoPath,
      installed,
      home,
    )
    const sourcePlan: SourceProjectionPlan = {
      sourceName: 'openai-skills',
      sourceUrl: 'https://example.test/superpowers.git',
      cacheId: 'superpowers',
      commit: 'planned-commit',
      agent: 'claude-code',
      projectionBase: '',
      entries: [],
    }

    await expect(projectionDeps.resolveSourceFiles?.(sourcePlan)).resolves.toEqual([
      'skill/SKILL.md',
    ])
    const canonicalCachePath = await fs.realPath(cachePath)
    expect(readTree).toHaveBeenCalledWith(canonicalCachePath, 'planned-commit')
    expect(revParseHead).toHaveBeenCalledWith(canonicalCachePath)
  })
  it('projection deps reject a cache checkout that differs from the planned commit', async () => {
    const fs = new NodeFileSystem()
    const repoPath = join(srcDir, 'repo-with-stale-source')
    await mkdir(join(repoPath, 'remote-cache', 'superpowers'), { recursive: true })
    const readTree = vi.fn()
    const projectionDeps = createProjectionDeps(
      {
        fs,
        git: { revParseHead: vi.fn(async () => 'other-commit'), readTree } as never,
        proc: {} as never,
      },
      repoPath,
      installed,
      home,
    )
    const sourcePlan: SourceProjectionPlan = {
      sourceName: 'openai-skills',
      sourceUrl: 'https://example.test/superpowers.git',
      cacheId: 'superpowers',
      commit: 'planned-commit',
      agent: 'claude-code',
      projectionBase: '',
      entries: [],
    }

    await expect(projectionDeps.resolveSourceFiles?.(sourcePlan)).rejects.toThrow(
      'Source cache checkout does not match planned commit: superpowers',
    )
    expect(readTree).not.toHaveBeenCalled()
  })
  it('rejects an injected source plan when the explicit cache authorization is empty', async () => {
    const fs = new NodeFileSystem()
    const repoPath = join(srcDir, 'repo-with-untrusted-cache')
    await mkdir(join(repoPath, 'remote-cache', 'superpowers'), { recursive: true })
    const inspectEntry = vi.spyOn(fs, 'inspectEntry')
    const revParseHead = vi.fn(async () => 'planned-commit')
    const readTree = vi.fn(async () => [])
    const projectionDeps = createProjectionDeps(
      { fs, git: { revParseHead, readTree } as never, proc: {} as never },
      repoPath,
      installed,
      home,
      new Map(),
      new Map(),
      new Map(),
    )
    const sourcePlan: SourceProjectionPlan = {
      sourceName: 'openai-skills',
      sourceUrl: 'https://example.test/superpowers.git',
      cacheId: 'superpowers',
      commit: 'planned-commit',
      agent: 'claude-code',
      projectionBase: '',
      entries: [],
    }

    expect(projectionDeps.resolveSourceRoot?.(sourcePlan)).toBeNull()
    await expect(projectionDeps.resolveSourceFiles?.(sourcePlan)).rejects.toThrow(
      'Source cache unavailable: https://example.test/superpowers.git',
    )
    expect(inspectEntry).not.toHaveBeenCalled()
    expect(revParseHead).not.toHaveBeenCalled()
    expect(readTree).not.toHaveBeenCalled()
  })
  it('strategy:copy keeps unmarked source-member directories during cleanup', async () => {
    const fs = new NodeFileSystem()
    const dest = join(home, '.claude', 'skills', 'superpowers', 'executing-plans')
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'SKILL.md'), 'user-owned legacy directory')
    const sourcePlan: ProjectionPlan = {
      links: [
        {
          skillId: 'superpowers/executing-plans',
          source: { repoId: 'superpowers', memberName: 'executing-plans' },
          agents: [],
        },
      ],
      sourcePlans: [],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, agents: [] },
      skippedAgents: [],
      strategy: 'copy',
    }

    const cleared = await executeProjection(sourcePlan, { ...manifest, mcp: [] }, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => null,
    })

    expect(cleared.ok).toBe(true)
    expect(await fs.exists(join(dest, 'SKILL.md'))).toBe(true)

    const orphaned = await executeProjection(
      { ...sourcePlan, links: [] },
      { ...manifest, mcp: [] },
      varsCtx,
      {
        fs,
        adapters: { 'claude-code': new ClaudeCodeAdapter() },
        installedAgents: installed,
        resolveSkillSrc: () => null,
      },
    )

    expect(orphaned.ok).toBe(true)
    expect(await fs.exists(join(dest, 'SKILL.md'))).toBe(true)
  })
  it('projection deps write managed state under explicit workflow home and repo identity', async () => {
    const fs = new NodeFileSystem()
    const explicitHome = await mkdtemp(join(tmpdir(), 'explicit-home-'))
    const envHome = await mkdtemp(join(tmpdir(), 'env-home-'))
    vi.stubEnv('HOME', envHome)
    try {
      const repoPath = join(srcDir, 'repo-for-state')
      const deps = createProjectionDeps(
        { fs, git: {} as never, proc: {} as never },
        repoPath,
        installed,
        explicitHome,
      )

      await deps.setManagedMcpIds?.('claude-code', ['playwright'])
      await deps.setManagedSkillArtifacts?.({
        'claude-code': {
          'frontend-design': {
            kind: 'link',
            source: join(srcDir, 'frontend-design'),
          },
        },
      })

      expect(
        await fs.exists(
          join(explicitHome, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json'),
        ),
      ).toBe(true)
      expect(
        await fs.exists(join(envHome, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json')),
      ).toBe(false)
      expect(
        JSON.parse(
          await fs.readFile(
            join(explicitHome, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json'),
          ),
        ),
      ).toEqual({
        version: 1,
        ownerRepo: deps.ownerRepo,
        agents: { 'claude-code': ['playwright'] },
      })
      expect(
        await fs.exists(
          join(explicitHome, '.loom', 'state', deps.ownerRepo!, 'projected-skills.json'),
        ),
      ).toBe(true)
      await expect(deps.getManagedSkillArtifacts?.()).resolves.toEqual({
        'claude-code': {
          'frontend-design': {
            kind: 'link',
            source: join(srcDir, 'frontend-design'),
          },
        },
      })
    } finally {
      await Promise.all([
        rm(explicitHome, { recursive: true, force: true }),
        rm(envHome, { recursive: true, force: true }),
      ])
    }
  })

  it('isolates managed MCP state for repositories with the same basename', async () => {
    const fs = new NodeFileSystem()
    const first = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      join(srcDir, 'first', 'default'),
      installed,
      home,
    )
    const second = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      join(srcDir, 'second', 'default'),
      installed,
      home,
    )

    await first.setManagedMcpIds?.('claude-code', ['first-only'])

    await expect(first.getManagedMcpIds?.('claude-code')).resolves.toEqual(new Set(['first-only']))
    await expect(second.getManagedMcpIds?.('claude-code')).resolves.toEqual(new Set())
    expect(first.ownerRepo).not.toBe(second.ownerRepo)
  })

  it('migrates legacy basename MCP state only for a canonical managed repository', async () => {
    const fs = new NodeFileSystem()
    const repoPath = join(home, '.loom', 'repos', 'default')
    const legacyState = join(home, '.loom', 'state', 'default', 'projected-mcp.json')
    await fs.mkdir(dirname(legacyState), true)
    await fs.writeFile(legacyState, JSON.stringify({ 'claude-code': ['legacy'] }))
    const deps = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      repoPath,
      installed,
      home,
    )

    await expect(deps.getManagedMcpIds?.('claude-code')).resolves.toEqual(new Set(['legacy']))

    const migratedState = join(home, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json')
    expect(await fs.exists(legacyState)).toBe(false)
    expect(JSON.parse(await fs.readFile(migratedState))).toEqual({
      version: 1,
      ownerRepo: deps.ownerRepo,
      agents: { 'claude-code': ['legacy'] },
    })
  })

  it('does not claim legacy basename MCP state for an external repository', async () => {
    const fs = new NodeFileSystem()
    const legacyState = join(home, '.loom', 'state', 'default', 'projected-mcp.json')
    await fs.mkdir(dirname(legacyState), true)
    await fs.writeFile(legacyState, JSON.stringify({ 'claude-code': ['legacy'] }))
    const deps = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      join(srcDir, 'external', 'default'),
      installed,
      home,
    )

    await expect(deps.getManagedMcpIds?.('claude-code')).resolves.toEqual(new Set())
    expect(await fs.exists(legacyState)).toBe(true)
  })

  it('preserves legacy MCP state when migration cannot install the identity state', async () => {
    class FailingMigrationFileSystem extends NodeFileSystem {
      override async replaceFileIfIdentity(
        tempPath: string,
        targetPath: string,
        expectedTargetIdentity: string | null,
      ) {
        if (targetPath.endsWith('projected-mcp.json')) {
          throw new Error('migration install failed')
        }
        return super.replaceFileIfIdentity(tempPath, targetPath, expectedTargetIdentity)
      }
    }
    const fs = new FailingMigrationFileSystem()
    const repoPath = join(home, '.loom', 'repos', 'default')
    const legacyState = join(home, '.loom', 'state', 'default', 'projected-mcp.json')
    await fs.mkdir(dirname(legacyState), true)
    await fs.writeFile(legacyState, JSON.stringify({ 'claude-code': ['legacy'] }))
    const deps = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      repoPath,
      installed,
      home,
    )

    await expect(deps.getManagedMcpIds?.('claude-code')).rejects.toThrow('migration install failed')
    expect(await fs.exists(legacyState)).toBe(true)
    expect(
      await fs.exists(join(home, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json')),
    ).toBe(false)
  })

  it('retries identity-bound legacy MCP state cleanup after a removal failure', async () => {
    const repoPath = join(home, '.loom', 'repos', 'default')
    const legacyState = join(home, '.loom', 'state', 'default', 'projected-mcp.json')
    let failLegacyRemoval = true
    class FailingLegacyCleanupFileSystem extends NodeFileSystem {
      override async removeEntryIfIdentity(path: string, expectedIdentity: string): Promise<void> {
        if (failLegacyRemoval && path === legacyState) {
          throw new Error('legacy cleanup failed')
        }
        await super.removeEntryIfIdentity(path, expectedIdentity)
      }
    }
    const fs = new FailingLegacyCleanupFileSystem()
    await fs.mkdir(dirname(legacyState), true)
    await fs.writeFile(legacyState, JSON.stringify({ 'claude-code': ['legacy'] }))
    const deps = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      repoPath,
      installed,
      home,
    )

    await expect(deps.getManagedMcpIds?.('claude-code')).rejects.toThrow('legacy cleanup failed')
    expect(await fs.exists(legacyState)).toBe(true)
    expect(
      await fs.exists(join(home, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json')),
    ).toBe(true)

    failLegacyRemoval = false
    await expect(deps.getManagedMcpIds?.('claude-code')).resolves.toEqual(new Set(['legacy']))
    expect(await fs.exists(legacyState)).toBe(false)
  })

  it('fails closed when managed MCP state has the wrong repository identity', async () => {
    const fs = new NodeFileSystem()
    const repoPath = join(srcDir, 'wrong-owner-state')
    const deps = createProjectionDeps(
      { fs, git: {} as never, proc: {} as never },
      repoPath,
      installed,
      home,
    )
    const stateFile = join(home, '.loom', 'state', deps.ownerRepo!, 'projected-mcp.json')
    await fs.mkdir(dirname(stateFile), true)
    await fs.writeFile(
      stateFile,
      JSON.stringify({ version: 1, ownerRepo: 'wrong-owner', agents: {} }),
    )

    await expect(deps.getManagedMcpIds?.('claude-code')).rejects.toThrow(
      'Managed MCP projection state identity is invalid',
    )
  })
})
