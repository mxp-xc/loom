import { describe, it, expect, expectTypeOf } from 'vitest'
import type { AgentId, Manifest, McpServer, Config, SkillSource } from '../src/types'

describe('types', () => {
  it('AgentId is the three supported agents', () => {
    expectTypeOf<AgentId>().toEqualTypeOf<'claude-code' | 'codex' | 'opencode'>()
  })
  it('McpServer stdio has command/args/env, agents optional', () => {
    const m: McpServer = {
      id: 'x',
      type: 'stdio',
      command: 'npx',
      args: ['p'],
      env: {},
      agents: ['claude-code'],
    }
    expectTypeOf(m).toMatchTypeOf<McpServer>()
    const m2: McpServer = { id: 'y', type: 'stdio', command: 'npx' }
    expectTypeOf(m2).toMatchTypeOf<McpServer>()
  })
  it('Config fields are snake_case to align with YAML', () => {
    const c: Config = {
      profile: 'local',
      agents: ['claude-code'],
      projection: { strategy: 'link' },
      update_check: { enabled: true, interval: '6h' },
      active_repo: 'default',
      proxy: { http: '', https: '', no_proxy: '' },
    }
    expectTypeOf(c).toMatchTypeOf<Config>()
  })
})

describe('SkillSource type field', () => {
  it('accepts source name', () => {
    const src: SkillSource = {
      name: 'openai-skills',
      url: 'https://github.com/org/repo',
      ref: 'main',
    }
    expect(src.name).toBe('openai-skills')
  })

  it('accepts type: "branch"', () => {
    const src: SkillSource = { url: 'https://github.com/org/repo', ref: 'main', type: 'branch' }
    expect(src.type).toBe('branch')
  })
  it('accepts type: "tag"', () => {
    const src: SkillSource = { url: 'https://github.com/org/repo', ref: 'v1.0', type: 'tag' }
    expect(src.type).toBe('tag')
  })
  it('type is optional', () => {
    const src: SkillSource = { url: 'https://github.com/org/repo', ref: 'main' }
    expect(src.type).toBeUndefined()
  })
})

describe('Config skill_naming field', () => {
  it('accepts skill_naming: "dir"', () => {
    const cfg: Config = { skill_naming: 'dir' }
    expect(cfg.skill_naming).toBe('dir')
  })
  it('accepts skill_naming: "hyphen"', () => {
    const cfg: Config = { skill_naming: 'hyphen' }
    expect(cfg.skill_naming).toBe('hyphen')
  })
})
