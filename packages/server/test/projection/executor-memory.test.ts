import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeProjection } from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { planProjection } from '@loom/core'
import type { Manifest, AgentId } from '@loom/core'

describe('executeProjection memory phase', () => {
  let fs: NodeFileSystem
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-exec-'))
    fs = new NodeFileSystem()
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
    process.env.CODEX_HOME = join(home, 'codex')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CODEX_HOME
  })

  const buildPlan = (mf: Manifest, agents: AgentId[]) =>
    planProjection(mf, mf.config, new Set(agents))

  it('scope=memory writes rendered memory to agent files', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: {
        memories: [{ name: 'v1' }],
        active: { name: 'v1' },
        activeContent: 'agent=${LOOM_AGENT} file=${LOOM_AGENT_FILE} dir=${LOOM_CONFIG_DIR}',
      },
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code', 'codex'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code', 'codex'])
    const varsCtx = {
      env: { LOOM_AGENT: 'x', LOOM_CONFIG_DIR: 'x', LOOM_SKILLS_DIR: 'x', LOOM_AGENT_FILE: 'x' },
      activeProfile: {},
      defaultProfile: {},
    }
    const res = await executeProjection(
      plan,
      mf,
      varsCtx,
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code', 'codex']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )
    expect(res.ok).toBe(true)
    const cc = readFileSync(join(home, 'claude', 'CLAUDE.md'), 'utf8')
    const cx = readFileSync(join(home, 'codex', 'AGENTS.md'), 'utf8')
    expect(cc).toContain('agent=claude-code file=CLAUDE.md')
    expect(cx).toContain('agent=codex file=AGENTS.md')
  })

  it('scope=memory skips when no active memory', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [], active: null, activeContent: '' },
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code'])
    const res = await executeProjection(
      plan,
      mf,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(home, 'claude', 'CLAUDE.md'))).toBe(false)
  })

  it('scope=skills does NOT write memory files', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: 'x' },
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code'])
    const res = await executeProjection(
      plan,
      mf,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code']),
        resolveSkillSrc: () => null,
      },
      'skills',
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(home, 'claude', 'CLAUDE.md'))).toBe(false)
  })
})
