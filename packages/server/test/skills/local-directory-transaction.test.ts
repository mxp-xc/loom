import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import {
  combineLocalTransactionFailure,
  inspectLocalDirectorySnapshot,
  LocalDirectoryTransaction,
  normalizeLocalArchiveFiles,
} from '../../src/skills/local-directory-transaction.js'
import {
  prepareBuiltInLocalSkill,
  resolveRegisteredLocalSkill,
} from '../../src/skills/local-paths.js'

class PostMoveInspectionFailureFileSystem extends NodeFileSystem {
  private failPath: string | undefined

  constructor(
    private readonly destinationSuffix: string,
    private readonly failure: Error,
  ) {
    super()
  }

  override async moveNoReplace(source: string, destination: string, expectedIdentity?: string) {
    const moved = await super.moveNoReplace(source, destination, expectedIdentity)
    if (destination.endsWith(this.destinationSuffix)) this.failPath = destination
    return moved
  }

  override async inspectEntry(path: string) {
    if (path === this.failPath) {
      this.failPath = undefined
      throw this.failure
    }
    return super.inspectEntry(path)
  }
}

describe('LocalDirectoryTransaction', () => {
  let root: string
  let repoPath: string
  let log: {
    error: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loom-local-transaction-'))
    repoPath = join(root, 'repo')
    await mkdir(repoPath)
    log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  })

  afterEach(async () => rm(root, { recursive: true, force: true }))

  it.each([
    ['duplicate', ['SKILL.md', 'SKILL.md']],
    ['case collision', ['SKILL.md', 'docs/Readme.md', 'docs/readme.md']],
    ['file ancestor collision', ['SKILL.md', 'docs', 'docs/usage.md']],
  ])('rejects %s during archive preflight', (_name, paths) => {
    expect(() =>
      normalizeLocalArchiveFiles(paths.map((path) => ({ path, content: path }))),
    ).toThrowError(expect.objectContaining({ code: 'local_skill_archive_collision' }))
  })

  it('rejects linked and hardlinked snapshot entries before staging', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'SKILL.md'), '# source')
    const linkedTarget = join(root, 'linked-target')
    await writeFile(linkedTarget, 'outside')
    await symlink(linkedTarget, join(source, 'linked.md'), 'file')
    const sourceEntry = await fs.inspectEntry(source)

    await expect(
      inspectLocalDirectorySnapshot(fs, {
        path: await fs.realPath(source),
        identity: sourceEntry!.identity,
      }),
    ).rejects.toMatchObject({ code: 'invalid_local_skill_tree' })

    await rm(join(source, 'linked.md'))
    await link(join(source, 'SKILL.md'), join(source, 'hardlink.md'))
    await expect(
      inspectLocalDirectorySnapshot(fs, {
        path: await fs.realPath(source),
        identity: sourceEntry!.identity,
      }),
    ).rejects.toMatchObject({ code: 'local_skill_hardlink_rejected' })
  })

  it('rejects a linked archive ancestor without writing outside staging', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel.txt'), 'keep')
    class ArchiveAncestorRaceFileSystem extends NodeFileSystem {
      override async mkdir(path: string, recursive?: boolean): Promise<void> {
        await super.mkdir(path, recursive)
        if (path.endsWith(join('candidates', 'linked-archive'))) {
          await symlink(
            outside,
            join(path, 'docs'),
            process.platform === 'win32' ? 'junction' : 'dir',
          )
        }
      }
    }
    const fs = new ArchiveAncestorRaceFileSystem()
    const destination = await prepareBuiltInLocalSkill(fs, repoPath, 'linked-archive')
    const transaction = await LocalDirectoryTransaction.open(fs, destination.root, log)

    await expect(
      transaction.stageArchive(
        destination,
        normalizeLocalArchiveFiles([
          { path: 'SKILL.md', content: '# skill' },
          { path: 'docs/usage.md', content: 'outside write' },
        ]),
      ),
    ).rejects.toThrow()
    expect(await transaction.rollback()).toEqual([])
    await expect(readFile(join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('keep')
    await expect(readFile(join(outside, 'usage.md'), 'utf8')).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects special snapshot entries before staging',
    async () => {
      const fs = new NodeFileSystem()
      const source = join(root, 'x')
      const socketPath = join(source, 's')
      await mkdir(source)
      await writeFile(join(source, 'SKILL.md'), '# source')
      const server = createServer()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      try {
        const sourceEntry = await fs.inspectEntry(source)
        await expect(
          inspectLocalDirectorySnapshot(fs, {
            path: await fs.realPath(source),
            identity: sourceEntry!.identity,
          }),
        ).rejects.toMatchObject({ code: 'invalid_local_skill_tree' })
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )

  it('rolls back earlier atomic promotions when a later destination fails', async () => {
    const failure = new Error('second promotion failed')
    class PromotionFaultFileSystem extends NodeFileSystem {
      override async moveNoReplace(source: string, destination: string, expectedIdentity?: string) {
        if (destination.endsWith(`${join('assets', 'skills', 'beta')}`)) throw failure
        return super.moveNoReplace(source, destination, expectedIdentity)
      }
    }
    const fs = new PromotionFaultFileSystem()
    const alpha = await prepareBuiltInLocalSkill(fs, repoPath, 'alpha')
    const beta = await prepareBuiltInLocalSkill(fs, repoPath, 'beta')
    const transaction = await LocalDirectoryTransaction.open(fs, alpha.root, log)
    await transaction.stageArchive(
      alpha,
      normalizeLocalArchiveFiles([{ path: 'SKILL.md', content: '# alpha' }]),
    )
    await transaction.stageArchive(
      beta,
      normalizeLocalArchiveFiles([{ path: 'SKILL.md', content: '# beta' }]),
    )

    const primary = await transaction.apply().catch((error) => error)
    const combined = combineLocalTransactionFailure(primary, await transaction.rollback())

    expect(combined).toBe(failure)
    expect(await fs.inspectEntry(alpha.directory)).toBeNull()
    expect(await fs.inspectEntry(beta.directory)).toBeNull()
    expect(
      (await fs.readDir(alpha.root.directory.path)).filter((name) => name.startsWith('.loom-')),
    ).toEqual([])
  })

  it('restores a moved source when post-move inspection fails', async () => {
    const failure = new Error('post-move inspection failed')
    const fs = new PostMoveInspectionFailureFileSystem(join('moved', 'victim'), failure)
    const destination = await prepareBuiltInLocalSkill(fs, repoPath, 'victim')
    const source = join(root, 'external-victim')
    await mkdir(source)
    await writeFile(join(source, 'SKILL.md'), '# victim')
    const sourceEntry = await fs.inspectEntry(source)
    const snapshot = await inspectLocalDirectorySnapshot(fs, {
      path: await fs.realPath(source),
      identity: sourceEntry!.identity,
    })
    const transaction = await LocalDirectoryTransaction.open(fs, destination.root, log)

    await expect(transaction.stageMovedDirectory(destination, snapshot)).rejects.toMatchObject({
      code: 'local_skill_io_failed',
      cause: failure,
    })
    expect(await transaction.rollback()).toEqual([])

    await expect(readFile(join(source, 'SKILL.md'), 'utf8')).resolves.toBe('# victim')
    expect(await fs.inspectEntry(destination.directory)).toBeNull()
    expect(
      (await fs.readDir(destination.root.directory.path)).filter((name) =>
        name.startsWith('.loom-'),
      ),
    ).toEqual([])
  })

  it('restores a staged removal when post-move inspection fails', async () => {
    const failure = new Error('post-removal inspection failed')
    const fs = new PostMoveInspectionFailureFileSystem(join('removed', 'victim'), failure)
    const destination = await prepareBuiltInLocalSkill(fs, repoPath, 'victim')
    await mkdir(destination.directory)
    await writeFile(join(destination.directory, 'SKILL.md'), '# victim')
    const resolved = await resolveRegisteredLocalSkill(
      fs,
      repoPath,
      { sources: [], skills: [{ id: 'victim' }] },
      'victim',
    )
    const transaction = await LocalDirectoryTransaction.open(fs, destination.root, log)

    await expect(transaction.stageRemoval(resolved!)).rejects.toMatchObject({
      code: 'local_skill_io_failed',
      cause: failure,
    })
    expect(await transaction.rollback()).toEqual([])

    await expect(readFile(join(destination.directory, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# victim',
    )
    expect(
      (await fs.readDir(destination.root.directory.path)).filter((name) =>
        name.startsWith('.loom-'),
      ),
    ).toEqual([])
  })

  it('removes a promoted destination when post-move inspection fails', async () => {
    const failure = new Error('post-promotion inspection failed')
    const fs = new PostMoveInspectionFailureFileSystem(join('assets', 'skills', 'victim'), failure)
    const destination = await prepareBuiltInLocalSkill(fs, repoPath, 'victim')
    const transaction = await LocalDirectoryTransaction.open(fs, destination.root, log)
    await transaction.stageArchive(
      destination,
      normalizeLocalArchiveFiles([{ path: 'SKILL.md', content: '# victim' }]),
    )

    await expect(transaction.apply()).rejects.toMatchObject({
      code: 'local_skill_io_failed',
      cause: failure,
    })
    expect(await transaction.rollback()).toEqual([])

    expect(await fs.inspectEntry(destination.directory)).toBeNull()
    expect(
      (await fs.readDir(destination.root.directory.path)).filter((name) =>
        name.startsWith('.loom-'),
      ),
    ).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'preserves pinned bytes and executable mode',
    async () => {
      const fs = new NodeFileSystem()
      const destination = await prepareBuiltInLocalSkill(fs, repoPath, 'binary-skill')
      const transaction = await LocalDirectoryTransaction.open(fs, destination.root, log)
      const content = Uint8Array.from([35, 32, 83, 107, 105, 108, 108, 10, 0, 255, 10])
      await transaction.stageArchive(
        destination,
        normalizeLocalArchiveFiles([{ path: 'SKILL.md', content, mode: '100755' }]),
      )

      await transaction.apply()
      await transaction.complete()

      await expect(readFile(join(destination.directory, 'SKILL.md'))).resolves.toEqual(
        Buffer.from(content),
      )
      expect((await stat(join(destination.directory, 'SKILL.md'))).mode & 0o777).toBe(0o755)
    },
  )

  it('preserves a replacement and aggregates primary plus identity-bound rollback failure', async () => {
    const primaryFailure = new Error('second promotion failed')
    let alphaDestination = ''
    class ReplacementFaultFileSystem extends NodeFileSystem {
      override async moveNoReplace(source: string, destination: string, expectedIdentity?: string) {
        if (destination.endsWith(`${join('assets', 'skills', 'beta')}`)) {
          await rm(alphaDestination, { recursive: true, force: true })
          await mkdir(alphaDestination)
          await writeFile(join(alphaDestination, 'replacement.txt'), 'keep')
          throw primaryFailure
        }
        return super.moveNoReplace(source, destination, expectedIdentity)
      }
    }
    const fs = new ReplacementFaultFileSystem()
    const alpha = await prepareBuiltInLocalSkill(fs, repoPath, 'alpha')
    const beta = await prepareBuiltInLocalSkill(fs, repoPath, 'beta')
    alphaDestination = alpha.directory
    const transaction = await LocalDirectoryTransaction.open(fs, alpha.root, log)
    await transaction.stageArchive(
      alpha,
      normalizeLocalArchiveFiles([{ path: 'SKILL.md', content: '# alpha' }]),
    )
    await transaction.stageArchive(
      beta,
      normalizeLocalArchiveFiles([{ path: 'SKILL.md', content: '# beta' }]),
    )

    const primary = await transaction.apply().catch((error) => error)
    const combined = combineLocalTransactionFailure(primary, await transaction.rollback())

    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).cause).toBe(primaryFailure)
    await expect(readFile(join(alpha.directory, 'replacement.txt'), 'utf8')).resolves.toBe('keep')
    expect(log.error).toHaveBeenCalledWith(
      'failed to roll back installed local skill',
      expect.objectContaining({ err: expect.anything(), path: alpha.directory }),
    )
  })
})
