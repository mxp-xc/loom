import { describe, it, expect } from 'vitest'
import { deriveRepoId } from '../src/projection.js'

describe('deriveRepoId', () => {
  it('derives from a standard HTTPS Git URL', () => {
    expect(deriveRepoId('https://gitlab.com/owner/my-repo.git')).toBe('my-repo')
  })
  it('derives from https URL with .git suffix', () => {
    expect(deriveRepoId('https://github.com/owner/my-repo.git')).toBe('my-repo')
  })
  it('derives from an scp-style SSH Git URL', () => {
    expect(deriveRepoId('git@gitcode.com:owner/my-repo.git')).toBe('my-repo')
  })
})
