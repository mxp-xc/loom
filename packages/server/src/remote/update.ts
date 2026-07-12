import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillSource } from '@loom/core'
import { compareVersion, type RemoteRef, type VersionStatus } from '@loom/core'
import { scanSourceMembers, type ScannedMember } from '../projection/scan.js'
import { resolveGitUrl } from './resolve-url.js'
import { isValidGitRepo, installSkill } from './install.js'
import { cacheDirFor } from './cache.js'

export async function checkUpdates(
  sources: SkillSource[],
  git: IGit,
): Promise<(VersionStatus & { source: SkillSource })[]> {
  const out: (VersionStatus & { source: SkillSource })[] = []
  for (const s of sources) {
    const remote: RemoteRef = await git.lsRemote(resolveGitUrl(s.url))
    out.push({
      ...compareVersion({ ref: s.ref, pinned_commit: s.pinned_commit ?? '' }, remote),
      source: s,
    })
  }
  return out
}

export interface UpdateResult {
  pinned_commit: string
  orphans: ScannedMember[]
  newMembers: ScannedMember[]
}

export async function performUpdate(
  git: IGit,
  fs: IFileSystem,
  _source: SkillSource,
  newRef: string,
  repoPath: string,
  sourceId: string,
  oldMembers: Array<Pick<ScannedMember, 'name'>>,
): Promise<UpdateResult> {
  const cacheDir = cacheDirFor(repoPath, sourceId)
  // Repair a corrupt/missing cache before fetching — scan leaves broken .git
  // dirs untouched, so the update button is the designated repair path.
  if (!(await isValidGitRepo(fs, cacheDir))) {
    await installSkill(git, fs, _source.url, newRef, repoPath, sourceId)
  }
  await git.fetch(cacheDir)
  // Fast-forward the local working tree to the remote-tracking branch so the
  // checkout actually moves to the newest commit. Without this, `checkout
  // <branch>` stays on the stale local branch and we'd re-pin the old commit.
  try {
    await git.resetHard(cacheDir, `origin/${newRef}`)
  } catch {
    // ref may be a tag or commit hash — fall back to a plain checkout.
  }
  await git.checkout(cacheDir, newRef)
  const pinned_commit = await git.revParseHead(cacheDir)
  const newMembers = await scanSourceMembers(cacheDir, { ..._source, ref: newRef })
  const newNames = new Set(newMembers.map((m) => m.name))
  const orphans = oldMembers.filter((m) => !newNames.has(m.name))
  return { pinned_commit, orphans, newMembers }
}
