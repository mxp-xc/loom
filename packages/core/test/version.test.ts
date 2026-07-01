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
  it('tag moved to new commit (mutable tag) => hasUpdate', () => {
    const r = compareVersion(
      { ref: 'v5.1.4', pinned_commit: 'aaa' },
      { tags: { 'v5.1.4': 'bbb' }, head: 'bbb' },
    )
    expect(r.hasUpdate).toBe(true)
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
