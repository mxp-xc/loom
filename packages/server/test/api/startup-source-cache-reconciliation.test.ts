import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { warmManagedSourceCaches } from '../../src/api/router.js'
import { ResourceLeaseCoordinator } from '../../src/concurrency/resource-lease-coordinator.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IGit } from '../../src/ports/git.js'
import { SourceProjectionCatalog } from '../../src/projection/source-catalog.js'
import { SourceCacheHealthCatalog } from '../../src/remote/source-cache-health.js'

const PIN = 'a'.repeat(40)

let home: string
let repoPath: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'loom-startup-source-cache-'))
  repoPath = join(home, '.loom', 'repos', 'default')
  await mkdir(repoPath, { recursive: true })
  await writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: default\n')
  await writeFile(join(repoPath, 'config.yaml'), 'agents: []\n')
  await writeFile(
    join(repoPath, 'skills.yaml'),
    [
      'sources:',
      '  - name: source-a',
      '    url: https://example.test/source-a.git',
      '    ref: main',
      `    pinned_commit: ${PIN}`,
      '    members: []',
      'skills: []',
      '',
    ].join('\n'),
  )
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('warmManagedSourceCaches', () => {
  it('restores a missing source cache at startup', async () => {
    const git = mockGit()
    const leases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const runMutation = vi.spyOn(leases, 'runMutation')

    await warmManagedSourceCaches({
      fs: new NodeFileSystem(),
      git,
      proc: {} as never,
      home,
      leases,
      sourceProjectionCatalog: new SourceProjectionCatalog(),
      sourceCacheHealthCatalog: new SourceCacheHealthCatalog(),
    })

    expect(git.clone).toHaveBeenCalledTimes(1)
    expect(runMutation).toHaveBeenCalledTimes(1)
    await expect(
      readFile(join(repoPath, 'remote-cache', 'source-a', 'commit.txt'), 'utf8'),
    ).resolves.toBe(PIN)
  })

  it('does not contact the remote when every startup cache already matches', async () => {
    const cachePath = join(repoPath, 'remote-cache', 'source-a')
    await mkdir(join(cachePath, '.git'), { recursive: true })
    await writeFile(join(cachePath, 'commit.txt'), PIN)
    const git = mockGit()
    const leases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const runMutation = vi.spyOn(leases, 'runMutation')

    await warmManagedSourceCaches({
      fs: new NodeFileSystem(),
      git,
      proc: {} as never,
      home,
      leases,
      sourceProjectionCatalog: new SourceProjectionCatalog(),
      sourceCacheHealthCatalog: new SourceCacheHealthCatalog(),
    })

    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
    expect(runMutation).not.toHaveBeenCalled()
  })
})

function mockGit(): IGit {
  return {
    clone: vi.fn(async (_url: string, destination: string) => {
      await mkdir(join(destination, '.git'), { recursive: true })
    }),
    checkout: vi.fn(async (path: string, ref: string) => {
      await writeFile(join(path, 'commit.txt'), ref)
    }),
    revParseHead: vi.fn(async (path: string) => readFile(join(path, 'commit.txt'), 'utf8')),
    readTree: vi.fn(async () => []),
  } as Partial<IGit> as IGit
}
