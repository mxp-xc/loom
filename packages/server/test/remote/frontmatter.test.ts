import { describe, it, expect } from 'vitest'
import { parseSkillMeta } from '../../src/remote/frontmatter'

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
  it('rejects invalid name (uppercase)', () => {
    expect(parseSkillMeta('---\nname: BadName\n---\n', 'bad-name', '/p')).toBeNull()
  })
  it('rejects invalid name (spaces)', () => {
    expect(parseSkillMeta('---\nname: bad name\n---\n', 'dir', '/p')).toBeNull()
  })
  it('accepts valid name with hyphens', () => {
    expect(parseSkillMeta('---\nname: my-cool-skill\n---\n', 'dir', '/p')!.name).toBe(
      'my-cool-skill',
    )
  })
})
