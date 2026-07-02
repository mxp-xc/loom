import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillSource, AgentId, Manifest } from '@loom/core'
import { planProjection, type ProjectionPlan, type LinkPlan } from '@loom/core'

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

export function resolveFullLinks(
  manifest: Manifest,
  scanResults: Map<string, ScannedMember[]>,
  effectiveConfig: Manifest['config'],
  installedAgents: Set<AgentId>,
): ProjectionPlan {
  const base = planProjection(manifest, effectiveConfig, installedAgents)
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
        skillId: `${repoId}-${m.name}`,
        source: { repoId, memberName: m.name },
        targets: ts,
      })
    }
  }

  const allSkipped = [...new Set([...base.skippedAgents, ...skipped])]
  return { links, mcpEntries: base.mcpEntries, skippedAgents: allSkipped, strategy: base.strategy }
}

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1]
    .split('/')
    .pop()!
    .replace(/\.git$/, '')
}
