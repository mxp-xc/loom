import { describe, it, expect } from 'vitest'
import { groupConflicts } from '../../src/sync/conflicts'

describe('groupConflicts', () => {
  it('maps Conflict[] to ConflictGroup', () => {
    const g = groupConflicts('skills.yaml', [
      { file: 'skills.yaml', path: 'github:x/y', field: 'ref', base: 'v1', ours: 'v2', theirs: 'v3' },
    ])
    expect(g.file).toBe('skills.yaml')
    expect(g.items).toHaveLength(1)
    expect(g.items[0].path).toBe('github:x/y')
    expect(g.items[0].field).toBe('ref')
  })
})
