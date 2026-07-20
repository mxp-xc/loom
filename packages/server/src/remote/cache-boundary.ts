import { dirname, join, normalize } from 'node:path'
import type { FileSystemEntry, IFileSystem } from '../ports/fs.js'

type CacheFileSystem = Pick<
  IFileSystem,
  'inspectEntry' | 'realPath' | 'mkdir' | 'removeDir' | 'removeEntryIfIdentity'
>

export interface StablePhysicalDirectory {
  path: string
  identity: string
}

export interface SourceCacheRoot extends StablePhysicalDirectory {
  repository: StablePhysicalDirectory
}

export interface AuthorizedSourceCache {
  root: SourceCacheRoot
  directory: StablePhysicalDirectory
  gitDirectory: StablePhysicalDirectory
}

export class SourceCacheBoundaryError extends Error {
  constructor(
    readonly status: 409 | 422 | 500,
    readonly code: 'source_cache_collision' | 'invalid_source_cache' | 'source_cache_unavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SourceCacheBoundaryError'
  }
}

export async function resolveSourceCacheRoot(
  fs: CacheFileSystem,
  repoPath: string,
  create = false,
): Promise<SourceCacheRoot | null> {
  const repository = await requireCanonicalDirectory(fs, repoPath, 'repository root')
  const path = join(repository.path, 'remote-cache')
  let entry = await inspect(fs, path, 'inspect source cache root')
  if (!entry && create) {
    await assertStablePhysicalDirectory(fs, repository, 'revalidate repository root')
    try {
      await fs.mkdir(path, false)
    } catch (error) {
      if (!isAlreadyExists(error)) throw unavailable('failed to create source cache root', error)
    }
    entry = await inspect(fs, path, 'inspect created source cache root')
  }
  if (!entry) return null
  const directory = await authorizeDirectory(fs, path, entry, 'source cache root')
  if (
    directory.path !== normalize(path) ||
    normalize(dirname(directory.path)) !== repository.path
  ) {
    throw invalid('source cache root escaped the repository')
  }
  await assertStablePhysicalDirectory(fs, repository, 'revalidate repository root')
  return { ...directory, repository }
}

export async function resolveSourceCache(
  fs: CacheFileSystem,
  repoPath: string,
  sourceId: string,
): Promise<AuthorizedSourceCache | null> {
  assertSourceCacheId(sourceId)
  const root = await resolveSourceCacheRoot(fs, repoPath)
  if (!root) return null
  const directory = await inspectDirectDirectory(fs, root, sourceId, 'source cache')
  if (!directory) return null
  const gitDirectory = await inspectDirectDirectory(fs, directory, '.git', 'source cache metadata')
  if (!gitDirectory) throw invalid('source cache metadata is missing')
  const cache = { root, directory, gitDirectory }
  await assertAuthorizedSourceCache(fs, cache)
  return cache
}

export async function prepareSourceCacheDestination(
  fs: CacheFileSystem,
  repoPath: string,
  sourceId: string,
): Promise<{ root: SourceCacheRoot; destination: string }> {
  assertSourceCacheId(sourceId)
  const root = await resolveSourceCacheRoot(fs, repoPath, true)
  if (!root) throw unavailable('source cache root is unavailable')
  const destination = join(root.path, sourceId)
  await assertSourceCacheDestinationAvailable(fs, root, sourceId)
  return { root, destination }
}

export async function assertSourceCacheDestinationAvailable(
  fs: CacheFileSystem,
  root: SourceCacheRoot,
  sourceId: string,
): Promise<void> {
  assertSourceCacheId(sourceId)
  await assertStablePhysicalDirectory(fs, root.repository, 'revalidate repository root')
  await assertStablePhysicalDirectory(fs, root, 'revalidate source cache root')
  if (await inspect(fs, join(root.path, sourceId), 'inspect source cache destination')) {
    throw new SourceCacheBoundaryError(
      409,
      'source_cache_collision',
      'Source cache destination already exists',
    )
  }
}

export async function createSourceCacheStaging(
  fs: CacheFileSystem,
  root: SourceCacheRoot,
  name: string,
): Promise<StablePhysicalDirectory> {
  if (!/^\.loom-cache-install-[0-9a-f-]+$/i.test(name)) {
    throw invalid('source cache staging name is invalid')
  }
  await assertStablePhysicalDirectory(fs, root, 'revalidate source cache root')
  const path = join(root.path, name)
  try {
    await fs.mkdir(path, false)
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new SourceCacheBoundaryError(
        409,
        'source_cache_collision',
        'Source cache staging destination already exists',
        { cause: error },
      )
    }
    throw unavailable('failed to create source cache staging', error)
  }
  const staging = await inspectDirectDirectory(fs, root, name, 'source cache staging')
  if (!staging) throw unavailable('source cache staging is unavailable')
  return staging
}

export async function inspectDirectDirectory(
  fs: CacheFileSystem,
  parent: StablePhysicalDirectory,
  name: string,
  description: string,
): Promise<StablePhysicalDirectory | null> {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw invalid(`${description} name is invalid`)
  }
  await assertStablePhysicalDirectory(fs, parent, `revalidate ${description} parent`)
  const path = join(parent.path, name)
  const entry = await inspect(fs, path, `inspect ${description}`)
  if (!entry) return null
  const directory = await authorizeDirectory(fs, path, entry, description)
  if (directory.path !== normalize(path) || normalize(dirname(directory.path)) !== parent.path) {
    throw invalid(`${description} escaped its authorized parent`)
  }
  await assertStablePhysicalDirectory(fs, parent, `revalidate ${description} parent`)
  return directory
}

export async function assertAuthorizedSourceCache(
  fs: CacheFileSystem,
  cache: AuthorizedSourceCache,
): Promise<void> {
  await assertStablePhysicalDirectory(fs, cache.root.repository, 'revalidate repository root')
  await assertStablePhysicalDirectory(fs, cache.root, 'revalidate source cache root')
  await assertStablePhysicalDirectory(fs, cache.directory, 'revalidate source cache')
  await assertStablePhysicalDirectory(fs, cache.gitDirectory, 'revalidate source cache metadata')
}

export async function assertStablePhysicalDirectory(
  fs: CacheFileSystem,
  directory: StablePhysicalDirectory,
  description: string,
): Promise<void> {
  const entry = await inspect(fs, directory.path, description)
  if (!entry || entry.kind !== 'directory' || entry.identity !== directory.identity) {
    throw invalid(`${description} changed during authorization`)
  }
  let canonical: string
  try {
    canonical = normalize(await fs.realPath(directory.path))
  } catch (error) {
    throw unavailable(`failed to resolve ${description}`, error)
  }
  const after = await inspect(fs, directory.path, description)
  if (
    canonical !== directory.path ||
    after?.kind !== 'directory' ||
    after.identity !== directory.identity
  ) {
    throw invalid(`${description} changed during authorization`)
  }
}

export async function removeStablePhysicalDirectory(
  fs: CacheFileSystem,
  directory: StablePhysicalDirectory,
  description: string,
): Promise<void> {
  await assertStablePhysicalDirectory(fs, directory, description)
  try {
    await fs.removeEntryIfIdentity(directory.path, directory.identity)
  } catch (error) {
    throw unavailable(`failed to remove ${description}`, error)
  }
}

function assertSourceCacheId(sourceId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(sourceId) || sourceId.includes('..')) {
    throw invalid('source cache id is invalid')
  }
}

async function requireCanonicalDirectory(
  fs: CacheFileSystem,
  path: string,
  description: string,
): Promise<StablePhysicalDirectory> {
  const entry = await inspect(fs, path, `inspect ${description}`)
  if (!entry) throw invalid(`${description} is missing`)
  const directory = await authorizeDirectory(fs, path, entry, description)
  if (directory.path !== normalize(path)) throw invalid(`${description} is not canonical`)
  return directory
}

async function authorizeDirectory(
  fs: CacheFileSystem,
  path: string,
  before: FileSystemEntry,
  description: string,
): Promise<StablePhysicalDirectory> {
  if (before.kind !== 'directory') throw invalid(`${description} is not a physical directory`)
  let canonical: string
  try {
    canonical = normalize(await fs.realPath(path))
  } catch (error) {
    throw unavailable(`failed to resolve ${description}`, error)
  }
  const after = await inspect(fs, path, `revalidate ${description}`)
  if (after?.kind !== 'directory' || after.identity !== before.identity) {
    throw invalid(`${description} changed during authorization`)
  }
  return { path: canonical, identity: after.identity }
}

async function inspect(
  fs: CacheFileSystem,
  path: string,
  description: string,
): Promise<FileSystemEntry | null> {
  try {
    return await fs.inspectEntry(path)
  } catch (error) {
    throw unavailable(`failed to ${description}`, error)
  }
}

function invalid(message: string, cause?: unknown): SourceCacheBoundaryError {
  return new SourceCacheBoundaryError(422, 'invalid_source_cache', message, { cause })
}

function unavailable(message: string, cause?: unknown): SourceCacheBoundaryError {
  return new SourceCacheBoundaryError(500, 'source_cache_unavailable', message, { cause })
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
