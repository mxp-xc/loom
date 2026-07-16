import type { VarsEnvironment } from './vars-types.js'

export type AgentId = 'claude-code' | 'codex' | 'opencode'
export type McpType = 'stdio' | 'sse' | 'http'

export interface SkillMemberOverride {
  name: string
  entry: string
  targets?: AgentId[]
  /** Runtime-only source SKILL.md path relative to the source repository root. */
  path?: string
  /** Runtime-only source SKILL.md frontmatter description. */
  description?: string
}

export type SourceResourceKind = 'file' | 'directory'

export interface SourceResourceRule {
  path: string
  kind: SourceResourceKind
}

export interface SourceResources {
  include: SourceResourceRule[]
  exclude: SourceResourceRule[]
}

interface SourceTreeNodeBase {
  name: string
  path: string
  mode: string
  oid: string
}

export interface SourceTreeBundleNode extends SourceTreeNodeBase {
  kind: 'bundle'
  entry: string
  description?: string
}

export interface SourceTreeContainerNode extends SourceTreeNodeBase {
  kind: 'container'
  children: SourceTreeNode[]
}

export interface SourceTreeResourceNode extends SourceTreeNodeBase {
  kind: 'resource'
}

export interface SourceTreeSymlinkNode extends SourceTreeNodeBase {
  kind: 'symlink'
}

export interface SourceTreeSubmoduleNode extends SourceTreeNodeBase {
  kind: 'submodule'
}

export type SourceTreeNode =
  | SourceTreeBundleNode
  | SourceTreeContainerNode
  | SourceTreeResourceNode
  | SourceTreeSymlinkNode
  | SourceTreeSubmoduleNode

export interface SourceTreeDiagnostic {
  code: 'invalid-nested-bundle' | 'bundle-symlink' | 'bundle-submodule'
  path: string
  relatedPaths?: string[]
  message: string
}

export interface SourceTree {
  commit: string
  nodes: SourceTreeNode[]
  diagnostics: SourceTreeDiagnostic[]
}

export interface SourceTreeSummary {
  bundles: number
  containers: number
  resources: number
  symlinks: number
  submodules: number
}

export interface SkillSource {
  name?: string
  url: string
  ref: string
  type?: 'branch' | 'tag'
  pinned_commit?: string
  members?: SkillMemberOverride[]
  resources?: SourceResources
  /** Runtime-only tree read from pinned_commit. Never serialized to skills.yaml. */
  sourceTree?: SourceTree
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
  targets?: AgentId[]
}

export interface MemoryManifest {
  memories: Memory[]
  assignments?: Partial<Record<AgentId, string>>
  /** Legacy compatibility fields. New consumers use assignments. */
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
  memory_targets?: Partial<Record<AgentId, string>>
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
