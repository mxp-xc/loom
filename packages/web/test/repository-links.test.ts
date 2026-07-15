import { describe, expect, it } from 'vitest'
import { inferRepositoryFileWebUrl, inferRepositoryWebUrl } from '../src/lib/repository-links'

describe('inferRepositoryWebUrl', () => {
  it.each([
    ['https://host.example/team/repo.git', 'https://host.example/team/repo'],
    ['http://host.example:8080/team/repo.git/', 'http://host.example:8080/team/repo'],
    [
      'https://token:secret@host.example/team/nested/repo.git?token=hidden#readme',
      'https://host.example/team/nested/repo',
    ],
    [
      'git@gitcode.com:HarnessPlatform/Marketplace.git',
      'https://gitcode.com/HarnessPlatform/Marketplace',
    ],
    ['work:team/repo.git', 'https://work/team/repo'],
    ['ssh://git@host.example:2222/team/repo.git', 'https://host.example/team/repo'],
    ['git://host.example/team/repo.git', 'https://host.example/team/repo'],
  ])('maps %s to %s', (sourceUrl, expected) => {
    expect(inferRepositoryWebUrl(sourceUrl)).toBe(expected)
  })

  it.each([
    '',
    './repo',
    '/tmp/repo',
    'C:\\repos\\skills',
    'file:///tmp/repo',
    'ftp://host.example/team/repo.git',
    'https://host.example',
    'github:owner/repo',
    'gitee:owner/repo',
  ])('rejects %s', (sourceUrl) => {
    expect(inferRepositoryWebUrl(sourceUrl)).toBeNull()
  })
})

describe('inferRepositoryFileWebUrl', () => {
  it.each([
    [
      'git@github.com:owner/repo.git',
      'https://github.com/owner/repo/blob/main/skills/tool/SKILL.md',
    ],
    [
      'https://gitlab.com/owner/repo.git',
      'https://gitlab.com/owner/repo/-/blob/main/skills/tool/SKILL.md',
    ],
    [
      'git@gitcode.com:owner/repo.git',
      'https://gitcode.com/owner/repo/blob/main/skills/tool/SKILL.md',
    ],
    [
      'https://gitee.com/owner/repo.git',
      'https://gitee.com/owner/repo/blob/main/skills/tool/SKILL.md',
    ],
    [
      'git@forge.example:owner/repo.git',
      'https://forge.example/owner/repo/blob/main/skills/tool/SKILL.md',
    ],
  ])('uses the forge file route for %s', (sourceUrl, expected) => {
    expect(inferRepositoryFileWebUrl(sourceUrl, 'main', 'skills/tool/SKILL.md')).toBe(expected)
  })

  it('encodes ref and path segments while preserving hierarchy', () => {
    expect(
      inferRepositoryFileWebUrl(
        'https://github.com/owner/repo.git',
        'feature/new UI',
        'skills/a #1/SKILL.md',
      ),
    ).toBe('https://github.com/owner/repo/blob/feature/new%20UI/skills/a%20%231/SKILL.md')
  })

  it.each([
    ['/tmp/repo', 'main', 'skills/tool/SKILL.md'],
    ['https://github.com/owner/repo.git', '', 'skills/tool/SKILL.md'],
    ['https://github.com/owner/repo.git', 'main', ''],
    ['https://github.com/owner/repo.git', '../main', 'skills/tool/SKILL.md'],
    ['https://github.com/owner/repo.git', 'main', '../outside/SKILL.md'],
  ])('returns null for unusable file input', (sourceUrl, ref, relativePath) => {
    expect(inferRepositoryFileWebUrl(sourceUrl, ref, relativePath)).toBeNull()
  })
})
