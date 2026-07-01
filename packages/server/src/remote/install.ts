import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import { resolveGitUrl } from './resolve-url.js'

export async function installSkill(
  git: IGit, fs: IFileSystem, url: string, ref: string, repoPath: string, sourceId: string,
): Promise<{ pinned_commit: string; cacheDir: string }> {
  const cacheDir = join(repoPath, 'remote-cache', sourceId)
  if (await fs.exists(cacheDir)) await rm(cacheDir, { recursive: true, force: true })
  try {
    await git.clone(resolveGitUrl(url), cacheDir, false)
    await git.checkout(cacheDir, ref)
    const pinned_commit = await git.revParseHead(cacheDir)
    return { pinned_commit, cacheDir }
  } catch (e) {
    await rm(cacheDir, { recursive: true, force: true })
    throw e
  }
}
