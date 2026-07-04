import { describe, expect, it } from 'vitest'
import { sortSkillMembers } from '../src/views/skills/types'

describe('sortSkillMembers', () => {
  it('returns a stable name order without mutating the API response', () => {
    const members = [
      { name: 'writing-plans', path: '/writing' },
      { name: 'brainstorming', path: '/brainstorming' },
      { name: 'executing-plans', path: '/executing' },
    ]

    expect(sortSkillMembers(members).map((member) => member.name)).toEqual([
      'brainstorming',
      'executing-plans',
      'writing-plans',
    ])
    expect(members.map((member) => member.name)).toEqual([
      'writing-plans',
      'brainstorming',
      'executing-plans',
    ])
  })
})
