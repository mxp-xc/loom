import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { sourceIdentity, type AgentId, type SkillSource } from '@loom/core'
import { agentConfigDir, agentSkillsDir, runtimeAgentPathContext } from '../adapters/paths.js'
import type { IFileSystem } from '../ports/fs.js'
import {
  captureAgentDirectoryChain,
  ensureSafeDirectoryChain,
  revalidateSafeDirectoryChain,
  revalidateStableEntry,
} from '../projection/fs-boundary.js'
import { inspectManagedSourceNamespace } from '../projection/executor.js'

export interface SourceNamespaceBackupResult {
  agent: AgentId
  sourceName: string
  backupName: string
}

export interface SourceNamespaceBackupOptions {
  preserveBackupOnProjectionError?: (err: unknown) => boolean
}

export async function backupUserOwnedSourceNamespace(
  deps: { fs: IFileSystem; home: string },
  repoPath: string,
  source: SkillSource,
  agent: AgentId,
  project: () => Promise<void>,
  options: SourceNamespaceBackupOptions = {},
): Promise<SourceNamespaceBackupResult> {
  if (!(source.members ?? []).some((member) => (member.agents ?? []).includes(agent))) {
    throw new Error('Source namespace collision is no longer part of desired state')
  }

  const pathContext = runtimeAgentPathContext(deps.home)
  const sourceName = sourceIdentity(source).repoId
  const skillsDir = agentSkillsDir(agent, pathContext)
  const namespace = join(skillsDir, sourceName)
  const skillsChain = await captureAgentDirectoryChain(
    deps.fs,
    agent,
    'skills',
    skillsDir,
    pathContext,
  )
  const ownership = await inspectManagedSourceNamespace(deps.fs, namespace, {
    ownerRepo: repoPath,
    sourceKey: createHash('sha256').update(source.url).digest('hex'),
    sourceName,
  })
  if (ownership.state !== 'unowned' || !ownership.destination) {
    throw new Error('Source namespace collision changed before it could be resolved')
  }

  const backupRoot = join(agentConfigDir(agent, pathContext), 'skill-backups')
  const backupChain = await captureAgentDirectoryChain(
    deps.fs,
    agent,
    'skills',
    backupRoot,
    pathContext,
  )
  const stableBackupChain = await ensureSafeDirectoryChain(
    deps.fs,
    backupChain,
    `${agent} skill backup destination`,
  )
  const backupName = `${sourceName}-${randomUUID()}`
  const backupPath = join(backupRoot, backupName)

  await revalidateSafeDirectoryChain(deps.fs, skillsChain, `${agent} skills destination`)
  await revalidateSafeDirectoryChain(
    deps.fs,
    stableBackupChain,
    `${agent} skill backup destination`,
  )
  await revalidateStableEntry(deps.fs, ownership.destination, 'user-owned source namespace')
  await deps.fs.moveDirectoryAtomic(namespace, backupPath, ownership.destination.identity)

  try {
    await project()
  } catch (err) {
    if (options.preserveBackupOnProjectionError?.(err)) throw err
    try {
      await revalidateSafeDirectoryChain(deps.fs, skillsChain, `${agent} skills destination`)
      await revalidateSafeDirectoryChain(
        deps.fs,
        stableBackupChain,
        `${agent} skill backup destination`,
      )
      if (await deps.fs.inspectEntry(namespace)) {
        throw new Error('Projection left a destination at the source namespace')
      }
      const backup = await deps.fs.inspectEntry(backupPath)
      if (backup?.kind !== 'directory' || backup.identity !== ownership.destination.identity) {
        throw new Error('Source namespace backup identity changed before rollback')
      }
      await deps.fs.moveDirectoryAtomic(backupPath, namespace, backup.identity)
    } catch (rollbackError) {
      throw new AggregateError(
        [err, rollbackError],
        'source namespace backup projection and rollback failed',
        { cause: err },
      )
    }
    throw err
  }

  return { agent, sourceName, backupName }
}
