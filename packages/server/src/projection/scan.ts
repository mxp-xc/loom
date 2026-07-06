import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillSource, LocalSkill } from '@loom/core'
import { logger } from '../lib/logger.js'

const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']
const scanLogger = logger.child('projection.scan')

export interface ScannedMember {
  name: string
  path: string
}

export async function scanSourceMembers(
  repoPath: string,
  src: SkillSource,
): Promise<ScannedMember[]> {
  const pattern = src.scan ?? '**/SKILL.md'
  const matches = await glob(pattern, { cwd: repoPath, ignore: DEFAULT_IGNORE, onlyFiles: true })
  const members: ScannedMember[] = []
  for (const match of matches) {
    const memberName = supportedSourceMemberName(match)
    if (!memberName) {
      scanLogger.warn('unsupported source skill layout; expected skills/<name>/SKILL.md', {
        url: src.url,
        path: match,
      })
      continue
    }
    members.push({ name: memberName, path: join(repoPath, dirname(match)) })
  }
  return members.sort((a, b) => a.name.localeCompare(b.name))
}

export function supportedSourceMemberName(match: string): string | null {
  const parts = match.split(/[/\\]+/)
  if (parts.length !== 3 || parts[0] !== 'skills' || parts[2] !== 'SKILL.md') return null
  return parts[1] || null
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
  } catch (err) {
    scanLogger.error('failed to scan local skills', { err, dir })
    return existing
  }
  const have = new Set(existing.map((s) => s.id))
  const out = [...existing]
  for (const name of [...new Set(matches.map((m) => basename(dirname(m))))].sort()) {
    if (!have.has(name)) out.push({ id: name })
  }
  return out
}
