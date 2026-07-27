import { glob } from 'tinyglobby'
import { join, dirname, basename, normalize, resolve } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import { LocalSkillIdSchema, type LocalSkill } from '@loom/core'
import { discoverBuiltInLocalSkills } from '../skills/local-paths.js'

const LOCAL_SKILL_PATTERN = '**/SKILL.md'
const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']
export const LOCAL_SKILL_SCAN_IGNORE = ['**/.git/**', '**/node_modules/**']
export const PROJECTION_MARKER_NAME = '.loom-projection.json'
const EXTERNAL_SCAN_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])

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

export async function scanUnmanagedLocalSkills(
  fs: IFileSystem,
  rootDir: string,
  registeredIds: ReadonlySet<string> = new Set(),
): Promise<ScannedLocalSkill[]> {
  const requestedRoot = normalize(resolve(rootDir))
  const requestedRootEntry = await fs.inspectEntry(requestedRoot)
  if (!requestedRootEntry) return []
  if (requestedRootEntry.kind !== 'directory') {
    throw new Error(`Local skill scan root is not a physical directory: ${requestedRoot}`)
  }
  const root = normalize(await fs.realPath(requestedRoot))
  const rootEntry = await fs.inspectEntry(root)
  if (rootEntry?.kind !== 'directory' || rootEntry.identity !== requestedRootEntry.identity) {
    throw new Error(`Local skill scan root identity changed during scan: ${requestedRoot}`)
  }

  const scanned: ScannedLocalSkill[] = []
  await visit(root, rootEntry.identity)
  await assertStableDirectory(root, rootEntry.identity)
  return scanned.sort((left, right) => {
    return left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
  })

  async function visit(directory: string, expectedIdentity: string): Promise<void> {
    const canonical = normalize(await fs.realPath(directory))
    if (canonical !== directory) {
      throw new Error(`Local skill scan directory is not canonical: ${directory}`)
    }
    const names = (await fs.readDir(directory)).sort()
    await assertStableDirectory(directory, expectedIdentity)
    if (names.includes(PROJECTION_MARKER_NAME)) return

    if (names.includes('SKILL.md')) {
      const name = basename(directory)
      const skillFile = join(directory, 'SKILL.md')
      const skillEntry = await fs.inspectEntry(skillFile)
      if (skillEntry?.kind !== 'file') {
        throw new Error(`Local skill file changed during scan: ${skillFile}`)
      }
      const canonicalSkillFile = normalize(await fs.realPath(skillFile))
      const confirmedSkillEntry = await fs.inspectEntry(skillFile)
      if (
        canonicalSkillFile !== skillFile ||
        confirmedSkillEntry?.kind !== 'file' ||
        confirmedSkillEntry.identity !== skillEntry.identity
      ) {
        throw new Error(`Local skill file identity changed during scan: ${skillFile}`)
      }
      if (!registeredIds.has(name) && LocalSkillIdSchema.safeParse(name).success) {
        scanned.push({ name, path: directory })
      }
    }

    for (const name of names) {
      if (
        name === PROJECTION_MARKER_NAME ||
        name === 'SKILL.md' ||
        EXTERNAL_SCAN_IGNORED_DIRECTORIES.has(name)
      ) {
        continue
      }
      const child = join(directory, name)
      const entry = await fs.inspectEntry(child)
      if (!entry) {
        throw new Error(`Local skill scan entry changed during scan: ${child}`)
      }
      if (entry.kind === 'directory') await visit(child, entry.identity)
    }
    await assertStableDirectory(directory, expectedIdentity)
  }

  async function assertStableDirectory(directory: string, expectedIdentity: string): Promise<void> {
    const entry = await fs.inspectEntry(directory)
    if (entry?.kind !== 'directory' || entry.identity !== expectedIdentity) {
      throw new Error(`Local skill directory identity changed during scan: ${directory}`)
    }
    if (normalize(await fs.realPath(directory)) !== directory) {
      throw new Error(`Local skill directory identity changed during scan: ${directory}`)
    }
  }
}
