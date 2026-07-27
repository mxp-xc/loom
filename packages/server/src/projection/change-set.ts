import type { SkillProjectionDestination } from '@loom/core'

export interface SkillsProjectionChangeSet {
  sources: Array<{ sourceUrl: string; destinations: SkillProjectionDestination[] }>
  locals: Array<{ skillId: string; destinations: SkillProjectionDestination[] }>
}
