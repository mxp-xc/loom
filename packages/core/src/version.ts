import type { SkillSource } from './types.js'
import { compare, valid } from 'semver'

export interface RemoteRef {
  tags: Record<string, string>
  branches?: Record<string, string>
  head: string
}
export interface VersionStatus {
  hasUpdate: boolean
  latestTag?: string
  latestCommit: string
}

/**
 * Order tag refs for display: valid SemVer tags by precedence descending,
 * followed by non-SemVer tags sorted by name descending. This keeps version
 * pickers aligned with release order instead of lexicographic string order
 * (where `v0.3.0` would sort above `v0.18.1`).
 */
export function sortTagsByVersion(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => {
    const versionA = valid(a)
    const versionB = valid(b)
    if (versionA && versionB) return compare(versionB, versionA)
    if (versionA) return -1
    if (versionB) return 1
    return a < b ? 1 : a > b ? -1 : 0
  })
}

export function compareVersion(
  local: Pick<SkillSource, 'ref' | 'pinned_commit' | 'type'>,
  remote: RemoteRef,
): VersionStatus {
  const tagKeys = Object.keys(remote.tags)
  const refIsTag = tagKeys.includes(local.ref)
  if (local.type === 'branch' || (local.type !== 'tag' && !refIsTag)) {
    const pinnedCommit = local.pinned_commit ?? ''
    const branchName = local.ref.startsWith('refs/heads/')
      ? local.ref.slice('refs/heads/'.length)
      : local.ref
    const latestCommit =
      remote.branches === undefined
        ? remote.head
        : Object.hasOwn(remote.branches, branchName)
          ? remote.branches[branchName]
          : pinnedCommit
    return { hasUpdate: latestCommit !== pinnedCommit, latestCommit }
  }

  const pinnedCommit = local.pinned_commit ?? ''
  const localVersion = valid(local.ref)
  if (!localVersion) {
    const latestCommit = Object.hasOwn(remote.tags, local.ref)
      ? remote.tags[local.ref]
      : pinnedCommit
    return {
      hasUpdate: latestCommit !== pinnedCommit,
      latestTag: local.ref,
      latestCommit,
    }
  }

  const semverTags = tagKeys.filter((tag) => valid(tag))
  if (semverTags.length === 0) {
    return { hasUpdate: false, latestTag: local.ref, latestCommit: pinnedCommit }
  }
  const latestTag = semverTags.sort((a, b) => compare(valid(a)!, valid(b)!)).at(-1)!
  const latestCommit = remote.tags[latestTag]
  const hasUpdate = latestTag !== local.ref || latestCommit !== pinnedCommit
  return { hasUpdate, latestTag, latestCommit }
}
