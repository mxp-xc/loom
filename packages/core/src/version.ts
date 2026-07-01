import type { SkillSource } from './types.js'

export interface RemoteRef {
  tags: Record<string, string>
  head: string
}
export interface VersionStatus {
  hasUpdate: boolean
  latestTag?: string
  latestCommit: string
}

export function compareVersion(
  local: Pick<SkillSource, 'ref' | 'pinned_commit'>,
  remote: RemoteRef,
): VersionStatus {
  const tagKeys = Object.keys(remote.tags)
  // If the user tracks a branch (ref is not a known tag), compare against
  // remote HEAD even when the repo has tags. Only compare tags when ref
  // itself is a tag name (or the repo has no tags at all, falling back to HEAD).
  const refIsTag = tagKeys.includes(local.ref)
  if (tagKeys.length === 0 || !refIsTag) {
    return { hasUpdate: remote.head !== local.pinned_commit, latestCommit: remote.head }
  }
  const pinnedCommit = local.pinned_commit
  const latestTag = tagKeys.sort(semverCompare).at(-1)!
  const latestCommit = remote.tags[latestTag]
  const hasUpdate = latestCommit !== pinnedCommit
  return { hasUpdate, latestTag, latestCommit }
}

function semverCompare(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
