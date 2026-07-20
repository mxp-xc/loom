import { describe, it, expect } from 'vitest'
import { deriveRepoId } from '../src/projection.js'

describe('deriveRepoId', () => {
  it('derives from a standard HTTPS Git URL without a suffix', () => {
    expect(deriveRepoId('https://gitlab.com/owner/my-repo')).toBe('my-repo')
  })
  it('derives from https URL with .git suffix', () => {
    expect(deriveRepoId('https://github.com/owner/my-repo.git')).toBe('my-repo')
  })
  it('derives from an scp-style SSH Git URL', () => {
    expect(deriveRepoId('git@gitcode.com:owner/my-repo.git')).toBe('my-repo')
  })
  it.each([
    'https://github.com/owner/my-repo.git/',
    'https://github.com/owner/my-repo.git?ref=main',
    'https://github.com/owner/my-repo.git#readme',
  ])('ignores URL suffixes in %s', (url) => {
    expect(deriveRepoId(url)).toBe('my-repo')
  })
  it('supports repository paths without a URL scheme', () => {
    expect(deriveRepoId('owner/my-repo.git')).toBe('my-repo')
  })
  it.each(['', 'https://github.com/', 'git@github.com:'])(
    'rejects %j without a repository name',
    (url) => {
      expect(() => deriveRepoId(url)).toThrow(/repository/i)
    },
  )
})
