import { dirname, join, normalize } from 'node:path'
import type { FileSystemEntry, IFileSystem } from '../ports/fs.js'
import { logger } from '../lib/logger.js'

export const REPO_NAME_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const repoLogger = logger.child('repository-access')

export class RepositoryAccessError extends Error {
  constructor(
    readonly status: 400 | 500,
    readonly code: 'invalid_repo' | 'repo_unavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RepositoryAccessError'
  }
}

export class InvalidRepositoryError extends RepositoryAccessError {
  constructor(options?: ErrorOptions) {
    super(400, 'invalid_repo', 'invalid repo', options)
    this.name = 'InvalidRepositoryError'
  }
}

export async function listRepos(fs: IFileSystem, home: string): Promise<string[]> {
  const root = await resolveRepositoryRoot(fs, home)
  if (!root) return []
  const entries = await readRepositoryEntries(fs, root)
  const resolved: RepositoryAuthorization[] = []
  for (const name of entries) {
    if (!isRepoName(name)) continue
    const repository = await resolveDirectRepository(fs, root, name)
    if (repository) resolved.push(repository)
  }
  assertUniqueRepositories(resolved)
  await revalidateRepositoryRoot(fs, root)
  await Promise.all(resolved.map((repository) => revalidateRepository(fs, root, repository)))
  return resolved.map((repository) => repository.name)
}

export async function assertRepositoryRoot(fs: IFileSystem, home: string): Promise<void> {
  const root = await resolveRepositoryRoot(fs, home)
  if (!root) throw new InvalidRepositoryError()
  await revalidateRepositoryRoot(fs, root)
}

export async function resolveRepoPath(
  fs: IFileSystem,
  repo: string,
  home: string,
): Promise<string> {
  return (await authorizeRepository(fs, repo, home)).path
}

export async function authorizeRepository(
  fs: IFileSystem,
  repo: string,
  home: string,
): Promise<RepositoryAuthorization> {
  if (!isRepoName(repo)) throw new InvalidRepositoryError()
  const root = await resolveRepositoryRoot(fs, home)
  if (!root) throw new InvalidRepositoryError()
  const entries = await readRepositoryEntries(fs, root)
  if (!entries.includes(repo)) throw new InvalidRepositoryError()

  const resolved: RepositoryAuthorization[] = []
  for (const name of entries) {
    if (!isRepoName(name)) continue
    const repository = await resolveDirectRepository(fs, root, name)
    if (repository) resolved.push(repository)
  }
  assertUniqueRepositories(resolved)
  const selected = resolved.find((repository) => repository.name === repo)
  if (!selected) throw new InvalidRepositoryError()
  await revalidateRepositoryRoot(fs, root)
  await revalidateRepository(fs, root, selected)
  return selected
}

export async function revalidateRepositoryAuthorization(
  fs: IFileSystem,
  home: string,
  expected: RepositoryAuthorization,
  lockedPath?: string,
): Promise<void> {
  let current: RepositoryAuthorization
  try {
    current = await authorizeRepository(fs, expected.name, home)
  } catch (error) {
    throw unavailable(error)
  }
  if (
    current.path !== expected.path ||
    current.identity !== expected.identity ||
    (lockedPath !== undefined && lockedPath !== expected.path)
  ) {
    throw unavailable(new Error('repository changed after authorization'))
  }
}

function isRepoName(value: unknown): value is string {
  return typeof value === 'string' && REPO_NAME_REGEX.test(value) && !value.includes('..')
}

interface StableDirectory {
  path: string
  canonicalPath: string
  identity: string
}

interface RepositoryRoot extends StableDirectory {
  loom: StableDirectory
}

export interface RepositoryAuthorization {
  name: string
  path: string
  identity: string
}

async function resolveRepositoryRoot(
  fs: IFileSystem,
  home: string,
): Promise<RepositoryRoot | null> {
  let canonicalHome: string
  try {
    canonicalHome = normalize(await fs.realPath(home))
  } catch (err) {
    if (isMissing(err)) return null
    repoLogger.error('repository home resolution failed', { err, home })
    throw unavailable(err)
  }
  const loomPath = join(canonicalHome, '.loom')
  const reposPath = join(loomPath, 'repos')
  const loom = await resolveStableDirectory(fs, loomPath, true)
  if (!loom) return null
  if (loom.canonicalPath !== normalize(loomPath)) {
    throw unavailable(new Error('managed .loom directory is not physical'))
  }
  const repos = await resolveStableDirectory(fs, reposPath, true)
  if (!repos) return null
  if (repos.canonicalPath !== normalize(reposPath)) {
    throw unavailable(new Error('managed repositories root is not physical'))
  }
  await revalidateStableDirectory(fs, loom)
  return { ...repos, loom }
}

async function readRepositoryEntries(fs: IFileSystem, root: RepositoryRoot): Promise<string[]> {
  try {
    return (await fs.readDir(root.path)).sort()
  } catch (err) {
    repoLogger.error('repository root listing failed', { err, path: root.path })
    throw unavailable(err)
  }
}

async function resolveDirectRepository(
  fs: IFileSystem,
  root: RepositoryRoot,
  name: string,
): Promise<RepositoryAuthorization | null> {
  const candidate = join(root.path, name)
  let resolved: StableDirectory | null
  try {
    const entry = await fs.inspectEntry(candidate)
    if (entry?.kind !== 'directory') return null
    resolved = await resolveStableDirectory(fs, candidate, true)
  } catch (err) {
    if (err instanceof RepositoryAccessError) throw err
    repoLogger.error('repository entry validation failed', { err, repo: name, path: candidate })
    throw unavailable(err)
  }
  if (!resolved || normalize(dirname(resolved.canonicalPath)) !== root.canonicalPath) return null
  return { name, path: resolved.canonicalPath, identity: resolved.identity }
}

async function revalidateRepository(
  fs: IFileSystem,
  root: RepositoryRoot,
  expected: RepositoryAuthorization,
): Promise<void> {
  const current = await resolveDirectRepository(fs, root, expected.name)
  if (!current || current.path !== expected.path || current.identity !== expected.identity) {
    throw unavailable(new Error('repository changed during authorization'))
  }
}

async function revalidateRepositoryRoot(fs: IFileSystem, root: RepositoryRoot): Promise<void> {
  await revalidateStableDirectory(fs, root.loom)
  await revalidateStableDirectory(fs, root)
}

async function resolveStableDirectory(
  fs: IFileSystem,
  path: string,
  missingAllowed: boolean,
): Promise<StableDirectory | null> {
  let before: FileSystemEntry | null
  try {
    before = await fs.inspectEntry(path)
  } catch (err) {
    repoLogger.error('repository directory inspection failed', { err, path })
    throw unavailable(err)
  }
  if (!before) {
    if (missingAllowed) return null
    throw unavailable(new Error('repository directory is missing'))
  }
  if (before.kind !== 'directory') {
    throw unavailable(new Error('repository directory is not a real directory'))
  }
  try {
    const canonicalPath = normalize(await fs.realPath(path))
    const after = await fs.inspectEntry(path)
    const confirmedCanonical = normalize(await fs.realPath(path))
    if (
      after?.kind !== 'directory' ||
      after.identity !== before.identity ||
      confirmedCanonical !== canonicalPath
    ) {
      throw unavailable(new Error('repository directory changed during validation'))
    }
    return { path: normalize(path), canonicalPath, identity: before.identity }
  } catch (err) {
    if (err instanceof RepositoryAccessError) throw err
    repoLogger.error('repository directory resolution failed', { err, path })
    throw unavailable(err)
  }
}

async function revalidateStableDirectory(
  fs: IFileSystem,
  expected: StableDirectory,
): Promise<void> {
  const current = await resolveStableDirectory(fs, expected.path, false)
  if (
    !current ||
    current.identity !== expected.identity ||
    current.canonicalPath !== expected.canonicalPath
  ) {
    throw unavailable(new Error('repository directory identity changed'))
  }
}

function assertUniqueRepositories(repositories: RepositoryAuthorization[]): void {
  const canonicalPaths = new Map<string, string>()
  const identities = new Map<string, string>()
  for (const repository of repositories) {
    const previous = canonicalPaths.get(repository.path) ?? identities.get(repository.identity)
    if (previous) {
      const err = unavailable(new Error('repository identity is ambiguous'))
      repoLogger.error('duplicate repository identity detected', {
        err,
        first: previous,
        second: repository.name,
      })
      throw err
    }
    canonicalPaths.set(repository.path, repository.name)
    identities.set(repository.identity, repository.name)
  }
}

function unavailable(cause: unknown): RepositoryAccessError {
  return new RepositoryAccessError(500, 'repo_unavailable', 'repository is unavailable', { cause })
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
