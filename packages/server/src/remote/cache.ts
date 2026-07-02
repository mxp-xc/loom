import { join } from 'node:path'
import { deriveRepoId } from '@loom/core'

export function repoIdFromUrl(url: string): string {
  return deriveRepoId(url)
}

export function cacheDirFor(repoPath: string, sourceId: string): string {
  return join(repoPath, 'remote-cache', sourceId)
}

export function skillPathFor(repoPath: string, repoId: string, memberName: string): string {
  return join(repoPath, 'remote-cache', repoId, 'skills', memberName)
}
