import { join } from 'node:path'

export function cacheDirFor(repoPath: string, sourceId: string): string {
  return join(repoPath, 'remote-cache', ...sourceId.split('/'))
}

export function skillPathFor(repoPath: string, sourceId: string, memberName: string): string {
  return join(repoPath, 'remote-cache', ...sourceId.split('/'), 'skills', memberName)
}
