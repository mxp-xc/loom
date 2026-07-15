import yaml from 'js-yaml'
import { z } from 'zod'
import type { Config, RepoManifest, Manifest } from './types.js'
import { deriveRepoId } from './projection.js'
import { parseVarsEnvironment } from './vars-codec.js'
import type { VarsEnvironment, VarEntry } from './vars-types.js'
import { normalizeOrder, normalizeSkillGroupOrder } from './order.js'
import { normalizeSourcePath, normalizeSourceResources } from './source-tree.js'

export function loadRepoManifest(files: Record<string, string>): RepoManifest {
  const parse = (p: string, fallback: unknown): unknown => {
    const raw = files[p]
    if (raw === undefined) return fallback
    return yaml.load(raw)
  }
  const skills = parse('skills.yaml', { sources: [], skills: [] })
  const mcp = parse('mcp.yaml', [])
  const varsFiles: Record<string, VarsEnvironment> = {}
  for (const path of Object.keys(files)) {
    if (path.startsWith('vars/') && path.endsWith('.yaml')) {
      const profile = path.slice('vars/'.length, -'.yaml'.length)
      varsFiles[profile] = parseVarsEnvironment(files[path])
    }
  }
  const memoriesFiles: Record<string, string> = {}
  for (const path of Object.keys(files)) {
    if (path.startsWith('memories/') && path.endsWith('.md')) {
      const name = path.slice('memories/'.length, -'.md'.length)
      memoriesFiles[name] = files[path]
    }
  }
  const repoConfig = parse('config.yaml', {})
  return { skills, mcp, varsFiles, repoConfig, memoriesFiles } as RepoManifest
}

export const AgentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
export const SOURCE_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_NAME_REGEX = SOURCE_NAME_REGEX
const SOURCE_PATH_REGEX = /^(?!\/)(?![A-Za-z]:\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/
export const McpServerSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    targets: z.array(AgentIdSchema).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('sse'),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
    targets: z.array(AgentIdSchema).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('http'),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
    targets: z.array(AgentIdSchema).optional(),
  }),
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
    targets: z.array(AgentIdSchema).optional(),
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
  const errs: string[] = []
  const sourceNames = new Map<string, number>()
  const sourceUrls = new Map<string, number>()
  m.skills.sources.forEach((s, i) => {
    const r = SkillSourceSchema.safeParse(s)
    if (!r.success)
      for (const iss of r.error.issues)
        errs.push(`source[${i}].${iss.path.join('.')}: ${iss.message}`)
    if (typeof s?.url === 'string' && s.url) {
      const previous = sourceUrls.get(s.url)
      if (previous !== undefined) errs.push(`source[${i}].url: duplicate source url: ${s.url}`)
      else sourceUrls.set(s.url, i)
    }
    if (typeof s?.url === 'string' && s.url) {
      const sourceName =
        typeof s.name === 'string' && s.name.trim() ? s.name.trim() : deriveRepoId(s.url)
      const previous = sourceNames.get(sourceName)
      if (previous !== undefined)
        errs.push(`source[${i}].name: duplicate source name: ${sourceName}`)
      else sourceNames.set(sourceName, i)
    }
  })
  m.mcp.forEach((s, i) => {
    const r = McpServerSchema.safeParse(s)
    if (!r.success)
      for (const iss of r.error.issues) errs.push(`mcp[${i}].${iss.path.join('.')}: ${iss.message}`)
  })
  return errs
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(repo: T, local: unknown): T {
  if (!isPlainObject(repo) || !isPlainObject(local))
    return (local === undefined ? repo : local) as T
  const out: Record<string, unknown> = { ...repo }
  for (const k of Object.keys(local)) {
    out[k] = deepMerge(repo[k], (local as Record<string, unknown>)[k])
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
  const memories = memoryNames.map((name) => ({ name, content: repo.memoriesFiles[name] }))
  const activeName = effective.active_memory ?? null
  const active = activeName ? (memories.find((m) => m.name === activeName) ?? null) : null
  const activeContent = active?.content ?? ''
  const errors = validateManifest(repo)
  if (activeName && !active) {
    errors.push(`active_memory references unknown memory: ${activeName}`)
  }
  return {
    skills: { ...repo.skills, group_order: normalizeSkillGroupOrder(repo.skills) },
    mcp: repo.mcp,
    memory: { memories, active, activeContent },
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
