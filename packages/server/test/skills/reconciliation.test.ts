import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { classifySkillMemberChanges } from '../../src/skills/reconciliation.js'

describe('classifySkillMemberChanges', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('classifies added, removed, updated, unchanged, and moved members', async () => {
    const oldRoot = await createRoot({
      removed: { 'SKILL.md': 'removed' },
      changed: { 'SKILL.md': 'old' },
      stable: { 'SKILL.md': 'same' },
      moved: { 'SKILL.md': 'same' },
    })
    const newRoot = await createRoot({
      added: { 'SKILL.md': 'added' },
      changed: { 'SKILL.md': 'new' },
      stable: { 'SKILL.md': 'same' },
      movedElsewhere: { 'SKILL.md': 'same' },
    })

    const changes = await classifySkillMemberChanges(
      new NodeFileSystem(),
      oldRoot,
      newRoot,
      [member('removed'), member('changed'), member('stable'), member('moved', 'moved/SKILL.md')],
      [
        member('added'),
        member('changed'),
        member('stable'),
        member('moved', 'movedElsewhere/SKILL.md'),
      ],
    )

    expect(changes.added.map(({ name }) => name)).toEqual(['added'])
    expect(changes.removed.map(({ name }) => name)).toEqual(['removed'])
    expect(changes.updated.map(({ name }) => name)).toEqual(['changed', 'moved'])
    expect(changes.unchanged.map(({ name }) => name)).toEqual(['stable'])
  })

  it('treats nested resource changes as an update and sorts every list', async () => {
    const oldRoot = await createRoot({
      zebra: { 'SKILL.md': 'same', 'references/guide.md': 'old' },
      alpha: { 'SKILL.md': 'same' },
    })
    const newRoot = await createRoot({
      zebra: { 'SKILL.md': 'same', 'references/guide.md': 'new' },
      alpha: { 'SKILL.md': 'same' },
      beta: { 'SKILL.md': 'new' },
    })

    const changes = await classifySkillMemberChanges(
      new NodeFileSystem(),
      oldRoot,
      newRoot,
      [member('zebra'), member('alpha')],
      [member('zebra'), member('beta'), member('alpha')],
    )

    expect(changes.updated.map(({ name }) => name)).toEqual(['zebra'])
    expect(changes.added.map(({ name }) => name)).toEqual(['beta'])
    expect(changes.unchanged.map(({ name }) => name)).toEqual(['alpha'])
  })

  async function createRoot(skills: Record<string, Record<string, string>>) {
    const root = await mkdtemp(join(tmpdir(), 'loom-reconcile-'))
    roots.push(root)
    for (const [skill, files] of Object.entries(skills)) {
      for (const [relativePath, content] of Object.entries(files)) {
        const file = join(root, skill, relativePath)
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, content)
      }
    }
    return root
  }
})

function member(name: string, path = `${name}/SKILL.md`) {
  return { name, path, targets: name === 'removed' ? (['codex'] as const) : undefined }
}
