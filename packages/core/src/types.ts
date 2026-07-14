import type { VarsEnvironment } from './vars-types.js'

export type AgentId = 'claude-code' | 'codex' | 'opencode'
export type McpType = 'stdio' | 'sse' | 'http'

export interface SkillMemberOverride {
  name: string
  enabled?: boolean
  targets?: AgentId[]
  /** Runtime-only source SKILL.md path relative to the source repository root. */
  path?: string
  /** Runtime-only source SKILL.md frontmatter description. */
  description?: string
}

export interface SkillSource {
  name?: string
  url: string
  ref: string
  type?: 'branch' | 'tag'
  pinned_commit?: string
  scan?: string
  members?: SkillMemberOverride[]
}

export interface LocalSkill {
  id: string
  path?: string
  targets?: AgentId[]
  /** Runtime-only status added to manifest responses for referenced skills. */
  available?: boolean
  /** Runtime-only local SKILL.md path relative to the repo root when possible. */
  skillFilePath?: string
  /** Runtime-only local SKILL.md frontmatter description. */
  description?: string
}

export interface SkillsManifest {
  sources: SkillSource[]
  skills: LocalSkill[]
  group_order?: string[]
}

export interface Memory {
  name: string
  content?: string
}

export interface MemoryManifest {
  memories: Memory[]
  active: Memory | null
  activeContent: string
}

export interface McpServer {
  id: string
  type: McpType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  targets?: AgentId[]
}

export interface ProjectionConfig {
  strategy: 'link' | 'copy'
}
export interface UpdateCheckConfig {
  enabled: boolean
  interval: string
}
export interface ProxyConfig {
  http?: string
  https?: string
  no_proxy?: string
}

export interface Config {
  profile?: string
  targets?: AgentId[]
  projection?: ProjectionConfig
  update_check?: UpdateCheckConfig
  active_repo?: string
  proxy?: ProxyConfig
  skill_naming?: 'dir' | 'hyphen'
  active_memory?: string
  memory_order?: string[]
}

export interface VarsFile {
  [key: string]: string
}

export interface Manifest {
  skills: SkillsManifest
  mcp: McpServer[]
  memory: MemoryManifest
  vars: { default: VarsFile; active: VarsFile }
  config: Config
  errors: string[]
}

export interface RepoManifest {
  skills: SkillsManifest
  mcp: McpServer[]
  varsFiles: Record<string, VarsEnvironment>
  repoConfig: Config
  memoriesFiles: Record<string, string>
}
