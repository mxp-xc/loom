import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import {
  LocalSkillIdSchema,
  LocalSkillSchema,
  type LocalSkill,
  type SkillsManifest,
} from '@loom/core'
import { logger } from '../lib/logger.js'
import type { FileSystemEntry, IFileSystem } from '../ports/fs.js'

const boundaryLogger = logger.child('local-skill-boundary')

export type LocalSkillProvenance = 'manifest-built-in' | 'manifest-external' | 'discovered-built-in'

export interface StableLocalDirectory {
  path: string
  identity: string
}

export interface OwnedBuiltInLocalSkillRoot {
  repository: StableLocalDirectory
  assets: StableLocalDirectory
  directory: StableLocalDirectory
}

export interface PreparedBuiltInLocalSkill {
  id: string
  directory: string
  skillFile: string
  root: OwnedBuiltInLocalSkillRoot
}

export interface ResolvedLocalSkill {
  id: string
  provenance: LocalSkillProvenance
  entry?: LocalSkill
  directory: string
  skillFile: string
  available: boolean
  directoryIdentity?: string
  skillFileIdentity?: string
  builtInRoot?: OwnedBuiltInLocalSkillRoot
}

export class LocalSkillBoundaryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LocalSkillBoundaryError'
  }
}

export function assertLocalSkillIdentifier(value: unknown): asserts value is string {
  if (LocalSkillIdSchema.safeParse(value).success) return
  throw new LocalSkillBoundaryError(400, 'invalid_skill_id', 'Invalid local skill id')
}

export function indexRegisteredLocalSkills(skills: SkillsManifest): Map<string, LocalSkill> {
  const byId = new Map<string, LocalSkill>()
  for (const [index, skill] of skills.skills.entries()) {
    const {
      available: _available,
      skillFilePath: _skillFilePath,
      description: _description,
      ...input
    } = skill
    const parsed = LocalSkillSchema.safeParse(input)
    if (!parsed.success) {
      throw new LocalSkillBoundaryError(
        422,
        'invalid_skills_manifest',
        `Invalid local skill at skills[${index}]`,
        { cause: parsed.error },
      )
    }
    if (byId.has(parsed.data.id)) {
      throw new LocalSkillBoundaryError(
        422,
        'invalid_skills_manifest',
        `Duplicate local skill id: ${parsed.data.id}`,
      )
    }
    byId.set(parsed.data.id, parsed.data)
  }
  return byId
}

export async function resolveRegisteredLocalSkill(
  fs: IFileSystem,
  repoPath: string,
  skills: SkillsManifest,
  id: unknown,
): Promise<ResolvedLocalSkill | null> {
  assertLocalSkillIdentifier(id)
  const entry = indexRegisteredLocalSkills(skills).get(id)
  if (!entry) return null
  return entry.path
    ? resolveExternalLocalSkill(fs, repoPath, entry)
    : resolveBuiltInLocalSkill(fs, repoPath, id, 'manifest-built-in', entry)
}

export async function resolveRegisteredLocalSkills(
  fs: IFileSystem,
  repoPath: string,
  skills: SkillsManifest,
): Promise<Map<string, ResolvedLocalSkill>> {
  const registered = indexRegisteredLocalSkills(skills)
  const resolved = new Map<string, ResolvedLocalSkill>()
  for (const entry of registered.values()) {
    const skill = entry.path
      ? await resolveExternalLocalSkill(fs, repoPath, entry)
      : await resolveBuiltInLocalSkill(fs, repoPath, entry.id, 'manifest-built-in', entry)
    if (skill) resolved.set(entry.id, skill)
  }
  return resolved
}

export async function resolveEffectiveLocalSkill(
  fs: IFileSystem,
  repoPath: string,
  skills: SkillsManifest,
  id: unknown,
): Promise<ResolvedLocalSkill | null> {
  const registered = await resolveRegisteredLocalSkill(fs, repoPath, skills, id)
  if (registered) return registered
  return resolveBuiltInLocalSkill(fs, repoPath, id as string, 'discovered-built-in')
}

export async function discoverBuiltInLocalSkills(
  fs: IFileSystem,
  repoPath: string,
): Promise<ResolvedLocalSkill[]> {
  const root = await resolveBuiltInRoot(fs, repoPath, false)
  if (!root.owned) return []
  let names: string[]
  try {
    names = await fs.readDir(root.owned.directory.path)
  } catch (err) {
    throw ioFailure('Failed to list built-in local skills', err, root.path)
  }
  const discovered: ResolvedLocalSkill[] = []
  for (const name of names.sort()) {
    if (!LocalSkillIdSchema.safeParse(name).success) continue
    const resolved = await resolveBuiltInLocalSkill(fs, repoPath, name, 'discovered-built-in')
    if (resolved?.available) discovered.push(resolved)
  }
  await revalidateStableDirectory(fs, root.owned.directory, 'revalidate built-in local skill root')
  return discovered
}

export async function prepareBuiltInLocalSkill(
  fs: IFileSystem,
  repoPath: string,
  id: unknown,
): Promise<PreparedBuiltInLocalSkill> {
  assertLocalSkillIdentifier(id)
  const root = await requireOwnedBuiltInRoot(fs, repoPath, true)
  const directory = join(root.directory.path, id)
  const existing = await inspect(fs, directory, 'inspect built-in local skill destination')
  if (existing) {
    throw new LocalSkillBoundaryError(
      409,
      'local_skill_exists',
      `Local skill already exists: ${id}`,
    )
  }
  await revalidateStableDirectory(fs, root.directory, 'revalidate built-in local skill root')
  return { id, directory, skillFile: join(directory, 'SKILL.md'), root }
}

export async function preflightBuiltInLocalSkill(
  fs: IFileSystem,
  repoPath: string,
  id: unknown,
): Promise<void> {
  assertLocalSkillIdentifier(id)
  const root = await resolveBuiltInRoot(fs, repoPath, false)
  if (!root.owned) return
  const directory = join(root.owned.directory.path, id)
  const existing = await inspect(fs, directory, 'inspect built-in local skill destination')
  if (existing) {
    throw new LocalSkillBoundaryError(
      409,
      'local_skill_exists',
      `Local skill already exists: ${id}`,
    )
  }
  await revalidateStableDirectory(fs, root.owned.directory, 'revalidate built-in local skill root')
}

export async function resolveOwnedBuiltInLocalSkillRoot(
  fs: IFileSystem,
  repoPath: string,
  create = false,
): Promise<OwnedBuiltInLocalSkillRoot | null> {
  return (await resolveBuiltInRoot(fs, repoPath, create)).owned
}

export async function resolveLocalSkillRepositoryRoot(
  fs: IFileSystem,
  repoPath: string,
): Promise<StableLocalDirectory> {
  const repositoryEntry = await inspect(fs, repoPath, 'inspect repository root')
  if (!repositoryEntry) throw unsafePath('Repository root is missing', repoPath)
  return resolveStableEntry(fs, repoPath, repositoryEntry, 'directory', 'resolve repository root')
}

export function requireAvailableLocalSkill(
  skill: ResolvedLocalSkill | null,
  id: string,
): ResolvedLocalSkill {
  if (skill?.available) return skill
  throw new LocalSkillBoundaryError(
    404,
    skill ? 'local_skill_unavailable' : 'local_skill_not_found',
    `Local skill is unavailable: ${id}`,
  )
}

async function resolveBuiltInLocalSkill(
  fs: IFileSystem,
  repoPath: string,
  id: string,
  provenance: Extract<LocalSkillProvenance, 'manifest-built-in' | 'discovered-built-in'>,
  entry?: LocalSkill,
): Promise<ResolvedLocalSkill | null> {
  assertLocalSkillIdentifier(id)
  const root = await resolveBuiltInRoot(fs, repoPath, false)
  const directory = join(root.path, id)
  const skillFile = join(directory, 'SKILL.md')
  if (!root.owned) return unavailable(id, provenance, directory, skillFile, entry)

  const directoryEntry = await inspect(fs, directory, 'inspect built-in local skill directory')
  if (!directoryEntry) return unavailable(id, provenance, directory, skillFile, entry)
  const stableDirectory = await resolveStableEntry(
    fs,
    directory,
    directoryEntry,
    'directory',
    'resolve local skill directory',
  )
  if (normalize(dirname(stableDirectory.path)) !== root.owned.directory.path) {
    throw unsafePath('Built-in local skill is not a direct child', directory)
  }

  const skillFileEntry = await inspect(fs, skillFile, 'inspect built-in SKILL.md')
  if (!skillFileEntry) {
    return unavailable(
      id,
      provenance,
      stableDirectory.path,
      join(stableDirectory.path, 'SKILL.md'),
      entry,
      stableDirectory.identity,
      root.owned,
    )
  }
  const stableSkillFile = await resolveStableEntry(
    fs,
    skillFile,
    skillFileEntry,
    'file',
    'resolve built-in SKILL.md',
  )
  if (normalize(dirname(stableSkillFile.path)) !== stableDirectory.path) {
    throw unsafePath('Built-in SKILL.md escaped its skill directory', skillFile)
  }
  await revalidateStableDirectory(fs, root.owned.directory, 'revalidate built-in local skill root')
  return {
    id,
    provenance,
    ...(entry ? { entry } : {}),
    directory: stableDirectory.path,
    skillFile: stableSkillFile.path,
    available: true,
    directoryIdentity: stableDirectory.identity,
    skillFileIdentity: stableSkillFile.identity,
    builtInRoot: root.owned,
  }
}

async function resolveExternalLocalSkill(
  fs: IFileSystem,
  repoPath: string,
  entry: LocalSkill & { path?: string },
): Promise<ResolvedLocalSkill> {
  const canonicalRepo = normalize(await realPath(fs, repoPath, 'resolve repository root'))
  const declaredPath = entry.path!
  const directory = normalize(
    isAbsolute(declaredPath) ? declaredPath : resolve(canonicalRepo, declaredPath),
  )
  const skillFile = join(directory, 'SKILL.md')
  const directoryEntry = await inspect(fs, directory, 'inspect external local skill directory')
  if (!directoryEntry) {
    return unavailable(entry.id, 'manifest-external', directory, skillFile, entry)
  }
  const stableDirectory = await resolveStableEntry(
    fs,
    directory,
    directoryEntry,
    'directory',
    'resolve external skill directory',
  )
  const skillFileEntry = await inspect(fs, skillFile, 'inspect external SKILL.md')
  if (!skillFileEntry) {
    return unavailable(
      entry.id,
      'manifest-external',
      stableDirectory.path,
      join(stableDirectory.path, 'SKILL.md'),
      entry,
      stableDirectory.identity,
    )
  }
  const stableSkillFile = await resolveStableEntry(
    fs,
    skillFile,
    skillFileEntry,
    'file',
    'resolve external SKILL.md',
  )
  if (normalize(dirname(stableSkillFile.path)) !== stableDirectory.path) {
    throw unsafePath('External SKILL.md escaped its declared directory', skillFile)
  }
  return {
    id: entry.id,
    provenance: 'manifest-external',
    entry,
    directory: stableDirectory.path,
    skillFile: stableSkillFile.path,
    available: true,
    directoryIdentity: stableDirectory.identity,
    skillFileIdentity: stableSkillFile.identity,
  }
}

async function resolveBuiltInRoot(
  fs: IFileSystem,
  repoPath: string,
  create: boolean,
): Promise<{ path: string; owned: OwnedBuiltInLocalSkillRoot | null }> {
  const repository = await resolveLocalSkillRepositoryRoot(fs, repoPath)
  const assetsDir = join(repository.path, 'assets')
  const skillsDir = join(assetsDir, 'skills')
  let assetsEntry = await inspect(fs, assetsDir, 'inspect repository assets directory')
  if (!assetsEntry && create) {
    await revalidateStableDirectory(fs, repository, 'revalidate repository root')
    await createDirectory(fs, assetsDir, 'create repository assets directory')
    assetsEntry = await inspect(fs, assetsDir, 'inspect created repository assets directory')
  }
  if (!assetsEntry) return { path: skillsDir, owned: null }
  const assets = await resolveStableEntry(
    fs,
    assetsDir,
    assetsEntry,
    'directory',
    'resolve repository assets directory',
  )
  if (assets.path !== normalize(assetsDir)) {
    throw unsafePath('Repository assets directory escaped the repository', assetsDir)
  }
  let skillsEntry = await inspect(fs, skillsDir, 'inspect built-in local skill root')
  if (!skillsEntry && create) {
    await revalidateStableDirectory(fs, repository, 'revalidate repository root')
    await revalidateStableDirectory(fs, assets, 'revalidate repository assets directory')
    await createDirectory(fs, skillsDir, 'create built-in local skill root')
    skillsEntry = await inspect(fs, skillsDir, 'inspect created built-in local skill root')
  }
  if (!skillsEntry) return { path: skillsDir, owned: null }
  const directory = await resolveStableEntry(
    fs,
    skillsDir,
    skillsEntry,
    'directory',
    'resolve local skill root',
  )
  if (directory.path !== normalize(skillsDir)) {
    throw unsafePath('Built-in local skill root escaped the repository', skillsDir)
  }
  await revalidateStableDirectory(fs, repository, 'revalidate repository root')
  await revalidateStableDirectory(fs, assets, 'revalidate repository assets directory')
  return { path: directory.path, owned: { repository, assets, directory } }
}

async function inspect(
  fs: IFileSystem,
  path: string,
  operation: string,
): Promise<FileSystemEntry | null> {
  try {
    return await fs.inspectEntry(path)
  } catch (err) {
    throw ioFailure(operation, err, path)
  }
}

async function realPath(fs: IFileSystem, path: string, operation: string): Promise<string> {
  try {
    return await fs.realPath(path)
  } catch (err) {
    throw ioFailure(operation, err, path)
  }
}

function assertEntryKind(
  entry: FileSystemEntry,
  expected: 'file' | 'directory',
  path: string,
): void {
  if (entry.kind === expected) return
  throw unsafePath(`Expected a real ${expected}, found ${entry.kind}`, path)
}

async function resolveStableEntry(
  fs: IFileSystem,
  path: string,
  before: FileSystemEntry,
  expected: 'file' | 'directory',
  operation: string,
): Promise<StableLocalDirectory> {
  assertEntryKind(before, expected, path)
  const canonical = normalize(await realPath(fs, path, operation))
  const after = await inspect(fs, path, `revalidate ${operation}`)
  const confirmedCanonical = normalize(await realPath(fs, path, `revalidate ${operation}`))
  if (
    after?.kind !== expected ||
    after.identity !== before.identity ||
    confirmedCanonical !== canonical
  ) {
    throw unsafePath('Local skill entry changed during validation', path)
  }
  return { path: canonical, identity: before.identity }
}

async function revalidateStableDirectory(
  fs: IFileSystem,
  directory: StableLocalDirectory,
  operation: string,
): Promise<void> {
  const entry = await inspect(fs, directory.path, operation)
  if (!entry || entry.kind !== 'directory' || entry.identity !== directory.identity) {
    throw unsafePath('Local skill directory changed during validation', directory.path)
  }
  const canonical = normalize(await realPath(fs, directory.path, operation))
  if (canonical !== directory.path) {
    throw unsafePath('Local skill directory changed during validation', directory.path)
  }
}

async function createDirectory(fs: IFileSystem, path: string, operation: string): Promise<void> {
  try {
    await fs.mkdir(path, false)
  } catch (err) {
    if (!isAlreadyExists(err)) throw ioFailure(operation, err, path)
  }
}

function requireOwnedBuiltInRoot(
  fs: IFileSystem,
  repoPath: string,
  create: boolean,
): Promise<OwnedBuiltInLocalSkillRoot> {
  return resolveBuiltInRoot(fs, repoPath, create).then((root) => {
    if (root.owned) return root.owned
    throw new LocalSkillBoundaryError(
      500,
      'local_skill_root_unavailable',
      'Local skill root unavailable',
    )
  })
}

function unavailable(
  id: string,
  provenance: LocalSkillProvenance,
  directory: string,
  skillFile: string,
  entry?: LocalSkill,
  directoryIdentity?: string,
  builtInRoot?: OwnedBuiltInLocalSkillRoot,
): ResolvedLocalSkill {
  return {
    id,
    provenance,
    ...(entry ? { entry } : {}),
    directory,
    skillFile,
    available: false,
    ...(directoryIdentity ? { directoryIdentity } : {}),
    ...(builtInRoot ? { builtInRoot } : {}),
  }
}

function unsafePath(message: string, path: string): LocalSkillBoundaryError {
  return new LocalSkillBoundaryError(422, 'invalid_local_skill_path', `${message}: ${path}`)
}

function ioFailure(operation: string, err: unknown, path: string): LocalSkillBoundaryError {
  boundaryLogger.error(operation, { err, path })
  return new LocalSkillBoundaryError(500, 'local_skill_io_failed', operation, { cause: err })
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
