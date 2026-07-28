import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IGit } from '../../src/ports/git.js'
import { SourceProjectionCatalog } from '../../src/projection/source-catalog.js'
import { SourceCacheHealthCatalog } from '../../src/remote/source-cache-health.js'
import { reconcileSourceCachesAfterSync } from '../../src/remote/source-cache-reconciliation.js'

const FIRST_PIN = 'a'.repeat(40)
const SECOND_PIN = 'b'.repeat(40)
const OLD_PIN = 'c'.repeat(40)

let root: string
let repoPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-source-cache-reconcile-'))
  repoPath = join(root, 'repo')
  await mkdir(repoPath, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('reconcileSourceCachesAfterSync', () => {
  it('installs a missing cache at the exact pinned commit', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    const git = mockGit()

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result).toMatchObject({
      restored: ['https://example.test/first.git'],
      unchanged: [],
      unavailable: [],
    })
    expect(git.clone).toHaveBeenCalledTimes(1)
    expect(git.checkout).toHaveBeenCalledWith(expect.any(String), FIRST_PIN)
    await expect(cacheCommit('first')).resolves.toBe(FIRST_PIN)
  })

  it('replaces a stale cache only after preparing the pinned candidate', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const git = mockGit()

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result.restored).toEqual(['https://example.test/first.git'])
    await expect(cacheCommit('first')).resolves.toBe(FIRST_PIN)
    await expect(readFile(join(cachePath('first'), 'origin.txt'), 'utf8')).resolves.toBe(
      'https://example.test/first.git',
    )
  })

  it('does not contact the remote when the live cache already matches', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', FIRST_PIN, 'current-cache')
    const git = mockGit()

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result).toMatchObject({
      restored: [],
      unchanged: ['https://example.test/first.git'],
      unavailable: [],
    })
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
  })

  it('keeps one failed source unchanged while restoring the remaining sources', async () => {
    await writeManifest([source('first', FIRST_PIN), source('second', SECOND_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const git = mockGit({ failingUrl: 'https://example.test/first.git' })

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result.restored).toEqual(['https://example.test/second.git'])
    expect(result.unavailable).toHaveLength(1)
    expect(result.unavailable[0]?.source.url).toBe('https://example.test/first.git')
    expect(result.unavailable[0]?.err).toBeInstanceOf(Error)
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
    await expect(cacheCommit('second')).resolves.toBe(SECOND_PIN)
  })

  it('does not resolve an invalid pin from a moving ref', async () => {
    await writeManifest([source('first', 'main')])
    const git = mockGit()

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result.unavailable).toHaveLength(1)
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
  })

  it('rejects abbreviated and malformed object ids without contacting the remote', async () => {
    await writeManifest([source('first', 'a'.repeat(12)), source('second', 'b'.repeat(41))])
    const git = mockGit()

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result.unavailable).toHaveLength(2)
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.checkout).not.toHaveBeenCalled()
  })

  it('rejects a semantically invalid manifest before contacting a source remote', async () => {
    await writeFile(
      join(repoPath, 'skills.yaml'),
      [
        'sources:',
        '  - name: first',
        '    url: https://example.test/shared.git',
        '    ref: main',
        `    pinned_commit: ${FIRST_PIN}`,
        '    members: []',
        '  - name: second',
        '    url: https://example.test/shared.git',
        '    ref: main',
        `    pinned_commit: ${SECOND_PIN}`,
        '    members: []',
        'skills: []',
        '',
      ].join('\n'),
    )
    const git = mockGit()

    await expect(
      reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath),
    ).rejects.toThrow(/duplicate source URL/)
    expect(git.clone).not.toHaveBeenCalled()
  })

  it('keeps the previous cache when checkout fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const git = mockGit()
    vi.mocked(git.checkout).mockRejectedValueOnce(new Error('simulated checkout failure'))

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result.unavailable).toHaveLength(1)
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('keeps the previous cache when SourceTree validation fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const git = mockGit()
    vi.mocked(git.readTree).mockRejectedValueOnce(new Error('simulated SourceTree failure'))

    const result = await reconcileSourceCachesAfterSync({ fs: new NodeFileSystem(), git }, repoPath)

    expect(result.unavailable).toHaveLength(1)
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('throws a hard failure without moving the previous cache when journal persistence fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    class JournalFailureFileSystem extends NodeFileSystem {
      override async writeFileExclusive(path: string, content: string, mode?: number) {
        if (path.endsWith('.loom-source-cache-reconciliation-journal.json')) {
          throw new Error('simulated journal persistence failure')
        }
        return super.writeFileExclusive(path, content, mode)
      }
    }

    await expect(
      reconcileSourceCachesAfterSync(
        { fs: new JournalFailureFileSystem(), git: mockGit() },
        repoPath,
      ),
    ).rejects.toMatchObject({ name: 'SourceCacheReconciliationHardError' })
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('finishes a journaled swap after the previous cache was moved to backup', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const fs = new NodeFileSystem()
    const workspace = await createJournaledWorkspace(fs, 'first', FIRST_PIN)
    const live = (await fs.inspectEntry(cachePath('first')))!
    await fs.moveDirectoryAtomic(cachePath('first'), join(workspace, 'backup'), live.identity)

    const result = await reconcileSourceCachesAfterSync({ fs, git: mockGit() }, repoPath)

    expect(result.restored).toEqual(['https://example.test/first.git'])
    await expect(cacheCommit('first')).resolves.toBe(FIRST_PIN)
    expect(await fs.inspectEntry(workspace)).toBeNull()
  })

  it('cleans a journaled backup after the candidate was already promoted', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const fs = new NodeFileSystem()
    const workspace = await createJournaledWorkspace(fs, 'first', FIRST_PIN)
    const live = (await fs.inspectEntry(cachePath('first')))!
    const candidate = (await fs.inspectEntry(join(workspace, 'candidate')))!
    await fs.moveDirectoryAtomic(cachePath('first'), join(workspace, 'backup'), live.identity)
    await fs.moveDirectoryAtomic(
      join(workspace, 'candidate'),
      cachePath('first'),
      candidate.identity,
    )

    const result = await reconcileSourceCachesAfterSync({ fs, git: mockGit() }, repoPath)

    expect(result.restored).toEqual(['https://example.test/first.git'])
    expect(result.unchanged).toEqual([])
    expect(await fs.inspectEntry(workspace)).toBeNull()
  })

  it('treats journal metadata inspection failure during recovery as a hard error', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    await createJournaledWorkspace(new NodeFileSystem(), 'first', FIRST_PIN)
    class JournalInspectionFailureFileSystem extends NodeFileSystem {
      override async inspectEntry(path: string) {
        if (path.endsWith('.loom-source-cache-reconciliation-journal.json')) {
          throw new Error('simulated journal metadata inspection failure')
        }
        return super.inspectEntry(path)
      }
    }

    await expect(
      reconcileSourceCachesAfterSync(
        { fs: new JournalInspectionFailureFileSystem(), git: mockGit() },
        repoPath,
      ),
    ).rejects.toMatchObject({ name: 'SourceCacheReconciliationHardError' })
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('restores the previous cache when candidate promotion fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    class PromotionFailureFileSystem extends NodeFileSystem {
      private failed = false

      override async moveDirectoryAtomic(
        sourcePath: string,
        destination: string,
        identity: string,
      ) {
        if (!this.failed && sourcePath.endsWith(join('candidate'))) {
          this.failed = true
          throw new Error('simulated candidate promotion failure')
        }
        return super.moveDirectoryAtomic(sourcePath, destination, identity)
      }
    }
    const fs = new PromotionFailureFileSystem()

    const result = await reconcileSourceCachesAfterSync({ fs, git: mockGit() }, repoPath)

    expect(result.unavailable).toHaveLength(1)
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('keeps the previous cache when moving it to backup fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    class BackupFailureFileSystem extends NodeFileSystem {
      override async moveDirectoryAtomic(
        sourcePath: string,
        destination: string,
        identity: string,
      ) {
        if (destination.endsWith('backup')) throw new Error('simulated backup move failure')
        return super.moveDirectoryAtomic(sourcePath, destination, identity)
      }
    }

    const result = await reconcileSourceCachesAfterSync(
      { fs: new BackupFailureFileSystem(), git: mockGit() },
      repoPath,
    )

    expect(result.unavailable).toHaveLength(1)
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('rolls back the promoted cache when completed workspace cleanup fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    class CleanupFailureFileSystem extends NodeFileSystem {
      private failed = false

      override async removeEntryIfIdentity(path: string, identity: string) {
        if (!this.failed && path.includes('.loom-cache-reconcile-')) {
          this.failed = true
          throw new Error('simulated workspace cleanup failure')
        }
        return super.removeEntryIfIdentity(path, identity)
      }
    }

    const result = await reconcileSourceCachesAfterSync(
      { fs: new CleanupFailureFileSystem(), git: mockGit() },
      repoPath,
    )

    expect(result.unavailable).toHaveLength(1)
    await expect(cacheCommit('first')).resolves.toBe(OLD_PIN)
  })

  it('throws a hard failure when candidate promotion and rollback both fail', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    class RollbackFailureFileSystem extends NodeFileSystem {
      override async moveDirectoryAtomic(
        sourcePath: string,
        destination: string,
        identity: string,
      ) {
        if (sourcePath.endsWith('candidate')) throw new Error('simulated promotion failure')
        if (sourcePath.endsWith('backup')) throw new Error('simulated rollback failure')
        return super.moveDirectoryAtomic(sourcePath, destination, identity)
      }
    }

    await expect(
      reconcileSourceCachesAfterSync(
        { fs: new RollbackFailureFileSystem(), git: mockGit() },
        repoPath,
      ),
    ).rejects.toMatchObject({ name: 'SourceCacheReconciliationHardError' })
  })

  it('refreshes runtime catalogs after restoring a source cache', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const sourceProjectionCatalog = new SourceProjectionCatalog()
    const sourceCacheHealthCatalog = new SourceCacheHealthCatalog()
    const invalidateProjection = vi.spyOn(sourceProjectionCatalog, 'invalidateSource')
    const invalidateHealth = vi.spyOn(sourceCacheHealthCatalog, 'invalidateSource')

    await reconcileSourceCachesAfterSync(
      {
        fs: new NodeFileSystem(),
        git: mockGit(),
        sourceProjectionCatalog,
        sourceCacheHealthCatalog,
      },
      repoPath,
    )

    expect(invalidateProjection).toHaveBeenCalledWith(repoPath, 'https://example.test/first.git')
    expect(invalidateHealth).toHaveBeenCalledWith(repoPath, 'https://example.test/first.git')
    expect(sourceCacheHealthCatalog.get(repoPath, source('first', FIRST_PIN))).toEqual({
      healthy: true,
    })
  })

  it('records a complete unhealthy state when projection catalog refresh fails', async () => {
    await writeManifest([source('first', FIRST_PIN)])
    await createCache('first', OLD_PIN, 'old-cache')
    const git = mockGit()
    const refreshError = new Error('simulated projection catalog refresh failure')
    vi.mocked(git.readTree)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(refreshError)
    const sourceProjectionCatalog = new SourceProjectionCatalog()
    const sourceCacheHealthCatalog = new SourceCacheHealthCatalog()

    const result = await reconcileSourceCachesAfterSync(
      { fs: new NodeFileSystem(), git, sourceProjectionCatalog, sourceCacheHealthCatalog },
      repoPath,
    )

    expect(result.unavailable).toEqual([{ source: source('first', FIRST_PIN), err: refreshError }])
    expect(sourceCacheHealthCatalog.get(repoPath, source('first', FIRST_PIN))).toEqual({
      healthy: false,
      reason: 'invalid',
      err: refreshError,
    })
  })
})

function source(name: string, pinnedCommit: string) {
  return {
    name,
    url: `https://example.test/${name}.git`,
    ref: 'main',
    type: 'branch',
    pinned_commit: pinnedCommit,
    members: [],
  }
}

async function writeManifest(sources: ReturnType<typeof source>[]): Promise<void> {
  const lines = ['sources:']
  for (const item of sources) {
    lines.push(
      `  - name: ${item.name}`,
      `    url: ${item.url}`,
      `    ref: ${item.ref}`,
      `    type: ${item.type}`,
      `    pinned_commit: ${item.pinned_commit}`,
      '    members: []',
    )
  }
  lines.push('skills: []', '')
  await writeFile(join(repoPath, 'skills.yaml'), lines.join('\n'))
}

async function createCache(name: string, commit: string, marker: string): Promise<void> {
  const path = cachePath(name)
  await mkdir(join(path, '.git'), { recursive: true })
  await writeFile(join(path, 'commit.txt'), commit)
  await writeFile(join(path, 'marker.txt'), marker)
}

function cachePath(name: string): string {
  return join(repoPath, 'remote-cache', name)
}

function cacheCommit(name: string): Promise<string> {
  return readFile(join(cachePath(name), 'commit.txt'), 'utf8')
}

function mockGit(options: { failingUrl?: string } = {}): IGit {
  return {
    clone: vi.fn(async (url: string, destination: string) => {
      if (url === options.failingUrl) throw new Error(`clone failed: ${url}`)
      await mkdir(join(destination, '.git'), { recursive: true })
      await writeFile(join(destination, 'origin.txt'), url)
    }),
    checkout: vi.fn(async (path: string, ref: string) => {
      await writeFile(join(path, 'commit.txt'), ref)
    }),
    revParseHead: vi.fn(async (path: string) => readFile(join(path, 'commit.txt'), 'utf8')),
    readTree: vi.fn(async () => []),
  } as Partial<IGit> as IGit
}

async function createJournaledWorkspace(
  fs: NodeFileSystem,
  name: string,
  pinnedCommit: string,
): Promise<string> {
  const url = `https://example.test/${name}.git`
  const key = createHash('sha256').update(`${url}\0${pinnedCommit}`).digest('hex')
  const workspace = join(repoPath, 'remote-cache', `.loom-cache-reconcile-${key}`)
  const candidate = join(workspace, 'candidate')
  await mkdir(join(candidate, '.git'), { recursive: true })
  await writeFile(join(candidate, 'commit.txt'), pinnedCommit)
  await writeFile(join(candidate, 'origin.txt'), url)
  const candidateIdentity = (await fs.inspectEntry(candidate))!.identity
  const liveIdentity = (await fs.inspectEntry(cachePath(name)))!.identity
  const owner = {
    version: 1,
    sourceId: name,
    sourceUrl: url,
    pinnedCommit,
  }
  await writeFile(
    join(workspace, '.loom-source-cache-reconciliation-owner.json'),
    JSON.stringify(owner),
  )
  await writeFile(
    join(workspace, '.loom-source-cache-reconciliation-journal.json'),
    JSON.stringify({ ...owner, candidateIdentity, liveIdentity }),
  )
  return workspace
}
