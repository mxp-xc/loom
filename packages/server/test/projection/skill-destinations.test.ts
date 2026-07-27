import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { runtimeAgentPathContext } from '../../src/adapters/paths.js'
import {
  captureSkillDestinationDirectoryChain,
  resolveSkillDestinationRoot,
} from '../../src/projection/skill-destinations.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('skill destinations', () => {
  it('resolves agent and shared roots without treating shared as an agent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'loom-skill-destination-'))
    temporaryDirectories.push(home)
    const context = runtimeAgentPathContext(home)

    expect(resolveSkillDestinationRoot({ kind: 'agent', agent: 'codex' }, context)).toBe(
      join(home, '.codex', 'skills'),
    )
    expect(resolveSkillDestinationRoot({ kind: 'shared' }, context)).toBe(
      join(home, '.agents', 'skills'),
    )
  })

  it('uses home as the shared trust root and rejects a linked ancestor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'loom-skill-destination-home-'))
    const outside = await mkdtemp(join(tmpdir(), 'loom-skill-destination-outside-'))
    temporaryDirectories.push(home, outside)
    await symlink(outside, join(home, '.agents'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      captureSkillDestinationDirectoryChain(
        new NodeFileSystem(),
        { kind: 'shared' },
        join(home, '.agents', 'skills'),
        runtimeAgentPathContext(home),
      ),
    ).rejects.toThrow('shared skills destination ancestor is not a real directory')
  })

  it('rejects a relative projection home for shared roots', () => {
    expect(() =>
      resolveSkillDestinationRoot(
        { kind: 'shared' },
        { home: 'relative', env: {}, platform: process.platform },
      ),
    ).toThrow('Projection home must be absolute')
  })
})
