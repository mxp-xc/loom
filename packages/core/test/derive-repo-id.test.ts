import { describe, it, expect } from 'vitest'
import { deriveRepoId } from '../src/projection.js'

describe('deriveRepoId', () => {
  it('derives from github:owner/repo shorthand', () => {
    expect(deriveRepoId('github:owner/my-repo')).toBe('my-repo')
  })
  it('derives from https URL with .git suffix', () => {
    expect(deriveRepoId('https://github.com/owner/my-repo.git')).toBe('my-repo')
  })
  it('derives from ssh URL', () => {
    expect(deriveRepoId('git@github.com:owner/my-repo.git')).toBe('my-repo')
  })
})
