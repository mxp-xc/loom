import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition, AgentId, Manifest, ProjectionPlan } from '@loom/core'
import type { AgentPathContext } from '../src/adapters/paths.js'
import { builtinForAgent } from '../src/vars/agent-aware.js'
import { executeProjection } from '../src/projection/executor.js'
import { NodeFileSystem } from '../src/platform/node/fs.js'

const memoryOnlyAgent = 'memory-only' as AgentId
const memoryOnlyDefinition: AgentDefinition = {
  id: memoryOnlyAgent,
  display: {
    name: 'Memory Only',
    short: 'MO',
    color: '#000000',
    icon: { kind: 'text', text: 'M' },
  },
  command: 'memory-only',
  configDir: { fallback: { root: 'home', segments: ['.memory-only'] } },
  memory: { path: { root: 'config', segments: ['MEMORY.md'] } },
}

describe('partial-capability agents', () => {
  let home: string
  let pathContext: AgentPathContext

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-partial-agent-'))
    pathContext = {
      home,
      env: {},
      platform: process.platform,
      resolveAgent: () => memoryOnlyDefinition,
    }
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('builds Vars builtins without resolving unsupported capability paths', () => {
    expect(builtinForAgent(memoryOnlyAgent, pathContext)).toMatchObject({
      LOOM_CONFIG_DIR: { value: join(home, '.memory-only') },
      LOOM_SKILLS_DIR: { value: '' },
      LOOM_AGENT_FILE: { value: 'MEMORY.md' },
    })
  })

  it('projects memory without requiring the Skills capability', async () => {
    const manifest: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: {
        memories: [{ name: 'active' }],
        active: { name: 'active' },
        activeContent: 'skills=${LOOM_SKILLS_DIR} file=${LOOM_AGENT_FILE}',
      },
      vars: { default: {}, active: {} },
      config: { agents: [memoryOnlyAgent] },
      errors: [],
    }
    const plan: ProjectionPlan = {
      links: [],
      sourcePlans: [],
      mcpEntries: [],
      memoryPlan: {
        active: manifest.memory.active,
        content: manifest.memory.activeContent,
        agents: [memoryOnlyAgent],
      },
      skippedAgents: [],
      strategy: 'link',
    }

    const result = await executeProjection(
      plan,
      manifest,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs: new NodeFileSystem(),
        adapters: {},
        installedAgents: new Set([memoryOnlyAgent]),
        pathContext,
        resolveSkillSrc: () => null,
      },
      'memory',
    )

    expect(result).toEqual({ ok: true })
    expect(await readFile(join(home, '.memory-only', 'MEMORY.md'), 'utf8')).toBe(
      'skills= file=MEMORY.md',
    )
  })
})
