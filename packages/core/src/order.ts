import type { SkillsManifest } from './types.js'

export const LOCAL_SKILL_GROUP_ID = 'local'

export function sourceGroupId(url: string): string {
  return `source:${url}`
}

export function skillGroupIds(manifest: Pick<SkillsManifest, 'sources' | 'skills'>): string[] {
  const ids = manifest.sources.map((source) => sourceGroupId(source.url))
  if (manifest.skills.length > 0) ids.push(LOCAL_SKILL_GROUP_ID)
  return ids
}

export function normalizeOrder(saved: unknown, current: readonly string[]): string[] {
  if (!Array.isArray(saved) || saved.some((value) => typeof value !== 'string')) return [...current]

  const known = new Set(current)
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const id of saved) {
    if (!known.has(id) || seen.has(id)) continue
    seen.add(id)
    normalized.push(id)
  }
  for (const id of current) {
    if (!seen.has(id)) normalized.push(id)
  }
  return normalized
}

export function normalizeSkillGroupOrder(
  manifest: Pick<SkillsManifest, 'sources' | 'skills' | 'group_order'>,
): string[] {
  return normalizeOrder(manifest.group_order, skillGroupIds(manifest))
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
