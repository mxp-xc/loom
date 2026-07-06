import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentConfigDir,
  agentSkillsDir,
  agentMcpFile,
  agentMemoryFile,
} from '../../src/adapters/paths'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('agent paths', () => {
  it('claude-code: <home>/.claude, CLAUDE_CONFIG_DIR override', () => {
    expect(agentConfigDir('claude-code')).toBe(join(home, '.claude'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/custom/claude')
    expect(agentConfigDir('claude-code')).toBe('/custom/claude')
  })
  it('codex: <home>/.codex, CODEX_HOME override', () => {
    expect(agentConfigDir('codex')).toBe(join(home, '.codex'))
    vi.stubEnv('CODEX_HOME', '/custom/codex')
    expect(agentConfigDir('codex')).toBe('/custom/codex')
  })
  it('opencode: OPENCODE_CONFIG_DIR override (returns env value directly)', () => {
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/custom/opencode')
    expect(agentConfigDir('opencode')).toBe('/custom/opencode')
  })
  it('skills dir = configDir/skills', () => {
    expect(agentSkillsDir('claude-code')).toBe(join(home, '.claude', 'skills'))
    expect(agentSkillsDir('codex')).toBe(join(home, '.codex', 'skills'))
  })
  it('mcp file: claude ~/.claude.json, codex config.toml, opencode <configDir>/opencode.json', () => {
    expect(agentMcpFile('claude-code')).toBe(join(home, '.claude.json'))
    expect(agentMcpFile('codex')).toBe(join(home, '.codex', 'config.toml'))
    vi.stubEnv('OPENCODE_CONFIG_DIR', join(home, 'opencode'))
    expect(agentMcpFile('opencode')).toBe(join(home, 'opencode', 'opencode.json'))
  })
  it('opencode config dir is ~/.config/opencode on darwin (not Library/Application Support)', () => {
    delete process.env.OPENCODE_CONFIG_DIR
    const dir = agentConfigDir('opencode')
    expect(dir.endsWith(join('.config', 'opencode'))).toBe(true)
    expect(dir).not.toContain('Application Support')
  })
  it('agentMemoryFile: claude-code -> CLAUDE.md, others -> AGENTS.md', () => {
    expect(agentMemoryFile('claude-code').endsWith('CLAUDE.md')).toBe(true)
    expect(agentMemoryFile('codex').endsWith('AGENTS.md')).toBe(true)
    expect(agentMemoryFile('opencode').endsWith('AGENTS.md')).toBe(true)
  })
  it('agentMemoryFile lives under agentConfigDir', () => {
    for (const a of ['claude-code', 'codex', 'opencode'] as const) {
      const f = agentMemoryFile(a)
      const d = agentConfigDir(a)
      expect(f.startsWith(d)).toBe(true)
    }
  })
})
