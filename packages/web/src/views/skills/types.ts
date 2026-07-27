import type { AgentId } from '@loom/core'

export type SkillDetailIdentity =
  { kind: 'source'; sourceUrl: string; memberEntry: string } | { kind: 'local'; skillId: string }

export interface ScanMember {
  name: string
  description: string
  path: string
  installed: boolean
}

export interface SkillDetail {
  skillId: string
  source?: string
  memberEntry?: string
  path?: string
  agents: AgentId[]
  shared?: boolean
}

export interface RefreshMember {
  name: string
  path: string
}
export interface LocalScanResult {
  name: string
  path: string
}

export interface SourceRef {
  url: string
  type: 'branch' | 'tag'
  ref: string
}

export function sortSkillMembers<T extends { name: string }>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => a.name.localeCompare(b.name, 'en'))
}
