import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillSource, AgentId, Manifest, LocalSkill } from '@loom/core'
import { planProjection, deriveRepoId, type ProjectionPlan, type LinkPlan } from '@loom/core'

const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']

export interface ScannedMember {
  name: string
  path: string
}

export async function scanSourceMembers(
  fs: IFileSystem,
  repoPath: string,
  src: SkillSource,
): Promise<ScannedMember[]> {
  const pattern = src.scan ?? '**/SKILL.md'
  void fs
  const matches = await glob(pattern, { cwd: repoPath, ignore: DEFAULT_IGNORE, onlyFiles: true })
  return matches
    .map((m) => ({ name: basename(dirname(m)), path: join(repoPath, dirname(m)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Auto-discover repo-local skills under <repo>/assets/skills and merge them
// into the manifest's local skill list. Skills already registered in
// skills.yaml (with custom targets/enabled) are preserved as-is; newly
// discovered ones are appended as pathless entries that projection resolves
// to assets/skills/<id>.
export async function mergeLocalSkills(
  fs: IFileSystem,
  repoPath: string,
  existing: LocalSkill[],
): Promise<LocalSkill[]> {
  const dir = join(repoPath, 'assets', 'skills')
  if (!(await fs.exists(dir))) return existing
  let matches: string[] = []
  try {
    matches = await glob('**/SKILL.md', { cwd: dir, ignore: DEFAULT_IGNORE, onlyFiles: true })
  } catch {
    return existing
  }
  const have = new Set(existing.map((s) => s.id))
  const out = [...existing]
  for (const name of [...new Set(matches.map((m) => basename(dirname(m))))].sort()) {
    if (!have.has(name)) out.push({ id: name })
  }
  return out
}

export function resolveFullLinks(
  manifest: Manifest,
  scanResults: Map<string, ScannedMember[]>,
  effectiveConfig: Manifest['config'],
  installedAgents: Set<AgentId>,
): ProjectionPlan {
  const base = planProjection(manifest, effectiveConfig, installedAgents)
  const naming = effectiveConfig.skill_naming ?? 'dir'
  const globalTargets = effectiveConfig.targets ?? []
  const skipped: AgentId[] = []
  const activeTargets = (ts: AgentId[]): AgentId[] => {
    const out: AgentId[] = []
    for (const a of ts) {
      if (installedAgents.has(a)) out.push(a)
      else skipped.push(a)
    }
    return out
  }
  const links: LinkPlan[] = base.links.filter((l) => l.source === 'local')
  for (const src of manifest.skills.sources) {
    const repoId = deriveRepoId(src.url)
    const scanned = scanResults.get(src.url) ?? []
    const overrideByName = new Map((src.members ?? []).map((m) => [m.name, m]))
    for (const m of scanned) {
      const ov = overrideByName.get(m.name)
      const enabled = ov?.enabled ?? true
      const ts = activeTargets(enabled === false ? [] : (ov?.targets ?? globalTargets))
      links.push({
        skillId: naming === 'hyphen' ? `${repoId}-${m.name}` : `${repoId}/${m.name}`,
        source: { repoId, memberName: m.name },
        targets: ts,
      })
    }
  }

  const allSkipped = [...new Set([...base.skippedAgents, ...skipped])]
  return { links, mcpEntries: base.mcpEntries, skippedAgents: allSkipped, strategy: base.strategy }
}
