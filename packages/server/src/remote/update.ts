import { join } from 'node:path'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillSource } from '@loom/core'
import { compareVersion, type RemoteRef, type VersionStatus } from '@loom/core'
import { scanSourceMembers, type ScannedMember } from '../projection/scan.js'
import { resolveGitUrl } from './resolve-url.js'

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
  oldMembers: ScannedMember[],
): Promise<UpdateResult> {
  const cacheDir = join(repoPath, 'remote-cache', sourceId)
  await git.fetch(cacheDir)
  await git.checkout(cacheDir, newRef)
  const pinned_commit = await git.revParseHead(cacheDir)
  const newMembers = await scanSourceMembers(fs, cacheDir, { url: _source.url, ref: newRef })
  const newNames = new Set(newMembers.map((m) => m.name))
  const orphans = oldMembers.filter((m) => !newNames.has(m.name))
  return { pinned_commit, orphans, newMembers }
}
