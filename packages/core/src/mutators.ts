import type { SkillsManifest, McpServer, AgentId, LocalSkill } from './types.js'

export type MutationResult<T> = { changed: boolean; data: T }

// -- SkillsManifest mutations --

export function addLocalSkill(
  skills: SkillsManifest,
  skill: LocalSkill,
): MutationResult<SkillsManifest> {
  return { changed: true, data: { ...skills, skills: [...skills.skills, skill] } }
}

export function removeLocalSkill(
  skills: SkillsManifest,
  id: string,
): MutationResult<SkillsManifest> {
  const filtered = skills.skills.filter((s) => s.id !== id)
  if (filtered.length === skills.skills.length) return { changed: false, data: skills }
  return { changed: true, data: { ...skills, skills: filtered } }
}

export function addSource(
  skills: SkillsManifest,
  source: { url: string; ref: string },
): MutationResult<SkillsManifest> {
  return { changed: true, data: { ...skills, sources: [...skills.sources, source] } }
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
  updates: { ref?: string; type?: 'branch' | 'tag' },
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === url)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const next: typeof source = { ...source }
  if (updates.ref !== undefined) next.ref = updates.ref
  if (updates.type !== undefined) next.type = updates.type
  const sources = skills.sources.slice()
  sources[idx] = next
  return { changed: true, data: { ...skills, sources } }
}

// Keep existing member config (targets/enabled) for names that remain;
// drop members not in the new selection. New names get { name } only.
export function setSourceMembers(
  skills: SkillsManifest,
  url: string,
  memberNames: string[],
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === url)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  const prev = new Map((source.members ?? []).map((m) => [m.name, m]))
  const members = memberNames.map((name) => prev.get(name) ?? { name })
  const sources = skills.sources.slice()
  sources[idx] = { ...source, members }
  return { changed: true, data: { ...skills, sources } }
}

export function setSkillTargets(
  skills: SkillsManifest,
  sourceUrl: string,
  memberName: string,
  targets: AgentId[],
): MutationResult<SkillsManifest> {
  const idx = skills.sources.findIndex((s) => s.url === sourceUrl)
  if (idx === -1) return { changed: false, data: skills }
  const source = skills.sources[idx]
  let next: typeof source
  if (!memberName || !memberName.trim()) {
    // Source-level targets (applies to all members without explicit targets)
    next = { ...source, targets } as typeof source
  } else {
    const members = source.members ? source.members.slice() : []
    const memberIdx = members.findIndex((m) => m.name === memberName)
    if (memberIdx === -1) {
      members.push({ name: memberName, targets })
    } else {
      members[memberIdx] = { ...members[memberIdx], targets }
    }
    next = { ...source, members }
  }
  const sources = skills.sources.slice()
  sources[idx] = next
  return { changed: true, data: { ...skills, sources } }
}

export function setLocalSkillTargets(
  skills: SkillsManifest,
  id: string,
  targets: AgentId[],
): MutationResult<SkillsManifest> {
  const idx = skills.skills.findIndex((s) => s.id === id)
  if (idx === -1) {
    return { changed: true, data: { ...skills, skills: [...skills.skills, { id, targets }] } }
  }
  const list = skills.skills.slice()
  list[idx] = { ...skills.skills[idx], targets }
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

export function setMcpTargets(
  mcp: McpServer[],
  id: string,
  targets: AgentId[],
): MutationResult<McpServer[]> {
  const idx = mcp.findIndex((s) => s.id === id)
  if (idx === -1) return { changed: false, data: mcp }
  const list = mcp.slice()
  list[idx] = { ...mcp[idx], targets }
  return { changed: true, data: list }
}

// -- Config mutation (open-ended Record, not Config interface) --

export function setConfigField(
  config: Record<string, unknown>,
  field: string,
  value: unknown,
): { changed: boolean; data: Record<string, unknown> } {
  const parts = field.split('.')
  if (parts.length === 1) {
    // Top-level field — original behavior
    if (value === null) {
      if (!(field in config)) return { changed: false, data: config }
      const rest = { ...config }
      delete rest[field]
      return { changed: true, data: rest }
    }
    if (Object.is(config[field], value)) return { changed: false, data: config }
    return { changed: true, data: { ...config, [field]: value } }
  }

  // Dot-path: traverse into nested objects
  const [head, ...tail] = parts
  const child = config[head]
  if (value === null) {
    if (child === undefined || typeof child !== 'object' || child === null) {
      return { changed: false, data: config }
    }
    const result = setConfigField(child as Record<string, unknown>, tail.join('.'), null)
    if (!result.changed) return { changed: false, data: config }
    return { changed: true, data: { ...config, [head]: result.data } }
  }
  const base = typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {}
  const result = setConfigField(base, tail.join('.'), value)
  if (!result.changed && head in config) return { changed: false, data: config }
  return { changed: true, data: { ...config, [head]: result.data } }
}
