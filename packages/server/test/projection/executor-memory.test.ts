import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeProjection } from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { planProjection, resolveLayeredVars } from '@loom/core'
import type { Manifest, AgentId } from '@loom/core'

describe('executeProjection memory phase', () => {
  let fs: NodeFileSystem
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-exec-'))
    fs = new NodeFileSystem()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'))
    vi.stubEnv('CODEX_HOME', join(home, 'codex'))
    vi.stubEnv('OPENCODE_CONFIG_DIR', join(home, 'opencode'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
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
      config: { agents: ['claude-code', 'codex'] },
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
      config: { agents: ['claude-code'] },
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

  it('writes each assigned memory only to its assigned agents', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: {
        memories: [
          { name: 'team', content: '# team rules', agents: ['codex'] },
          { name: 'personal', content: '# personal rules', agents: ['opencode'] },
        ],
        assignments: { codex: 'team', opencode: 'personal' },
        active: null,
        activeContent: '',
      },
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    }

    const res = await executeProjection(
      buildPlan(mf, ['codex', 'opencode']),
      mf,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['codex', 'opencode']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )

    expect(res.ok).toBe(true)
    expect(readFileSync(join(home, 'codex', 'AGENTS.md'), 'utf8')).toBe('# team rules')
    expect(readFileSync(join(home, 'opencode', 'AGENTS.md'), 'utf8')).toBe('# personal rules')
  })

  it('writes one memory to multiple assigned agents', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: {
        memories: [{ name: 'shared', content: '# shared', agents: ['codex', 'opencode'] }],
        assignments: { codex: 'shared', opencode: 'shared' },
        active: null,
        activeContent: '',
      },
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    }

    const res = await executeProjection(
      buildPlan(mf, ['codex', 'opencode']),
      mf,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['codex', 'opencode']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )

    expect(res.ok).toBe(true)
    expect(readFileSync(join(home, 'codex', 'AGENTS.md'), 'utf8')).toBe('# shared')
    expect(readFileSync(join(home, 'opencode', 'AGENTS.md'), 'utf8')).toBe('# shared')
  })

  it('scope=memory renders with the agent-aware resolver before writing agents', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: {
        memories: [{ name: 'v1' }],
        active: { name: 'v1' },
        activeContent: '# ${agent_name}\\n@${rtk}',
      },
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code', 'codex'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code', 'codex'])
    const varsCtx = {
      env: {},
      activeProfile: {},
      defaultProfile: {},
      resolveForAgent: async (agent: AgentId) =>
        resolveLayeredVars({
          agent,
          base: {
            agent_name: { type: 'string', value: 'Agent' },
            rtk: { type: 'string', format: 'path', value: '${LOOM_CONFIG_DIR}/RTK.md' },
          },
          baseAgent: agent === 'codex' ? { agent_name: { value: 'Codex' } } : {},
          local: { agent_name: { value: 'Local Agent' } },
          localAgent: agent === 'codex' ? { agent_name: { value: 'Local Codex' } } : {},
          builtin: {
            LOOM_CONFIG_DIR: {
              type: 'string',
              format: 'path',
              value: agent === 'codex' ? join(home, 'codex') : join(home, 'claude'),
            },
            LOOM_AGENT: { type: 'string', value: agent },
            LOOM_PROFILE: { type: 'string', value: 'base' },
            LOOM_SKILLS_DIR: { type: 'string', format: 'path', value: '' },
            LOOM_AGENT_FILE: {
              type: 'string',
              value: agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
            },
          },
        }),
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
    expect(readFileSync(join(home, 'claude', 'CLAUDE.md'), 'utf8')).toContain('# Local Agent')
    expect(readFileSync(join(home, 'codex', 'AGENTS.md'), 'utf8')).toContain('# Local Codex')
  })

  it('scope=memory writes nothing when any agent render fails', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: '${missing}' },
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code', 'codex'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code', 'codex'])
    const res = await executeProjection(
      plan,
      mf,
      {
        env: {},
        activeProfile: {},
        defaultProfile: {},
        resolveForAgent: async (agent: AgentId) =>
          resolveLayeredVars({ agent, base: { ok: { type: 'string', value: 'ok' } } }),
      },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code', 'codex']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )

    expect(res.ok).toBe(false)
    expect(existsSync(join(home, 'claude', 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(home, 'codex', 'AGENTS.md'))).toBe(false)
  })

  it('scope=skills does NOT write memory files', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: 'x' },
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code'] },
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
