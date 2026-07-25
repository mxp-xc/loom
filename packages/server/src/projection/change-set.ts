import type { AgentId } from '@loom/core'

export interface SkillsProjectionChangeSet {
  sources: Array<{ sourceUrl: string; agents: AgentId[] }>
  locals: Array<{ skillId: string; agents: AgentId[] }>
}
