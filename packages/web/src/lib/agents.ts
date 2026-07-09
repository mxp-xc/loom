import type { AgentId } from '@loom/core'

export type { AgentId } from '@loom/core'

export const AGENTS: AgentId[] = ['claude-code', 'codex', 'opencode']

export const agentShort: Record<AgentId, string> = {
  'claude-code': 'CC',
  codex: 'CX',
  opencode: 'OC',
}

export const agentColor: Record<AgentId, string> = {
  'claude-code': 'var(--cc)',
  codex: 'var(--cx)',
  opencode: 'var(--oc)',
}

export const agentName: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

export const agentMcpPath: Record<AgentId, string> = {
  'claude-code': '~/.claude.json',
  codex: '~/.codex/config.toml',
  opencode: '~/.config/opencode/opencode.json',
}

export function agentSkillPath(agent: AgentId, skillId: string): string {
  const dir = agent === 'claude-code' ? '~/.claude' : agent === 'codex' ? '~/.codex' : '~/.opencode'
  return `${dir}/skills/${skillId}`
}
