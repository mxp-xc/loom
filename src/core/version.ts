import type { SkillSource } from './types.js'

export interface RemoteRef { tags: Record<string, string>; head: string }
export interface VersionStatus { hasUpdate: boolean; latestTag?: string; latestCommit: string }

export function compareVersion(local: Pick<SkillSource, 'ref' | 'pinned_commit'>, remote: RemoteRef): VersionStatus {
  const tagKeys = Object.keys(remote.tags)
  if (tagKeys.length === 0) {
    return { hasUpdate: remote.head !== local.pinned_commit, latestCommit: remote.head }
  }
  const pinnedCommit = local.pinned_commit
  const latestTag = tagKeys.sort(semverCompare).at(-1)!
  const latestCommit = remote.tags[latestTag]
  const hasUpdate = latestCommit !== pinnedCommit
  return { hasUpdate, latestTag, latestCommit }
}

function semverCompare(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d }
  return 0
}
