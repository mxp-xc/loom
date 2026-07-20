import { describe, it, expect } from 'vitest'
import { compareVersion } from '../src/version'

describe('compareVersion', () => {
  it('hasUpdate when remote has newer tag', () => {
    const r = compareVersion(
      { ref: 'v5.1.4', pinned_commit: 'aaa' },
      { tags: { 'v5.1.4': 'aaa', 'v5.1.5': 'bbb' }, head: 'bbb' },
    )
    expect(r.hasUpdate).toBe(true)
    expect(r.latestTag).toBe('v5.1.5')
    expect(r.latestCommit).toBe('bbb')
  })
  it('no update when pinned commit matches latest tag commit', () => {
    const r = compareVersion(
      { ref: 'v5.1.4', pinned_commit: 'aaa' },
      { tags: { 'v5.1.4': 'aaa' }, head: 'aaa' },
    )
    expect(r.hasUpdate).toBe(false)
    expect(r.latestTag).toBe('v5.1.4')
    expect(r.latestCommit).toBe('aaa')
  })
  it('hasUpdate when latest tag name changed even if it points to the pinned commit', () => {
    const r = compareVersion(
      { ref: 'v6.0.3', pinned_commit: 'bbb' },
      { tags: { 'v6.0.3': 'aaa', 'v6.1.1': 'bbb' }, head: 'bbb' },
    )
    expect(r.hasUpdate).toBe(true)
    expect(r.latestTag).toBe('v6.1.1')
    expect(r.latestCommit).toBe('bbb')
  })
  it('tag moved to new commit (mutable tag) => hasUpdate', () => {
    const r = compareVersion(
      { ref: 'v5.1.4', pinned_commit: 'aaa' },
      { tags: { 'v5.1.4': 'bbb' }, head: 'bbb' },
    )
    expect(r.hasUpdate).toBe(true)
  })
  it('orders stable releases after prereleases', () => {
    const r = compareVersion(
      { ref: 'v2.0.0-beta.2', pinned_commit: 'aaa' },
      {
        tags: {
          'v2.0.0-beta.2': 'aaa',
          'v2.0.0-beta.10': 'bbb',
          'v2.0.0': 'ccc',
        },
        head: 'ccc',
      },
    )

    expect(r).toEqual({ hasUpdate: true, latestTag: 'v2.0.0', latestCommit: 'ccc' })
  })
  it('ignores arbitrary tags when tracking a SemVer tag', () => {
    const r = compareVersion(
      { ref: 'v1.0.0', pinned_commit: 'aaa' },
      { tags: { 'v1.0.0': 'aaa', nightly: 'bbb' }, head: 'bbb' },
    )

    expect(r).toEqual({ hasUpdate: false, latestTag: 'v1.0.0', latestCommit: 'aaa' })
  })
  it('only checks the same tag when tracking an arbitrary tag', () => {
    const r = compareVersion(
      { ref: 'release-2', pinned_commit: 'aaa' },
      { tags: { 'release-2': 'aaa', 'release-10': 'bbb' }, head: 'bbb' },
    )

    expect(r).toEqual({ hasUpdate: false, latestTag: 'release-2', latestCommit: 'aaa' })
  })
  it('detects a moved arbitrary tag', () => {
    const r = compareVersion(
      { ref: 'stable', pinned_commit: 'aaa' },
      { tags: { stable: 'bbb' }, head: 'bbb' },
    )

    expect(r).toEqual({ hasUpdate: true, latestTag: 'stable', latestCommit: 'bbb' })
  })
  it.each(['__proto__', 'constructor', 'toString'])(
    'does not treat inherited %s as a remote tag',
    (ref) => {
      expect(
        compareVersion(
          { ref, pinned_commit: 'aaa', type: 'tag' },
          { tags: {}, head: 'branch-commit' },
        ),
      ).toEqual({ hasUpdate: false, latestTag: ref, latestCommit: 'aaa' })
    },
  )
  it('supports an own __proto__ tag on a prototype-free tag map', () => {
    const tags = Object.create(null) as Record<string, string>
    tags.__proto__ = 'bbb'

    expect(
      compareVersion(
        { ref: '__proto__', pinned_commit: 'aaa', type: 'tag' },
        { tags, head: 'branch-commit' },
      ),
    ).toEqual({ hasUpdate: true, latestTag: '__proto__', latestCommit: 'bbb' })
  })
  it('uses HEAD for an explicit branch even when a tag has the same name', () => {
    const r = compareVersion(
      { ref: 'stable', pinned_commit: 'aaa', type: 'branch' },
      { tags: { stable: 'tag-commit' }, head: 'branch-commit' },
    )

    expect(r).toEqual({ hasUpdate: true, latestCommit: 'branch-commit' })
  })
  it('finds the latest SemVer tag when the tracked tag disappeared', () => {
    const r = compareVersion(
      { ref: 'v1.0.0', pinned_commit: 'aaa', type: 'tag' },
      { tags: { 'v1.1.0': 'bbb' }, head: 'branch-commit' },
    )

    expect(r).toEqual({ hasUpdate: true, latestTag: 'v1.1.0', latestCommit: 'bbb' })
  })
  it('does not switch a missing arbitrary tag to branch HEAD', () => {
    const r = compareVersion(
      { ref: 'stable', pinned_commit: 'aaa', type: 'tag' },
      { tags: {}, head: 'branch-commit' },
    )

    expect(r).toEqual({ hasUpdate: false, latestTag: 'stable', latestCommit: 'aaa' })
  })
  it('no-tag repo: head mismatch => update', () => {
    const r = compareVersion({ ref: 'main', pinned_commit: 'aaa' }, { tags: {}, head: 'bbb' })
    expect(r.hasUpdate).toBe(true)
    expect(r.latestCommit).toBe('bbb')
  })
  it('no-tag repo: head matches pinned => no update', () => {
    const r = compareVersion({ ref: 'main', pinned_commit: 'aaa' }, { tags: {}, head: 'aaa' })
    expect(r.hasUpdate).toBe(false)
  })
  it('branch ref on tagged repo: head moved, no new tag => update via HEAD', () => {
    const r = compareVersion(
      { ref: 'main', pinned_commit: 'aaa' },
      { tags: { 'v5.1.4': 'aaa' }, head: 'bbb' },
    )
    expect(r.hasUpdate).toBe(true)
    expect(r.latestCommit).toBe('bbb')
    expect(r.latestTag).toBeUndefined()
  })
  it('branch ref on tagged repo: head unchanged => no update despite tags', () => {
    const r = compareVersion(
      { ref: 'main', pinned_commit: 'aaa' },
      { tags: { 'v5.1.4': 'aaa', 'v5.1.5': 'bbb' }, head: 'aaa' },
    )
    expect(r.hasUpdate).toBe(false)
  })
})
