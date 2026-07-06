import { describe, it, expect } from 'vitest'
import { parseSkillFrontmatterName, parseSkillMeta } from '../../src/remote/frontmatter'

describe('parseSkillMeta', () => {
  it('parses frontmatter name + description', () => {
    const m = parseSkillMeta(
      '---\nname: brainstorming\ndescription: A skill\n---\nbody',
      'brainstorming',
      '/p',
    )
    expect(m).not.toBeNull()
    expect(m!.name).toBe('brainstorming')
    expect(m!.description).toBe('A skill')
  })
  it('uses dir name when frontmatter has no name', () => {
    const m = parseSkillMeta('---\ndescription: x\n---\n', 'my-skill', '/p')
    expect(m!.name).toBe('my-skill')
  })
  it('returns dir name when frontmatter name differs', () => {
    expect(parseSkillMeta('---\nname: other-skill\n---\n', 'my-skill', '/p')!.name).toBe('my-skill')
  })
  it('rejects invalid dir name (uppercase)', () => {
    expect(parseSkillMeta('---\nname: bad-name\n---\n', 'BadName', '/p')).toBeNull()
  })
  it('rejects invalid dir name (spaces)', () => {
    expect(parseSkillMeta('---\nname: dir\n---\n', 'bad name', '/p')).toBeNull()
  })
  it('accepts valid dir name with hyphens', () => {
    expect(parseSkillMeta('---\nname: other-skill\n---\n', 'my-cool-skill', '/p')!.name).toBe(
      'my-cool-skill',
    )
  })
  it('reads frontmatter name separately for diagnostics', () => {
    expect(parseSkillFrontmatterName('---\nname: other-skill\n---\n')).toBe('other-skill')
    expect(parseSkillFrontmatterName('---\ndescription: x\n---\n')).toBeNull()
  })
})
