import { randomUUID } from 'node:crypto'
import { join, normalize } from 'node:path'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import {
  assertAuthorizedSourceCache,
  assertSourceCacheDestinationAvailable,
  assertStablePhysicalDirectory,
  createSourceCacheStaging,
  inspectDirectDirectory,
  prepareSourceCacheDestination,
  removeStablePhysicalDirectory,
  resolveSourceCache,
} from './cache-boundary.js'

// Check whether a directory is a usable git working tree (has a .git entry).
// Detects partially-deleted caches left behind by a failed rm on Windows.
export async function isValidGitRepo(fs: IFileSystem, dir: string): Promise<boolean> {
  try {
    const directory = await fs.inspectEntry(dir)
    if (directory?.kind !== 'directory' || normalize(await fs.realPath(dir)) !== normalize(dir))
      return false
    const confirmedDirectory = await fs.inspectEntry(dir)
    if (
      confirmedDirectory?.kind !== 'directory' ||
      confirmedDirectory.identity !== directory.identity
    )
      return false
    const gitPath = join(dir, '.git')
    const gitDirectory = await fs.inspectEntry(gitPath)
    if (
      gitDirectory?.kind !== 'directory' ||
      normalize(await fs.realPath(gitPath)) !== normalize(gitPath)
    )
      return false
    const confirmedGitDirectory = await fs.inspectEntry(gitPath)
    return (
      confirmedGitDirectory?.kind === 'directory' &&
      confirmedGitDirectory.identity === gitDirectory.identity
    )
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export async function installSkill(
  git: IGit,
  fs: IFileSystem,
  url: string,
  ref: string,
  repoPath: string,
  sourceId: string,
): Promise<{ pinned_commit: string; cacheDir: string }> {
  const { root, destination: cacheDir } = await prepareSourceCacheDestination(
    fs,
    repoPath,
    sourceId,
  )
  const staging = await createSourceCacheStaging(fs, root, `.loom-cache-install-${randomUUID()}`)
  const candidatePath = join(staging.path, 'candidate')
  let stagingRemoved = false
  let installedDirectory: { path: string; identity: string } | null = null
  try {
    await fs.writeFile(
      join(staging.path, '.loom-source-cache-owner.json'),
      JSON.stringify({ version: 1, token: randomUUID(), sourceId }),
    )
    await git.clone(url, candidatePath, false)
    await git.checkout(candidatePath, ref)
    const pinned_commit = await git.revParseHead(candidatePath)
    const candidate = await inspectDirectDirectory(
      fs,
      staging,
      'candidate',
      'source cache candidate',
    )
    if (!candidate) throw new Error('Source cache candidate is unavailable')
    const gitDirectory = await inspectDirectDirectory(
      fs,
      candidate,
      '.git',
      'source cache candidate metadata',
    )
    if (!gitDirectory) throw new Error('Source cache candidate metadata is unavailable')
    await assertStablePhysicalDirectory(fs, staging, 'revalidate source cache staging')
    await assertSourceCacheDestinationAvailable(fs, root, sourceId)
    const promoted = await fs.moveNoReplace(candidate.path, cacheDir, candidate.identity)
    if (promoted.kind !== 'directory') throw new Error('Installed source cache is not a directory')
    installedDirectory = { path: cacheDir, identity: promoted.identity }
    const installed = await resolveSourceCache(fs, repoPath, sourceId)
    if (!installed || installed.directory.identity !== promoted.identity) {
      throw new Error('Installed source cache identity changed')
    }
    await assertAuthorizedSourceCache(fs, installed)
    await removeStablePhysicalDirectory(fs, staging, 'source cache staging')
    stagingRemoved = true
    return { pinned_commit, cacheDir }
  } catch (error) {
    if (stagingRemoved) throw error
    const cleanupErrors: unknown[] = []
    if (installedDirectory) {
      try {
        await removeStablePhysicalDirectory(fs, installedDirectory, 'installed source cache')
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    try {
      await removeStablePhysicalDirectory(fs, staging, 'source cache staging')
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'source cache installation and cleanup failed',
        {
          cause: error,
        },
      )
    }
    throw error
  }
}
