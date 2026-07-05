import yaml from 'js-yaml'
import { z } from 'zod'
import type { Config, RepoManifest, Manifest } from './types.js'
import { parseVarsEnvironment } from './vars-codec.js'
import type { VarsEnvironment, VarEntry } from './vars-types.js'

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
export const SkillMemberOverrideSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  targets: z.array(AgentIdSchema).optional(),
})
export const SkillSourceSchema = z.object({
  url: z.string().min(1),
  ref: z.string().min(1),
  pinned_commit: z.string().optional(),
  scan: z.string().optional(),
  members: z.array(SkillMemberOverrideSchema).optional(),
})

export function validateManifest(m: RepoManifest): string[] {
  const errs: string[] = []
  m.skills.sources.forEach((s, i) => {
    const r = SkillSourceSchema.safeParse(s)
    if (!r.success)
      for (const iss of r.error.issues)
        errs.push(`source[${i}].${iss.path.join('.')}: ${iss.message}`)
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
  const memories = Object.entries(repo.memoriesFiles).map(([name, content]) => ({
    name,
    content,
  }))
  const activeName = effective.active_memory ?? null
  const active = activeName ? (memories.find((m) => m.name === activeName) ?? null) : null
  const activeContent = active?.content ?? ''
  const errors = validateManifest(repo)
  if (activeName && !active) {
    errors.push(`active_memory references unknown memory: ${activeName}`)
  }
  return {
    skills: repo.skills,
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
