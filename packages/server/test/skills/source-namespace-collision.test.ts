import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillSource } from '@loom/core'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { SourceNamespaceCollisionError } from '../../src/projection/errors.js'
import { backupUserOwnedSourceNamespace } from '../../src/skills/source-namespace-collision.js'

let root: string
let home: string
let repoPath: string
let namespace: string

const source: SkillSource = {
  name: 'playwright-cli',
  url: 'https://github.com/microsoft/playwright-cli.git',
  ref: 'main',
  pinned_commit: 'a'.repeat(40),
  members: [
    {
      name: 'playwright-cli',
      entry: 'skills/playwright-cli/SKILL.md',
      agents: ['codex'],
    },
  ],
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-source-namespace-collision-'))
  home = join(root, 'home')
  repoPath = join(root, 'repo')
  namespace = join(home, '.codex', 'skills', 'playwright-cli')
  await mkdir(namespace, { recursive: true })
  await mkdir(repoPath)
  await writeFile(join(namespace, 'SKILL.md'), '# user copy')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('backupUserOwnedSourceNamespace', () => {
  it('moves the user-owned namespace outside the skills root before projection', async () => {
    const fs = new NodeFileSystem()
    const project = vi.fn(async () => undefined)

    const result = await backupUserOwnedSourceNamespace(
      { fs, home },
      repoPath,
      source,
      'codex',
      project,
    )

    expect(project).toHaveBeenCalledOnce()
    await expect(fs.exists(namespace)).resolves.toBe(false)
    expect(
      await readFile(join(home, '.codex', 'skill-backups', result.backupName, 'SKILL.md'), 'utf8'),
    ).toBe('# user copy')
  })

  it('restores the original directory when projection fails', async () => {
    const fs = new NodeFileSystem()
    const failure = new Error('projection failed')

    await expect(
      backupUserOwnedSourceNamespace({ fs, home }, repoPath, source, 'codex', async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(await readFile(join(namespace, 'SKILL.md'), 'utf8')).toBe('# user copy')
    await expect(fs.readDir(join(home, '.codex', 'skill-backups'))).resolves.toEqual([])
  })

  it('preserves each confirmed backup while advancing through multiple collisions', async () => {
    const fs = new NodeFileSystem()
    const secondSource: SkillSource = {
      ...source,
      name: 'superpowers',
      url: 'https://github.com/example/superpowers.git',
      members: [
        {
          name: 'superpowers',
          entry: 'skills/superpowers/SKILL.md',
          agents: ['codex'],
        },
      ],
    }
    const secondNamespace = join(home, '.codex', 'skills', 'superpowers')
    await mkdir(secondNamespace, { recursive: true })
    await writeFile(join(secondNamespace, 'SKILL.md'), '# second user copy')
    const nextCollision = new SourceNamespaceCollisionError(
      'codex',
      'superpowers',
      secondSource.url,
      secondNamespace,
    )
    const preserveNextCollision = {
      preserveBackupOnProjectionError: (err: unknown) => err === nextCollision,
    }

    await expect(
      backupUserOwnedSourceNamespace(
        { fs, home },
        repoPath,
        source,
        'codex',
        async () => {
          throw nextCollision
        },
        preserveNextCollision,
      ),
    ).rejects.toBe(nextCollision)

    await expect(fs.exists(namespace)).resolves.toBe(false)
    await expect(fs.exists(secondNamespace)).resolves.toBe(true)

    const secondResult = await backupUserOwnedSourceNamespace(
      { fs, home },
      repoPath,
      secondSource,
      'codex',
      async () => undefined,
      preserveNextCollision,
    )
    const backups = await fs.readDir(join(home, '.codex', 'skill-backups'))

    expect(backups).toHaveLength(2)
    expect(backups).toContain(secondResult.backupName)
    await expect(fs.exists(secondNamespace)).resolves.toBe(false)
  })

  it('does not move a namespace that is no longer desired for the agent', async () => {
    const fs = new NodeFileSystem()
    const disabled = {
      ...source,
      members: source.members?.map((member) => ({ ...member, agents: [] })),
    }

    await expect(
      backupUserOwnedSourceNamespace({ fs, home }, repoPath, disabled, 'codex', async () => {}),
    ).rejects.toThrow('no longer part of desired state')

    expect(await readFile(join(namespace, 'SKILL.md'), 'utf8')).toBe('# user copy')
  })
})
