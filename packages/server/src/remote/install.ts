import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import { cacheDirFor } from './cache.js'

// Windows often holds a brief lock on freshly-touched directories (antivirus,
// pending handles, git child processes). Retry with backoff before giving up.
export async function rmRetry(target: string, attempts = 5): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (e) {
      lastErr = e
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
        await delay(300 * (i + 1))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

// Check whether a directory is a usable git working tree (has a .git entry).
// Detects partially-deleted caches left behind by a failed rm on Windows.
export async function isValidGitRepo(fs: IFileSystem, dir: string): Promise<boolean> {
  try {
    return await fs.exists(join(dir, '.git'))
  } catch {
    return false
  }
}

export async function installSkill(
  git: IGit,
  fs: IFileSystem,
  url: string,
  ref: string,
  repoPath: string,
  sourceId: string,
): Promise<{ pinned_commit: string; cacheDir: string }> {
  const cacheDir = cacheDirFor(repoPath, sourceId)
  if (await fs.exists(cacheDir)) await rmRetry(cacheDir)
  try {
    await git.clone(url, cacheDir, false)
    await git.checkout(cacheDir, ref)
    const pinned_commit = await git.revParseHead(cacheDir)
    return { pinned_commit, cacheDir }
  } catch (e) {
    await rmRetry(cacheDir)
    throw e
  }
}
