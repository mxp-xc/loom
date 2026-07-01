import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentId } from '@loom/core'

export function agentConfigDir(agent: AgentId): string {
  switch (agent) {
    case 'claude-code': return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    case 'codex': return process.env.CODEX_HOME ?? join(homedir(), '.codex')
    case 'opencode': {
      if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
      const base = process.platform === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
      return join(base, 'opencode')
    }
  }
}

export function agentSkillsDir(agent: AgentId): string {
  return join(agentConfigDir(agent), 'skills')
}

export function agentMcpFile(agent: AgentId): string {
  switch (agent) {
    case 'claude-code': return join(homedir(), '.claude.json')
    case 'codex': return join(agentConfigDir('codex'), 'config.toml')
    case 'opencode': return join(agentConfigDir('opencode'), 'opencode.json')
  }
}
