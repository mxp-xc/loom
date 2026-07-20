import type { SkillsManifest, McpServer, AgentId, LocalSkill, SkillSource } from './types.js'
import { assertLocalSkillId } from './skill-id.js'

export type MutationResult<T> = { changed: boolean; data: T }

// -- SkillsManifest mutations --

export function addLocalSkill(
  skills: SkillsManifest,
  skill: LocalSkill,
): MutationResult<SkillsManifest> {
  assertLocalSkillId(skill.id)
  if (skills.skills.some((existing) => existing.id === skill.id)) {
    return { changed: false, data: skills }
  }
  return { changed: true, data: { ...skills, skills: [...skills.skills, skill] } }
}

export function removeLocalSkill(
  skills: SkillsManifest,
  id: string,
): MutationResult<SkillsManifest> {
  assertLocalSkillId(id)
  const filtered = skills.skills.filter((s) => s.id !== id)
  if (filtered.length === skills.skills.length) return { changed: false, data: skills }
  return { changed: true, data: { ...skills, skills: filtered } }
}

export function addSource(
  skills: SkillsManifest,
  source: Pick<SkillSource, 'url' | 'ref'> &
    Partial<Pick<SkillSource, 'name' | 'type' | 'pinned_commit' | 'members' | 'resources'>>,
): MutationResult<SkillsManifest> {
  const next: SkillSource = { url: source.url, ref: source.ref }
  if (source.name?.trim()) next.name = source.name.trim()
  if (source.type) next.type = source.type
  if (source.pinned_commit) next.pinned_commit = source.pinned_commit
  if (source.members) next.members = source.members
  if (source.resources) next.resources = source.resources
  return { changed: true, data: { ...skills, sources: [...skills.sources, next] } }
}

export function removeSource(skills: SkillsManifest, url: string): MutationResult<SkillsManifest> {
  const filtered = skills.sources.filter((s) => s.url !== url)
  if (filtered.length === skills.sources.length) return { changed: false, data: skills }
  return { changed: true, data: { ...skills, sources: filtered } }
}

// Update a source's ref and/or type without touching its members.
export function updateSourceMeta(
  skills: SkillsManifest,
  url: string,
  updates: { name?: string; ref?: string; type?: 'branch' | 'tag' },
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === url)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const next: typeof source = { ...source }
  if (updates.name !== undefined) next.name = updates.name.trim()
  if (updates.ref !== undefined) next.ref = updates.ref
  if (updates.type !== undefined) next.type = updates.type
  const sources = skills.sources.slice()
  sources[idx] = next
  return { changed: true, data: { ...skills, sources } }
}

// Keep agents for retained entries; names are snapshots refreshed by the latest scan.
export function setSourceMembers(
  skills: SkillsManifest,
  url: string,
  selectedMembers: Array<Pick<NonNullable<SkillSource['members']>[number], 'name' | 'entry'>>,
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === url)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const prev = new Map((source.members ?? []).map((member) => [member.entry, member]))
  const members = selectedMembers.map((member) => ({
    ...member,
    ...(prev.get(member.entry)?.agents ? { agents: prev.get(member.entry)!.agents } : {}),
  }))
  const sources = skills.sources.slice()
  sources[idx] = { ...source, members }
  return { changed: true, data: { ...skills, sources } }
}

export function setSkillAgents(
  skills: SkillsManifest,
  sourceUrl: string,
  memberEntry: string,
  agents: AgentId[],
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === sourceUrl)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const members = source.members ? source.members.slice() : []
  const memberIdx = members.findIndex((member) => member.entry === memberEntry)
  if (memberIdx === -1) return { changed: false, data: skills }
  members[memberIdx] = { ...members[memberIdx], agents }
  const next: typeof source = { ...source, members }
  const sources = skills.sources.slice()
  sources[idx] = next
  return { changed: true, data: { ...skills, sources } }
}

export function setSourceMemberAgents(
  skills: SkillsManifest,
  sourceUrl: string,
  updates: Array<{ memberEntry: string; agents: AgentId[] }>,
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === sourceUrl)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const members = source.members ? source.members.slice() : []

  for (const update of updates) {
    const memberEntry = update.memberEntry.trim()
    if (!memberEntry) continue
    const memberIdx = members.findIndex((member) => member.entry === memberEntry)
    if (memberIdx !== -1) {
      members[memberIdx] = { ...members[memberIdx], agents: update.agents }
    }
  }

  const sources = skills.sources.slice()
  sources[idx] = { ...source, members }
  return { changed: true, data: { ...skills, sources } }
}

export function setLocalSkillAgents(
  skills: SkillsManifest,
  id: string,
  agents: AgentId[],
): MutationResult<SkillsManifest> {
  assertLocalSkillId(id)
  const idx = skills.skills.findIndex((s) => s.id === id)
  if (idx === -1) return { changed: false, data: skills }
  const list = skills.skills.slice()
  list[idx] = { ...skills.skills[idx], agents }
  return { changed: true, data: { ...skills, skills: list } }
}

// ref is optional — only overwrites when provided (matches `if(body.newRef)`).
export function pinSourceCommit(
  skills: SkillsManifest,
  url: string,
  commit: string,
  ref?: string,
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === url)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const next = ref
    ? { ...source, pinned_commit: commit, ref }
    : { ...source, pinned_commit: commit }
  const sources = skills.sources.slice()
  sources[idx] = next
  return { changed: true, data: { ...skills, sources } }
}

// -- McpServer[] mutations --

export function addMcpServer(mcp: McpServer[], server: McpServer): MutationResult<McpServer[]> {
  return { changed: true, data: [...mcp, server] }
}

export function removeMcpServer(mcp: McpServer[], id: string): MutationResult<McpServer[]> {
  const filtered = mcp.filter((s) => s.id !== id)
  if (filtered.length === mcp.length) return { changed: false, data: mcp }
  return { changed: true, data: filtered }
}

export function updateMcpServer(
  mcp: McpServer[],
  id: string,
  server: McpServer,
): MutationResult<McpServer[]> {
  const idx = mcp.findIndex((item) => item.id === id)
  if (idx === -1) return { changed: false, data: mcp }
  const list = mcp.slice()
  list[idx] = { ...server, id }
  return { changed: true, data: list }
}

export function setMcpAgents(
  mcp: McpServer[],
  id: string,
  agents: AgentId[],
): MutationResult<McpServer[]> {
  const idx = mcp.findIndex((s) => s.id === id)
  if (idx === -1) return { changed: false, data: mcp }
  const list = mcp.slice()
  list[idx] = { ...mcp[idx], agents }
  return { changed: true, data: list }
}

// -- Config mutation (open-ended Record, not Config interface) --

const unsafeConfigPathSegments = new Set(['__proto__', 'prototype', 'constructor'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function setConfigField(
  config: Record<string, unknown>,
  field: string,
  value: unknown,
): { changed: boolean; data: Record<string, unknown> } {
  const parts = field.split('.')
  if (parts.some((part) => !part || unsafeConfigPathSegments.has(part))) {
    throw new Error(`Invalid config field path: ${field}`)
  }

  if (parts.length === 1) {
    if (value === null) {
      if (!Object.hasOwn(config, field)) return { changed: false, data: config }
      const rest = { ...config }
      delete rest[field]
      return { changed: true, data: rest }
    }
    if (Object.hasOwn(config, field) && Object.is(config[field], value)) {
      return { changed: false, data: config }
    }
    return { changed: true, data: { ...config, [field]: value } }
  }

  const [head, ...tail] = parts
  const hasChild = Object.hasOwn(config, head)
  const child = hasChild ? config[head] : undefined
  if (value === null) {
    if (!hasChild) return { changed: false, data: config }
    if (!isPlainRecord(child)) throw new Error(`Config field ${head} is not an object`)
    const result = setConfigField(child as Record<string, unknown>, tail.join('.'), null)
    if (!result.changed) return { changed: false, data: config }
    return { changed: true, data: { ...config, [head]: result.data } }
  }
  if (hasChild && !isPlainRecord(child)) throw new Error(`Config field ${head} is not an object`)
  const base: Record<string, unknown> = hasChild ? (child as Record<string, unknown>) : {}
  const result = setConfigField(base, tail.join('.'), value)
  if (!result.changed && hasChild) return { changed: false, data: config }
  return { changed: true, data: { ...config, [head]: result.data } }
}
