export interface ScanMember {
  name: string
  description: string
  path: string
  installed: boolean
}

export interface SkillDetail {
  skillId: string
  source?: string
  path?: string
  targets: string[]
}

export interface RefreshMember {
  name: string
  path: string
}
