import type { IGit } from '../platform/interfaces.js'

export async function syncPush(repoPath: string, git: IGit): Promise<{ ok: boolean; nonFastForward?: boolean }> {
  return git.push(repoPath)
}
