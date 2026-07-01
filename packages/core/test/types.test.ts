import { describe, it, expectTypeOf } from 'vitest'
import type { AgentId, Manifest, McpServer, Config, SkillSource } from '../src/types'

describe('types', () => {
  it('AgentId is the three supported agents', () => {
    expectTypeOf<AgentId>().toEqualTypeOf<'claude-code' | 'codex' | 'opencode'>()
  })
  it('McpServer stdio has command/args/env, targets optional', () => {
    const m: McpServer = {
      id: 'x',
      type: 'stdio',
      command: 'npx',
      args: ['p'],
      env: {},
      targets: ['claude-code'],
    }
    expectTypeOf(m).toMatchTypeOf<McpServer>()
    const m2: McpServer = { id: 'y', type: 'stdio', command: 'npx' }
    expectTypeOf(m2).toMatchTypeOf<McpServer>()
  })
  it('Config fields are snake_case to align with YAML', () => {
    const c: Config = {
      profile: 'local',
      targets: ['claude-code'],
      projection: { strategy: 'link' },
      update_check: { enabled: true, interval: '6h' },
      active_repo: 'default',
      proxy: { http: '', https: '', no_proxy: '' },
    }
    expectTypeOf(c).toMatchTypeOf<Config>()
  })
})
