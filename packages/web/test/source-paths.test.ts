import { describe, expect, it } from 'vitest'
import { skillFolderDisplayPath } from '../src/views/skills/source-paths'

describe('source paths', () => {
  it('keeps the complete source-relative folder path', () => {
    expect(skillFolderDisplayPath('plugins/plm-harness/skills/so-apply/SKILL.md')).toBe(
      'plugins/plm-harness/skills/so-apply',
    )
  })
})
