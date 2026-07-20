import type { SkillSource } from './types.js'
import { compare, valid } from 'semver'

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
  local: Pick<SkillSource, 'ref' | 'pinned_commit' | 'type'>,
  remote: RemoteRef,
): VersionStatus {
  const tagKeys = Object.keys(remote.tags)
  const refIsTag = tagKeys.includes(local.ref)
  if (local.type === 'branch' || (local.type !== 'tag' && !refIsTag)) {
    return { hasUpdate: remote.head !== local.pinned_commit, latestCommit: remote.head }
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
