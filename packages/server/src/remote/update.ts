import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillSource } from '@loom/core'
import { compareVersion, type RemoteRef, type VersionStatus } from '@loom/core'
import { scanSourceMembers, type ScannedMember } from '../projection/scan.js'
import { isValidGitRepo, installSkill } from './install.js'
import { cacheDirFor } from './cache.js'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  classifySkillMemberChanges,
  normalizeSkillPath,
  type SkillMemberChangeSet,
  type SkillMemberSnapshot,
} from '../skills/reconciliation.js'
import { logger } from '../lib/logger.js'

const updateLogger = logger.child('remote.update')

export async function checkUpdates(
  sources: SkillSource[],
  git: IGit,
): Promise<(VersionStatus & { source: SkillSource })[]> {
  const out: (VersionStatus & { source: SkillSource })[] = []
  for (const s of sources) {
    const remote: RemoteRef = await git.lsRemote(s.url)
    out.push({
      ...compareVersion({ ref: s.ref, pinned_commit: s.pinned_commit ?? '' }, remote),
      source: s,
    })
  }
  return out
}

export interface UpdateResult {
  pinned_commit: string
  orphans: Array<Pick<ScannedMember, 'name'>>
  newMembers: ScannedMember[]
}

export interface PreparedSourceUpdate {
  pinned_commit: string
  stagingDir: string
  newMembers: ScannedMember[]
  changes: SkillMemberChangeSet
}

export async function prepareSourceUpdate(
  git: IGit,
  fs: IFileSystem,
  source: SkillSource,
  newRef: string,
  repoPath: string,
  sourceId: string,
  oldMembers: SkillMemberSnapshot[],
): Promise<PreparedSourceUpdate> {
  const cacheDir = cacheDirFor(repoPath, sourceId)
  const stagingDir = join(repoPath, 'temp', 'source-updates', randomUUID())
  await fs.mkdir(stagingDir, true)
  try {
    for (const member of oldMembers) {
      const skillPath = normalizeSkillPath(member.path)
      const sourceDir = join(cacheDir, dirname(skillPath))
      if (await fs.exists(sourceDir)) await fs.copyDir(sourceDir, join(stagingDir, member.name))
    }
    if (!(await isValidGitRepo(fs, cacheDir))) {
      await installSkill(git, fs, source.url, newRef, repoPath, sourceId)
    }
    await git.fetch(cacheDir)
    try {
      await git.resetHard(cacheDir, `origin/${newRef}`)
    } catch (err) {
      updateLogger.warn('remote-tracking reset failed; falling back to checkout', {
        err,
        source: source.url,
        ref: newRef,
      })
    }
    await git.checkout(cacheDir, newRef)
    const pinned_commit = await git.revParseHead(cacheDir)
    const newMembers = await scanSourceMembers(cacheDir, { ...source, ref: newRef })
    const previousSnapshots = oldMembers.map((member) => ({
      ...member,
      path: `${member.name}/SKILL.md`,
    }))
    const nextSnapshots = newMembers.map((member) => ({
      name: member.name,
      path: member.relativePath ?? 'SKILL.md',
    }))
    const changes = await classifySkillMemberChanges(
      fs,
      stagingDir,
      cacheDir,
      previousSnapshots,
      nextSnapshots,
    )
    return { pinned_commit, stagingDir, newMembers, changes }
  } catch (err) {
    if (source.pinned_commit) {
      try {
        await git.resetHard(cacheDir, source.pinned_commit)
        await git.checkout(cacheDir, source.ref)
      } catch (rollbackError) {
        updateLogger.error('source update rollback failed', {
          err: rollbackError,
          originalError: err,
          source: source.url,
        })
      }
    }
    await fs.removeDir(stagingDir)
    updateLogger.error('source update prepare failed', { err, source: source.url, ref: newRef })
    throw err
  }
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
  } catch (err) {
    updateLogger.warn('remote-tracking reset failed; falling back to checkout', {
      err,
      source: _source.url,
      ref: newRef,
    })
    // ref may be a tag or commit hash — fall back to a plain checkout.
  }
  await git.checkout(cacheDir, newRef)
  const pinned_commit = await git.revParseHead(cacheDir)
  const newMembers = await scanSourceMembers(cacheDir, { ..._source, ref: newRef })
  const newNames = new Set(newMembers.map((m) => m.name))
  const orphans = oldMembers.filter((m) => !newNames.has(m.name))
  return { pinned_commit, orphans, newMembers }
}
