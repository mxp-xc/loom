export type AgentId = 'claude-code' | 'codex' | 'opencode'
export type McpType = 'stdio' | 'sse' | 'http'

export interface SkillMemberOverride {
  name: string
  enabled?: boolean
  targets?: AgentId[]
}

export interface SkillSource {
  url: string
  ref: string
  pinned_commit?: string
  scan?: string
  members?: SkillMemberOverride[]
}

export interface LocalSkill {
  id: string
  path?: string
  targets?: AgentId[]
}

export interface SkillsManifest {
  sources: SkillSource[]
  skills: LocalSkill[]
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
}

export interface VarsFile {
  [key: string]: string
}

export interface Manifest {
  skills: SkillsManifest
  mcp: McpServer[]
  vars: { default: VarsFile; active: VarsFile }
  config: Config
  errors: string[]
}

export interface RepoManifest {
  skills: SkillsManifest
  mcp: McpServer[]
  varsFiles: Record<string, VarsFile>
  repoConfig: Config
}
