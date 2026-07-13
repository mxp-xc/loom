import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { SourceUpdateSessionStore } from '../../src/skills/update-sessions.js'

describe('SourceUpdateSessionStore', () => {
  const roots: string[] = []
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  )

  it('recovers a prepared session after the store is recreated', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'loom-update-session-'))
    roots.push(repoPath)
    const fs = new NodeFileSystem()
    const stagingDir = join(repoPath, 'temp', 'source-updates', 'staged')
    await fs.mkdir(stagingDir, true)
    const first = new SourceUpdateSessionStore(fs)
    const created = await first.create({
      repoPath,
      source: { url: 'https://example.test/skills.git', ref: 'main' },
      newRef: 'main',
      prepared: {
        pinned_commit: 'abc',
        stagingDir,
        newMembers: [],
        changes: { added: [], updated: [], removed: [{ name: 'old' }], unchanged: [] },
      },
    })

    const recovered = await new SourceUpdateSessionStore(fs).get(created.id, repoPath)
    expect(recovered).toMatchObject({ id: created.id, pinned_commit: 'abc', repoPath })
    expect(await fs.exists(stagingDir)).toBe(true)
  })
})
