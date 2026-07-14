import { describe, expect, it } from 'vitest'
import {
  normalizeOrder,
  normalizeSkillGroupOrder,
  skillGroupIds,
  sourceGroupId,
} from '../src/order.js'

describe('order normalization', () => {
  it('deduplicates known ids, ignores unknown ids, and appends missing ids', () => {
    expect(normalizeOrder(['c', 'unknown', 'c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })

  it('falls back to current order for malformed values', () => {
    expect(normalizeOrder(['b', 1], ['a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeOrder('b', ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('normalizes source groups and includes local only when local skills exist', () => {
    const manifest = {
      sources: [
        { url: 'https://example.test/a', ref: 'main' },
        { url: 'https://example.test/b', ref: 'main' },
      ],
      skills: [{ id: 'local-skill' }],
      group_order: ['local', sourceGroupId('https://example.test/b')],
    }
    expect(skillGroupIds(manifest)).toEqual([
      sourceGroupId('https://example.test/a'),
      sourceGroupId('https://example.test/b'),
      'local',
    ])
    expect(normalizeSkillGroupOrder(manifest)).toEqual([
      'local',
      sourceGroupId('https://example.test/b'),
      sourceGroupId('https://example.test/a'),
    ])
    expect(normalizeSkillGroupOrder({ ...manifest, skills: [] })).not.toContain('local')
  })
})
