import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import type { LocalSkill } from '@loom/core'
import { discoverBuiltInLocalSkills } from '../skills/local-paths.js'

const LOCAL_SKILL_PATTERN = '**/SKILL.md'
const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']
export const LOCAL_SKILL_SCAN_IGNORE = ['**/.git/**', '**/node_modules/**']

export interface ScannedLocalSkill {
  name: string
  path: string
}

export interface ScanLocalSkillsOptions {
  dot?: boolean
  ignore?: string[]
}

// Auto-discover repo-local skills under <repo>/assets/skills and merge them
// into the manifest's local skill list. Skills already registered in
// skills.yaml are preserved as-is; newly
// discovered ones are appended as pathless entries that projection resolves
// to assets/skills/<id>.
export async function mergeLocalSkills(
  fs: IFileSystem,
  repoPath: string,
  existing: LocalSkill[],
): Promise<LocalSkill[]> {
  const discovered = await discoverBuiltInLocalSkills(fs, repoPath)
  const have = new Set(existing.map((s) => s.id))
  const out = [...existing]
  for (const skill of discovered) {
    if (!have.has(skill.id)) out.push({ id: skill.id })
  }
  return out
}

export async function scanLocalSkills(
  rootDir: string,
  options: ScanLocalSkillsOptions = {},
): Promise<ScannedLocalSkill[]> {
  const matches = await glob(LOCAL_SKILL_PATTERN, {
    cwd: rootDir,
    dot: options.dot,
    ignore: options.ignore ?? DEFAULT_IGNORE,
    onlyFiles: true,
    followSymbolicLinks: false,
  })
  return matches
    .map((match) => {
      const dir = dirname(match)
      return { name: basename(dir), path: join(rootDir, dir) }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
