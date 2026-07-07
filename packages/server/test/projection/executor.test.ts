import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeProjection } from '../../src/projection/executor'
import { createProjectionDeps } from '../../src/projection/deps'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code'
import { resolveLayeredVars, type ProjectionPlan, type Manifest, type AgentId } from '@loom/core'

let home: string
let srcDir: string
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
  links: [{ skillId: 'frontend-design', source: 'local', targets: ['claude-code'] }],
  mcpEntries: [{ id: 'playwright', targets: ['claude-code'] }],
  memoryPlan: { active: null, content: null, targets: [] },
  skippedAgents: [],
  strategy: 'link',
}
const manifest: Manifest = {
  skills: { sources: [], skills: [{ id: 'frontend-design' }] },
  mcp: [{ id: 'playwright', type: 'stdio', command: 'npx', args: ['p'], targets: ['claude-code'] }],
  memory: { memories: [], active: null, activeContent: '' },
  vars: { default: {}, active: {} },
  config: { targets: ['claude-code'] },
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
          targets: ['claude-code'],
        },
      ],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, targets: [] },
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
  it('enabled:false member: cleans pre-existing link, does not build', async () => {
    const fs = new NodeFileSystem()
    await fs.mkdir(join(home, '.claude', 'skills'), true)
    await fs.createLink(
      join(srcDir, 'frontend-design'),
      join(home, '.claude', 'skills', 'frontend-design'),
    )
    expect(await fs.isLink(join(home, '.claude', 'skills', 'frontend-design'))).toBe(true)
    const disabledPlan: ProjectionPlan = {
      links: [{ skillId: 'frontend-design', source: 'local', targets: [] }],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, targets: [] },
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
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(false)
  })
  it('mcp var resolve failure: fails projection instead of silently skipping the entry', async () => {
    const fs = new NodeFileSystem()
    const manifestUndef: Manifest = {
      ...manifest,
      mcp: [
        { id: 'broken', type: 'stdio', command: '${NOPE}', targets: ['claude-code'] },
        { id: 'ok', type: 'stdio', command: 'npx', targets: ['claude-code'] },
      ],
    }
    const planUndef: ProjectionPlan = {
      links: [],
      mcpEntries: [
        { id: 'broken', targets: ['claude-code'] },
        { id: 'ok', targets: ['claude-code'] },
      ],
      memoryPlan: { active: null, content: null, targets: [] },
      skippedAgents: [],
      strategy: 'link',
    }
    const logs: string[] = []
    const res = await executeProjection(planUndef, manifestUndef, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => null,
      logger: { error: (o) => logs.push(JSON.stringify(o)), warn: () => {} },
    })
    expect(res.ok).toBe(false)
    await expect(fs.readFile(join(home, '.claude.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(logs.some((l) => l.includes('broken'))).toBe(true)
  })

  it('mcp uses the agent-aware resolver when provided', async () => {
    const fs = new NodeFileSystem()
    const manifestVars: Manifest = {
      ...manifest,
      mcp: [{ id: 'playwright', type: 'stdio', command: '${command}', targets: ['claude-code'] }],
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
  it('strategy:copy removes stale copied source members when targets are cleared', async () => {
    const fs = new NodeFileSystem()
    const remoteSkillDir = join(srcDir, 'remote-member')
    await mkdir(remoteSkillDir, { recursive: true })
    await writeFile(join(remoteSkillDir, 'SKILL.md'), 'remote')
    const sourcePlan: ProjectionPlan = {
      links: [
        {
          skillId: 'superpowers/executing-plans',
          source: { repoId: 'superpowers', memberName: 'executing-plans' },
          targets: ['claude-code'],
        },
      ],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, targets: [] },
      skippedAgents: [],
      strategy: 'copy',
    }

    const first = await executeProjection(sourcePlan, { ...manifest, mcp: [] }, varsCtx, {
      fs,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      installedAgents: installed,
      resolveSkillSrc: () => remoteSkillDir,
    })

    expect(first.ok).toBe(true)
    const dest = join(home, '.claude', 'skills', 'superpowers', 'executing-plans')
    expect(await fs.exists(join(dest, 'SKILL.md'))).toBe(true)

    const cleared = await executeProjection(
      { ...sourcePlan, links: [{ ...sourcePlan.links[0], targets: [] }] },
      { ...manifest, mcp: [] },
      varsCtx,
      {
        fs,
        adapters: { 'claude-code': new ClaudeCodeAdapter() },
        installedAgents: installed,
        resolveSkillSrc: () => remoteSkillDir,
      },
    )

    expect(cleared.ok).toBe(true)
    expect(await fs.exists(dest)).toBe(false)
    expect(await fs.exists(join(home, '.claude', 'skills', 'superpowers'))).toBe(false)
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
          targets: [],
        },
      ],
      mcpEntries: [],
      memoryPlan: { active: null, content: null, targets: [] },
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
  it('projection deps write managed MCP state under explicit workflow home', async () => {
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

      expect(
        await fs.exists(
          join(explicitHome, '.loom', 'state', 'repo-for-state', 'projected-mcp.json'),
        ),
      ).toBe(true)
      expect(
        await fs.exists(join(envHome, '.loom', 'state', 'repo-for-state', 'projected-mcp.json')),
      ).toBe(false)
    } finally {
      await Promise.all([
        rm(explicitHome, { recursive: true, force: true }),
        rm(envHome, { recursive: true, force: true }),
      ])
    }
  })
})
