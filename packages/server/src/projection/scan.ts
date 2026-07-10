import { glob } from 'tinyglobby'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { IFileSystem } from '../ports/fs.js'
import { sourceIdentity, type SkillSource, type LocalSkill } from '@loom/core'
import { logger } from '../lib/logger.js'
import { parseSkillMeta } from '../remote/frontmatter.js'

export const DEFAULT_SOURCE_SCAN = '**/SKILL.md'
const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']
export const LOCAL_SKILL_SCAN_IGNORE = ['**/.git/**', '**/node_modules/**']
const scanLogger = logger.child('projection.scan')
const SOURCE_MEMBER_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface ScannedMember {
  name: string
  path: string
  relativePath?: string
  frontmatterName?: string
  description?: string
}

export interface ScannedLocalSkill {
  name: string
  path: string
}

export interface ScanLocalSkillsOptions {
  dot?: boolean
  ignore?: string[]
}

export async function scanSourceMembers(
  repoPath: string,
  src: SkillSource,
): Promise<ScannedMember[]> {
  const pattern = validateSourceScanPattern(src.scan?.trim() || DEFAULT_SOURCE_SCAN)
  const matches = (
    await glob(pattern, { cwd: repoPath, ignore: DEFAULT_IGNORE, onlyFiles: true })
  ).sort((a, b) => a.localeCompare(b, 'en'))
  assertUniqueSourceMemberNames(matches, src)
  const members: ScannedMember[] = []
  for (const match of matches) {
    const memberName = supportedSourceMemberName(match, src)
    if (!memberName) {
      scanLogger.warn('unsupported source skill layout; expected **/SKILL.md', {
        url: src.url,
        path: match,
      })
      continue
    }
    const skillPath = join(repoPath, match)
    const skillDir = join(repoPath, dirname(match))
    let description = ''
    let frontmatterName: string | undefined
    try {
      const content = await readFile(skillPath, 'utf8')
      const meta = parseSkillMeta(content, memberName, skillDir)
      if (!meta) {
        scanLogger.warn('unsupported source skill member name', {
          url: src.url,
          path: match,
          memberName,
        })
        continue
      }
      description = meta.description
      frontmatterName = meta.frontmatterName
    } catch (err) {
      scanLogger.error('failed to read source skill metadata', {
        err,
        url: src.url,
        path: skillPath,
      })
    }
    members.push({
      name: memberName,
      path: skillDir,
      relativePath: match.replace(/\\/g, '/'),
      ...(frontmatterName ? { frontmatterName } : {}),
      description,
    })
  }
  return members.sort((a, b) => a.name.localeCompare(b.name))
}

export function supportedSourceMemberName(
  match: string,
  source?: Pick<SkillSource, 'url'>,
): string | null {
  const normalized = match.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized !== 'SKILL.md' && !normalized.endsWith('/SKILL.md')) return null
  const dir = dirname(normalized)
  if (dir === '.' || dir === '') return source ? sourceIdentity(source).repoId : null
  return basename(dir) || null
}

function assertUniqueSourceMemberNames(matches: string[], source: Pick<SkillSource, 'url'>): void {
  const seen = new Map<string, string>()
  for (const match of matches) {
    const memberName = supportedSourceMemberName(match, source)
    if (!memberName || !SOURCE_MEMBER_NAME_REGEX.test(memberName)) continue
    const normalized = match.replace(/\\/g, '/')
    const previous = seen.get(memberName)
    if (!previous) {
      seen.set(memberName, normalized)
      continue
    }
    throw new Error(
      `Duplicate source skill member name "${memberName}" from ${previous} and ${normalized}`,
    )
  }
}

function validateSourceScanPattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (
    !normalized ||
    isAbsolute(pattern) ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..') ||
    (normalized !== 'SKILL.md' && !normalized.endsWith('/SKILL.md'))
  ) {
    throw new Error(`Invalid source scan pattern "${pattern}"`)
  }
  return normalized
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
  let scanned: ScannedLocalSkill[] = []
  try {
    scanned = await scanLocalSkills(dir)
  } catch (err) {
    scanLogger.error('failed to scan local skills', { err, dir })
    return existing
  }
  const have = new Set(existing.map((s) => s.id))
  const out = [...existing]
  for (const name of [...new Set(scanned.map((skill) => skill.name))]) {
    if (!have.has(name)) out.push({ id: name })
  }
  return out
}

export async function scanLocalSkills(
  rootDir: string,
  options: ScanLocalSkillsOptions = {},
): Promise<ScannedLocalSkill[]> {
  const matches = await glob(DEFAULT_SOURCE_SCAN, {
    cwd: rootDir,
    dot: options.dot,
    ignore: options.ignore ?? DEFAULT_IGNORE,
    onlyFiles: true,
  })
  return matches
    .map((match) => {
      const dir = dirname(match)
      return { name: basename(dir), path: join(rootDir, dir) }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
