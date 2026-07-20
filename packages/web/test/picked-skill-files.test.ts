// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  PickedSkillFileReadError,
  readPickedSkillDirectory,
} from '../src/views/skills/picked-skill-files'

function pickedFile(path: string, content: string | Error): File {
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    text: async () => {
      if (content instanceof Error) throw content
      return content
    },
  } as unknown as File
}

describe('readPickedSkillDirectory', () => {
  it('groups every nested sibling relative to its SKILL.md parent', async () => {
    const picked = await readPickedSkillDirectory([
      pickedFile('workspace/catalog/alpha/references/deep/guide.md', 'guide'),
      pickedFile('workspace/catalog/beta/assets/icon.txt', 'icon'),
      pickedFile('workspace/catalog/alpha/SKILL.md', '# Alpha'),
      pickedFile('workspace/catalog/beta/SKILL.md', '# Beta'),
      pickedFile('workspace/README.md', 'unrelated'),
    ])

    expect(picked.skills).toEqual([
      { name: 'alpha', path: 'alpha' },
      { name: 'beta', path: 'beta' },
    ])
    expect(picked.filesBySkill.get('alpha')).toEqual([
      { path: 'SKILL.md', content: '# Alpha' },
      { path: 'references/deep/guide.md', content: 'guide' },
    ])
    expect(picked.filesBySkill.get('beta')).toEqual([
      { path: 'SKILL.md', content: '# Beta' },
      { path: 'assets/icon.txt', content: 'icon' },
    ])
  })

  it('assigns nested skill files to the deepest SKILL.md parent only', async () => {
    const picked = await readPickedSkillDirectory([
      pickedFile('workspace/parent/SKILL.md', '# Parent'),
      pickedFile('workspace/parent/parent.txt', 'parent'),
      pickedFile('workspace/parent/nested/SKILL.md', '# Nested'),
      pickedFile('workspace/parent/nested/child.txt', 'child'),
    ])

    expect(picked.filesBySkill.get('parent')).toEqual([
      { path: 'SKILL.md', content: '# Parent' },
      { path: 'parent.txt', content: 'parent' },
    ])
    expect(picked.filesBySkill.get('nested')).toEqual([
      { path: 'SKILL.md', content: '# Nested' },
      { path: 'child.txt', content: 'child' },
    ])
  })

  it('fails the whole directory read with the unreadable relative path', async () => {
    const cause = new Error('disk read failed')
    await expect(
      readPickedSkillDirectory([
        pickedFile('workspace/alpha/SKILL.md', '# Alpha'),
        pickedFile('workspace/alpha/references/guide.md', cause),
      ]),
    ).rejects.toMatchObject({
      name: 'PickedSkillFileReadError',
      message: '无法读取 alpha/references/guide.md',
      path: 'alpha/references/guide.md',
      cause,
    } satisfies Partial<PickedSkillFileReadError>)
  })
})
