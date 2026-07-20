import yaml from 'js-yaml'
import { z } from 'zod'
import type {
  Config,
  LocalSkill,
  Manifest,
  ManifestConfigFile,
  ManifestLoadDiagnostic,
  McpServer,
  RepoManifest,
  SkillSource,
  SkillsManifest,
} from './types.js'
import {
  AgentIdSchema,
  isAgentId,
  supportsAgentCapability,
  type AgentCapability,
} from './agents.js'
import { deriveRepoId } from './projection.js'
import { parseVarsEnvironment } from './vars-codec.js'
import type { VarsEnvironment, VarEntry } from './vars-types.js'
import { normalizeOrder, normalizeSkillGroupOrder } from './order.js'
import { normalizeSourcePath, normalizeSourceResources } from './source-tree.js'
import { LocalSkillIdSchema, SKILL_NAME_REGEX } from './skill-id.js'

export { LocalSkillIdSchema, SKILL_NAME_REGEX } from './skill-id.js'

export function loadRepoManifest(files: Record<string, string>): RepoManifest {
  const diagnostics: ManifestLoadDiagnostic[] = []
  const skillsFile = loadManifestFile(files, 'skills.yaml')
  const mcpFile = loadManifestFile(files, 'mcp.yaml')
  const configFile = loadManifestFile(files, 'config.yaml')
  const skills = skillsFile.present
    ? normalizeSkillsManifest(skillsFile.value, diagnostics)
    : { sources: [], skills: [] }
  const mcp = mcpFile.present ? normalizeMcpManifest(mcpFile.value, diagnostics) : []
  const varsFiles = Object.create(null) as Record<string, VarsEnvironment>
  for (const path of Object.keys(files)) {
    if (path.startsWith('vars/') && path.endsWith('.yaml')) {
      const profile = path.slice('vars/'.length, -'.yaml'.length)
      varsFiles[profile] = parseVarsEnvironment(files[path])
    }
  }
  const memoriesFiles = Object.create(null) as Record<string, string>
  for (const path of Object.keys(files)) {
    if (path.startsWith('memories/') && path.endsWith('.md')) {
      const name = path.slice('memories/'.length, -'.md'.length)
      memoriesFiles[name] = files[path]
    }
  }
  const repoConfig = configFile.present
    ? normalizeConfigDocument(configFile.empty ? {} : configFile.value)
    : {}
  if (!repoConfig) {
    diagnostics.push(
      loadDiagnostic('manifest_container_invalid', 'config.yaml', '', 'expected an object'),
    )
  }
  return {
    skills,
    mcp,
    varsFiles,
    repoConfig: repoConfig ?? {},
    memoriesFiles,
    loadDiagnostics: diagnostics,
  }
}

interface LoadedManifestFile {
  present: boolean
  empty: boolean
  value: unknown
}

function loadManifestFile(
  files: Record<string, string>,
  file: ManifestConfigFile,
): LoadedManifestFile {
  const raw = files[file]
  if (raw === undefined) return { present: false, empty: false, value: undefined }
  const empty = raw.trim() === ''
  return { present: true, empty, value: yaml.load(raw) }
}

function loadDiagnostic(
  code: ManifestLoadDiagnostic['code'],
  file: ManifestConfigFile,
  path: string,
  message: string,
): ManifestLoadDiagnostic {
  return { code, file, ...(path ? { path } : {}), message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneOwnValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneOwnValue) as T
  if (!isPlainObject(value)) return value
  const clone = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) clone[key] = cloneOwnValue(value[key])
  return clone as T
}

export function normalizeConfigDocument(value: unknown): Config | null {
  return isPlainObject(value) ? (cloneOwnValue(value) as Config) : null
}

function normalizeManifestItems<T>(
  value: unknown,
  file: ManifestConfigFile,
  path: string,
  diagnostics: ManifestLoadDiagnostic[],
): T[] {
  if (!Array.isArray(value)) {
    diagnostics.push(loadDiagnostic('manifest_field_invalid', file, path, 'expected an array'))
    return []
  }
  const items: T[] = []
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      const itemPath = path ? `${path}[${index}]` : `[${index}]`
      diagnostics.push(
        loadDiagnostic('manifest_item_invalid', file, itemPath, 'expected an object'),
      )
      continue
    }
    items.push(cloneOwnValue(item) as T)
  }
  return items
}

function normalizeSkillsManifest(
  value: unknown,
  diagnostics: ManifestLoadDiagnostic[],
): SkillsManifest {
  if (!isPlainObject(value)) {
    diagnostics.push(
      loadDiagnostic('manifest_container_invalid', 'skills.yaml', '', 'expected an object'),
    )
    return { sources: [], skills: [] }
  }
  const sources = normalizeManifestItems<SkillSource>(
    value.sources,
    'skills.yaml',
    'sources',
    diagnostics,
  )
  const skills = normalizeManifestItems<LocalSkill>(
    value.skills,
    'skills.yaml',
    'skills',
    diagnostics,
  )
  let groupOrder: string[] | undefined
  if (value.group_order !== undefined) {
    if (
      Array.isArray(value.group_order) &&
      value.group_order.every((item) => typeof item === 'string')
    ) {
      groupOrder = [...value.group_order]
    } else {
      diagnostics.push(
        loadDiagnostic('manifest_field_invalid', 'skills.yaml', 'group_order', 'expected strings'),
      )
    }
  }
  return { sources, skills, ...(groupOrder ? { group_order: groupOrder } : {}) }
}

function normalizeMcpManifest(value: unknown, diagnostics: ManifestLoadDiagnostic[]): McpServer[] {
  if (!Array.isArray(value)) {
    diagnostics.push(
      loadDiagnostic('manifest_container_invalid', 'mcp.yaml', '', 'expected an array'),
    )
    return []
  }
  return normalizeManifestItems<McpServer>(value, 'mcp.yaml', '', diagnostics)
}

export const SOURCE_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SOURCE_PATH_REGEX = /^(?!\/)(?![A-Za-z]:\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/
export const McpServerSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: z.string().min(1),
      type: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      agents: z.array(AgentIdSchema).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal('sse'),
      url: z.string().min(1),
      headers: z.record(z.string()).optional(),
      env: z.record(z.string()).optional(),
      agents: z.array(AgentIdSchema).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal('http'),
      url: z.string().min(1),
      headers: z.record(z.string()).optional(),
      env: z.record(z.string()).optional(),
      agents: z.array(AgentIdSchema).optional(),
    })
    .strict(),
])
const SourcePathSchema = z
  .string()
  .min(1)
  .regex(SOURCE_PATH_REGEX)
  .refine((path) => {
    try {
      return normalizeSourcePath(path) === path
    } catch {
      return false
    }
  }, 'path must be normalized source-relative path')
const SourceResourceRuleSchema = z
  .object({
    path: SourcePathSchema,
    kind: z.enum(['file', 'directory']),
  })
  .strict()
export const SkillMemberOverrideSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_REGEX),
    entry: SourcePathSchema.refine(
      (entry) => entry === 'SKILL.md' || entry.endsWith('/SKILL.md'),
      'entry must identify a SKILL.md file',
    ),
    agents: z.array(AgentIdSchema).optional(),
  })
  .strict()
export const LocalSkillSchema = z
  .object({
    id: LocalSkillIdSchema,
    path: z.string().min(1).optional(),
    agents: z.array(AgentIdSchema).optional(),
  })
  .strict()
export const SkillSourceSchema = z
  .object({
    name: z.string().regex(SOURCE_NAME_REGEX).optional(),
    url: z.string().min(1),
    ref: z.string().min(1),
    type: z.enum(['branch', 'tag']).optional(),
    pinned_commit: z.string().optional(),
    members: z.array(SkillMemberOverrideSchema).optional(),
    resources: z
      .object({
        include: z.array(SourceResourceRuleSchema),
        exclude: z.array(SourceResourceRuleSchema),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const names = new Set<string>()
    const entries = new Set<string>()
    for (const [index, member] of (source.members ?? []).entries()) {
      if (names.has(member.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', index, 'name'],
          message: `duplicate member name: ${member.name}`,
        })
      }
      if (entries.has(member.entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', index, 'entry'],
          message: `duplicate member entry: ${member.entry}`,
        })
      }
      names.add(member.name)
      entries.add(member.entry)
    }
    if (source.resources) {
      const seen = new Map<string, { action: 'include' | 'exclude'; index: number }>()
      for (const action of ['include', 'exclude'] as const) {
        for (const [index, rule] of source.resources[action].entries()) {
          const previous = seen.get(rule.path)
          if (previous) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['resources', action, index, 'path'],
              message: `resource path conflicts with ${previous.action}[${previous.index}]: ${rule.path}`,
            })
          } else {
            seen.set(rule.path, { action, index })
          }
        }
      }
      let normalized = false
      try {
        normalized =
          JSON.stringify(normalizeSourceResources(source.resources)) ===
          JSON.stringify(source.resources)
      } catch {
        // Child schemas report malformed paths at their precise locations.
        return
      }
      if (
        seen.size === source.resources.include.length + source.resources.exclude.length &&
        !normalized
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources'],
          message: 'resource rules must be normalized and stably sorted',
        })
      }
    }
  })

export function validateManifest(m: RepoManifest): string[] {
  const errs = (m.loadDiagnostics ?? []).map(formatLoadDiagnostic)
  const skillIndexes = manifestItemIndexes(
    m.loadDiagnostics,
    'skills.yaml',
    'skills',
    m.skills.skills.length,
  )
  const sourceIndexes = manifestItemIndexes(
    m.loadDiagnostics,
    'skills.yaml',
    'sources',
    m.skills.sources.length,
  )
  const mcpIndexes = manifestItemIndexes(m.loadDiagnostics, 'mcp.yaml', '', m.mcp.length)
  const sourceNames = new Map<string, number>()
  const sourceUrls = new Map<string, number>()
  const localSkillIds = new Map<string, number>()
  m.skills.skills.forEach((skill, i) => {
    const itemIndex = skillIndexes[i]
    const result = LocalSkillSchema.safeParse(skill)
    if (!result.success) {
      for (const issue of result.error.issues) {
        errs.push(`skills.skills[${itemIndex}].${issue.path.join('.')}: ${issue.message}`)
      }
    }
    if (typeof skill?.id === 'string' && LocalSkillIdSchema.safeParse(skill.id).success) {
      const previous = localSkillIds.get(skill.id)
      if (previous !== undefined)
        errs.push(`skills.skills[${itemIndex}].id: duplicate local skill id: ${skill.id}`)
      else localSkillIds.set(skill.id, itemIndex)
    }
  })
  m.skills.sources.forEach((s, i) => {
    const itemIndex = sourceIndexes[i]
    const r = SkillSourceSchema.safeParse(s)
    if (!r.success)
      for (const iss of r.error.issues)
        errs.push(`source[${itemIndex}].${iss.path.join('.')}: ${iss.message}`)
    if (typeof s?.url === 'string' && s.url) {
      const previous = sourceUrls.get(s.url)
      if (previous !== undefined)
        errs.push(
          `source[${itemIndex}].url: duplicate source URL already used by source[${previous}]`,
        )
      else sourceUrls.set(s.url, itemIndex)
    }
    if (typeof s?.url === 'string' && s.url) {
      let sourceName: string
      if (typeof s.name === 'string' && s.name.trim()) {
        sourceName = s.name.trim()
      } else {
        try {
          sourceName = deriveRepoId(s.url)
        } catch {
          errs.push(`source[${itemIndex}].url: invalid repository URL`)
          return
        }
      }
      const previous = sourceNames.get(sourceName)
      if (previous !== undefined)
        errs.push(`source[${itemIndex}].name: duplicate source name: ${sourceName}`)
      else sourceNames.set(sourceName, itemIndex)
    }
  })
  m.mcp.forEach((s, i) => {
    const itemIndex = mcpIndexes[i]
    const r = McpServerSchema.safeParse(s)
    if (!r.success)
      for (const iss of r.error.issues)
        errs.push(`mcp[${itemIndex}].${iss.path.join('.')}: ${iss.message}`)
  })
  validateExplicitAgents(m.skills.skills, 'skills.skills', 'skills', errs, skillIndexes)
  m.skills.sources.forEach((source, sourceIndex) => {
    validateExplicitAgents(
      source.members ?? [],
      `skills.sources[${sourceIndexes[sourceIndex]}].members`,
      'skills',
      errs,
    )
  })
  validateExplicitAgents(m.mcp, 'mcp', 'mcp', errs, mcpIndexes)
  return errs
}

function manifestItemIndexes(
  diagnostics: ManifestLoadDiagnostic[] | undefined,
  file: ManifestConfigFile,
  path: string,
  itemCount: number,
): number[] {
  const prefix = path ? `${path}[` : '['
  const invalidIndexes = new Set<number>()
  for (const diagnostic of diagnostics ?? []) {
    if (
      diagnostic.code !== 'manifest_item_invalid' ||
      diagnostic.file !== file ||
      !diagnostic.path?.startsWith(prefix) ||
      !diagnostic.path.endsWith(']')
    ) {
      continue
    }
    const index = Number(diagnostic.path.slice(prefix.length, -1))
    if (Number.isInteger(index) && index >= 0) invalidIndexes.add(index)
  }

  const indexes: number[] = []
  for (let originalIndex = 0; indexes.length < itemCount; originalIndex += 1) {
    if (!invalidIndexes.has(originalIndex)) indexes.push(originalIndex)
  }
  return indexes
}

function validateExplicitAgents(
  items: Array<{ agents?: unknown }>,
  path: string,
  capability: AgentCapability,
  errors: string[],
  indexes?: number[],
): void {
  items.forEach((item, itemIndex) => {
    if (!Array.isArray(item.agents)) return
    item.agents.forEach((agent, agentIndex) => {
      if (!isAgentId(agent)) return
      if (!supportsAgentCapability(agent, capability)) {
        errors.push(
          `${path}[${indexes?.[itemIndex] ?? itemIndex}].agents.${agentIndex}: agent ${agent} does not support ${capability}`,
        )
      }
    })
  })
}

function validateEffectiveConfig(config: Config): string[] {
  const result = z
    .object({ agents: z.array(AgentIdSchema).optional() })
    .passthrough()
    .safeParse(config)
  if (result.success) return []
  return result.error.issues.map((issue) => `config.${issue.path.join('.')}: ${issue.message}`)
}

function formatLoadDiagnostic(diagnostic: ManifestLoadDiagnostic): string {
  const path = diagnostic.path
    ? diagnostic.path.startsWith('[')
      ? diagnostic.path
      : `.${diagnostic.path}`
    : ''
  return `${diagnostic.file}${path}: ${diagnostic.message}`
}

function deepMerge<T>(repo: T, local: unknown): T {
  if (local === undefined) return cloneOwnValue(repo)
  if (!isPlainObject(repo) || !isPlainObject(local)) return cloneOwnValue(local) as T
  const out = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(repo)) out[key] = cloneOwnValue(repo[key])
  for (const key of Object.keys(local)) {
    const repoValue = Object.hasOwn(repo, key) ? repo[key] : undefined
    out[key] = deepMerge(repoValue, local[key])
  }
  return out as T
}

export function mergeConfig(repo: Config, local: Config): Config {
  return deepMerge(repo, local)
}

export function buildManifest(repo: RepoManifest, localConfig: Config): Manifest {
  const effective = mergeConfig(repo.repoConfig, localConfig)
  const profileName = effective.profile ?? 'default'
  const defaultVars = toVarsFile(repo.varsFiles['default'])
  const activeEnvironment = repo.varsFiles[profileName]
  const memoryNames = normalizeOrder(repo.repoConfig?.memory_order, Object.keys(repo.memoriesFiles))
  const memoryNameSet = new Set(memoryNames)
  const activeName = effective.active_memory ?? null
  const configuredAssignments = effective.memory_agents
  const assignments: Manifest['memory']['assignments'] = {}
  if (configuredAssignments && typeof configuredAssignments === 'object') {
    for (const agent of AgentIdSchema.options) {
      const name = configuredAssignments[agent]
      if (typeof name === 'string' && memoryNameSet.has(name)) assignments[agent] = name
    }
  } else if (activeName && memoryNameSet.has(activeName)) {
    for (const agent of effective.agents ?? []) assignments[agent] = activeName
  }
  const memories = memoryNames.map((name) => ({
    name,
    content: repo.memoriesFiles[name],
    agents: AgentIdSchema.options.filter((agent) => assignments[agent] === name),
  }))
  const active = activeName ? (memories.find((m) => m.name === activeName) ?? null) : null
  const activeContent = active?.content ?? ''
  const errors = [...validateManifest(repo), ...validateEffectiveConfig(effective)]
  if (activeName && !active) {
    errors.push(`active_memory references unknown memory: ${activeName}`)
  }
  if (configuredAssignments && typeof configuredAssignments === 'object') {
    for (const [agent, name] of Object.entries(configuredAssignments)) {
      if (!AgentIdSchema.safeParse(agent).success)
        errors.push(`memory_agents references unknown agent: ${agent}`)
      else if (typeof name !== 'string' || !memoryNameSet.has(name))
        errors.push(`memory_agents.${agent} references unknown memory: ${String(name)}`)
    }
  }
  return {
    skills: { ...repo.skills, group_order: normalizeSkillGroupOrder(repo.skills) },
    mcp: repo.mcp,
    memory: { memories, assignments, active, activeContent },
    vars: {
      default: defaultVars,
      active: activeEnvironment ? toVarsFile(activeEnvironment) : defaultVars,
    },
    config: effective,
    errors,
  }
}

function stringifyEntry(entry: VarEntry): string {
  return entry.type === 'json' ? JSON.stringify(entry.value) : String(entry.value)
}

function toVarsFile(environment: VarsEnvironment | undefined): Record<string, string> {
  if (!environment) return {}
  return Object.fromEntries(
    Object.entries(environment.entries).map(([key, entry]) => [key, stringifyEntry(entry)]),
  )
}
