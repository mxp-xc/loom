import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  link,
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  readlink,
  readdir,
  symlink,
  rename,
} from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../../src/platform/node/fs'
import { renameDirectoryNoReplace } from '../../../src/platform/node/exclusive-rename'
import { FileSystemDestinationExistsError } from '../../../src/ports/fs'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('NodeFileSystem', () => {
  it('inspects files, directories, links, and missing entries without following links', async () => {
    const fs = new NodeFileSystem()
    const directory = join(root, 'directory')
    const file = join(root, 'file')
    const link = join(root, 'link')
    await mkdir(directory)
    await writeFile(file, 'content')
    await symlink(directory, link, 'junction')

    await expect(fs.inspectEntry(directory)).resolves.toMatchObject({ kind: 'directory' })
    await expect(fs.inspectEntry(file)).resolves.toMatchObject({ kind: 'file' })
    await expect(fs.inspectEntry(link)).resolves.toMatchObject({ kind: 'link' })
    await expect(fs.inspectEntry(join(root, 'missing'))).resolves.toBeNull()
    await expect(fs.readLink(link)).resolves.toBe(directory)
  })

  it('retries transient Windows directory move failures', async () => {
    let calls = 0
    const fs = new NodeFileSystem({
      platform: 'win32',
      rename: async (from, to) => {
        calls++
        if (calls < 3) {
          throw Object.assign(new Error('directory is temporarily locked'), { code: 'EPERM' })
        }
        await import('node:fs/promises').then((module) => module.rename(from, to))
      },
    })
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(source)
    await writeFile(join(source, 'marker.txt'), 'kept')

    await fs.move(source, destination)

    expect(calls).toBe(3)
    await expect(readFile(join(destination, 'marker.txt'), 'utf8')).resolves.toBe('kept')
    expect(await fs.exists(source)).toBe(false)
  })

  it('moves without replacing an existing destination', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(source)
    await mkdir(destination)
    await writeFile(join(source, 'source.txt'), 'source')
    await writeFile(join(destination, 'destination.txt'), 'destination')

    await expect(fs.moveNoReplace(source, destination)).rejects.toBeInstanceOf(
      FileSystemDestinationExistsError,
    )
    await expect(readFile(join(source, 'source.txt'), 'utf8')).resolves.toBe('source')
    await expect(readFile(join(destination, 'destination.txt'), 'utf8')).resolves.toBe(
      'destination',
    )
  })

  it('does not replace an existing empty destination directory', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(source)
    await mkdir(destination)
    await writeFile(join(source, 'source.txt'), 'source')
    const destinationIdentity = (await fs.inspectEntry(destination))!.identity

    await expect(fs.moveNoReplace(source, destination)).rejects.toBeInstanceOf(
      FileSystemDestinationExistsError,
    )

    expect((await fs.inspectEntry(destination))!.identity).toBe(destinationIdentity)
    await expect(readFile(join(source, 'source.txt'), 'utf8')).resolves.toBe('source')
  })

  it('atomically moves an identity-bound directory without changing its identity', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'atomic-source')
    const destination = join(root, 'atomic-destination')
    await mkdir(source)
    await writeFile(join(source, 'content.txt'), 'content')
    const sourceIdentity = (await fs.inspectEntry(source))!.identity

    await expect(
      fs.moveDirectoryAtomic(source, destination, sourceIdentity),
    ).resolves.toMatchObject({
      kind: 'directory',
      identity: sourceIdentity,
    })

    expect(await fs.inspectEntry(source)).toBeNull()
    await expect(readFile(join(destination, 'content.txt'), 'utf8')).resolves.toBe('content')
  })

  it('does not replace an existing destination during an atomic directory move', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'atomic-collision-source')
    const destination = join(root, 'atomic-collision-destination')
    await mkdir(source)
    await mkdir(destination)
    await writeFile(join(source, 'source.txt'), 'source')
    await writeFile(join(destination, 'destination.txt'), 'destination')
    const sourceIdentity = (await fs.inspectEntry(source))!.identity

    await expect(
      fs.moveDirectoryAtomic(source, destination, sourceIdentity),
    ).rejects.toBeInstanceOf(FileSystemDestinationExistsError)

    await expect(readFile(join(source, 'source.txt'), 'utf8')).resolves.toBe('source')
    await expect(readFile(join(destination, 'destination.txt'), 'utf8')).resolves.toBe(
      'destination',
    )
  })

  it.skipIf(platform() === 'win32')(
    'preserves an empty destination created immediately before the exclusive rename',
    async () => {
      const source = join(root, 'atomic-race-source')
      const destination = join(root, 'atomic-race-destination')
      await mkdir(source)
      await writeFile(join(source, 'source.txt'), 'source')
      const base = new NodeFileSystem()
      const sourceIdentity = (await base.inspectEntry(source))!.identity
      let destinationIdentity: string | undefined
      const fs = new NodeFileSystem({
        beforeRenameNoReplace: async () => {
          await mkdir(destination)
          destinationIdentity = (await base.inspectEntry(destination))!.identity
        },
      })

      await expect(
        fs.moveDirectoryAtomic(source, destination, sourceIdentity),
      ).rejects.toBeInstanceOf(FileSystemDestinationExistsError)

      expect((await fs.inspectEntry(destination))!.identity).toBe(destinationIdentity)
      expect((await fs.inspectEntry(source))!.identity).toBe(sourceIdentity)
      await expect(readFile(join(source, 'source.txt'), 'utf8')).resolves.toBe('source')
    },
  )

  it('leaves both directories unchanged when an atomic move cannot cross filesystems', async () => {
    const source = join(root, 'cross-device-source')
    const destination = join(root, 'cross-device-destination')
    await mkdir(source)
    await writeFile(join(source, 'content.txt'), 'content')
    const base = new NodeFileSystem()
    const sourceIdentity = (await base.inspectEntry(source))!.identity
    const fs = new NodeFileSystem({
      renameNoReplace: async (from, to) => {
        if (from === source && to === destination) {
          throw Object.assign(new Error('cross-device move'), { code: 'EXDEV' })
        }
        await rename(from, to)
      },
    })

    await expect(fs.moveDirectoryAtomic(source, destination, sourceIdentity)).rejects.toMatchObject(
      {
        code: 'EXDEV',
      },
    )

    await expect(readFile(join(source, 'content.txt'), 'utf8')).resolves.toBe('content')
    expect(await fs.inspectEntry(destination)).toBeNull()
  })

  it('accepts a completed atomic move when the native wrapper reports a later cleanup error', async () => {
    const source = join(root, 'completed-move-source')
    const destination = join(root, 'completed-move-destination')
    await mkdir(source)
    await writeFile(join(source, 'content.txt'), 'content')
    const base = new NodeFileSystem()
    const sourceIdentity = (await base.inspectEntry(source))!.identity
    const fs = new NodeFileSystem({
      renameNoReplace: async (from, to) => {
        await rename(from, to)
        throw new Error('directory handle cleanup failed')
      },
    })

    await expect(
      fs.moveDirectoryAtomic(source, destination, sourceIdentity),
    ).resolves.toMatchObject({
      kind: 'directory',
      identity: sourceIdentity,
    })

    expect(await fs.inspectEntry(source)).toBeNull()
    await expect(readFile(join(destination, 'content.txt'), 'utf8')).resolves.toBe('content')
  })

  it.skipIf(platform() !== 'darwin' && platform() !== 'linux')(
    'closes the source parent when the destination parent cannot be opened',
    async () => {
      const descriptorDirectory = platform() === 'linux' ? '/proc/self/fd' : '/dev/fd'
      const before = (await readdir(descriptorDirectory)).length

      for (let attempt = 0; attempt < 20; attempt++) {
        await expect(
          renameDirectoryNoReplace(
            join(root, 'source'),
            join(root, 'missing-parent', 'destination'),
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      }

      const after = (await readdir(descriptorDirectory)).length
      expect(after - before).toBeLessThan(3)
    },
  )

  it('copies an identity-bound regular file without following links or hardlinks', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'source.bin')
    const copied = join(root, 'copied.bin')
    await writeFile(source, Buffer.from([0, 255, 1, 128]))
    const sourceEntry = await fs.inspectEntry(source)
    await fs.copyFileNoFollow(source, copied, sourceEntry!.identity)
    await expect(readFile(copied)).resolves.toEqual(Buffer.from([0, 255, 1, 128]))

    const hardlink = join(root, 'hardlink.bin')
    await link(source, hardlink)
    const hardlinkEntry = await fs.inspectEntry(hardlink)
    await expect(
      fs.copyFileNoFollow(hardlink, join(root, 'hardlink-copy.bin'), hardlinkEntry!.identity),
    ).rejects.toThrow('unstable regular file')

    const symbolicLink = join(root, 'symbolic-link.bin')
    let linkCreated = false
    try {
      await symlink(source, symbolicLink, 'file')
      linkCreated = true
    } catch (error) {
      if (!isWindowsFileSymlinkPrivilegeError(error)) throw error
    }
    if (linkCreated) {
      await expect(
        fs.copyFileNoFollow(symbolicLink, join(root, 'link-copy.bin'), sourceEntry!.identity),
      ).rejects.toThrow()
    }
  })

  it('does not delete an existing destination when no-follow copy reports EEXIST', async () => {
    const fs = new NodeFileSystem()
    const source = join(root, 'source.txt')
    const destination = join(root, 'destination.txt')
    await writeFile(source, 'source')
    await writeFile(destination, 'user replacement')
    const sourceEntry = await fs.inspectEntry(source)

    await expect(
      fs.copyFileNoFollow(source, destination, sourceEntry!.identity),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('user replacement')
  })

  it('preserves file move and rollback failures', async () => {
    const source = join(root, 'source.txt')
    const destination = join(root, 'destination.txt')
    const moveFailure = new Error('source removal failed')
    const rollbackFailure = new Error('destination rollback failed')
    await writeFile(source, 'content')

    class CleanupFailureFileSystem extends NodeFileSystem {
      override async removeEntryIfIdentity(path: string, expectedIdentity: string): Promise<void> {
        if (path === source) throw moveFailure
        if (path === destination) throw rollbackFailure
        return super.removeEntryIfIdentity(path, expectedIdentity)
      }
    }

    const failure = await new CleanupFailureFileSystem()
      .moveNoReplace(source, destination)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw failure
    expect(failure.cause).toBe(moveFailure)
    expect(failure.errors).toEqual([moveFailure, rollbackFailure])
  })

  it.skipIf(platform() === 'win32')('preserves link move and rollback failures', async () => {
    const target = join(root, 'target.txt')
    const source = join(root, 'source-link')
    const destination = join(root, 'destination-link')
    const moveFailure = new Error('source link removal failed')
    const rollbackFailure = new Error('destination link rollback failed')
    await writeFile(target, 'content')
    await symlink(target, source, 'file')

    class CleanupFailureFileSystem extends NodeFileSystem {
      override async removeEntryIfIdentity(path: string, expectedIdentity: string): Promise<void> {
        if (path === source) throw moveFailure
        if (path === destination) throw rollbackFailure
        return super.removeEntryIfIdentity(path, expectedIdentity)
      }
    }

    const failure = await new CleanupFailureFileSystem()
      .moveNoReplace(source, destination)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw failure
    expect(failure.cause).toBe(moveFailure)
    expect(failure.errors).toEqual([moveFailure, rollbackFailure])
  })

  it('does not overwrite a child concurrently created in a reserved destination directory', async () => {
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(source)
    await writeFile(join(source, 'child.txt'), 'source')
    class CollisionFileSystem extends NodeFileSystem {
      override async moveNoReplace(src: string, dest: string, expected?: string) {
        if (src === join(source, 'child.txt')) await writeFile(dest, 'user replacement')
        return super.moveNoReplace(src, dest, expected)
      }
    }

    await expect(new CollisionFileSystem().moveNoReplace(source, destination)).rejects.toThrow()
    await expect(readFile(join(destination, 'child.txt'), 'utf8')).resolves.toBe('user replacement')
  })

  it('preserves a child created after the source directory snapshot', async () => {
    const source = join(root, 'late-child-source')
    const destination = join(root, 'late-child-destination')
    const original = join(source, 'original.txt')
    await mkdir(source)
    await writeFile(original, 'original')
    class LateChildFileSystem extends NodeFileSystem {
      override async moveNoReplace(src: string, dest: string, expected?: string) {
        const moved = await super.moveNoReplace(src, dest, expected)
        if (src === original) await writeFile(join(source, 'late.txt'), 'late')
        return moved
      }
    }
    const fs = new LateChildFileSystem()

    await expect(fs.moveNoReplace(source, destination)).rejects.toThrow()

    await expect(readFile(join(source, 'original.txt'), 'utf8')).resolves.toBe('original')
    await expect(readFile(join(source, 'late.txt'), 'utf8')).resolves.toBe('late')
    expect(await fs.inspectEntry(destination)).toBeNull()
  })

  it('removes its reserved destination after a child move fails', async () => {
    const source = join(root, 'rollback-source')
    const destination = join(root, 'rollback-destination')
    const child = join(source, 'child.txt')
    const failure = new Error('child move failed')
    await mkdir(source)
    await writeFile(child, 'source')
    class ChildMoveFailureFileSystem extends NodeFileSystem {
      override async moveNoReplace(src: string, dest: string, expected?: string) {
        if (src === child) throw failure
        return super.moveNoReplace(src, dest, expected)
      }
    }
    const fs = new ChildMoveFailureFileSystem()

    await expect(fs.moveNoReplace(source, destination)).rejects.toBe(failure)

    await expect(readFile(child, 'utf8')).resolves.toBe('source')
    expect(await fs.inspectEntry(destination)).toBeNull()
  })

  it('preserves a source-path replacement created during directory removal', async () => {
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    const displaced = join(root, 'displaced')
    await mkdir(source)
    let injected = false
    const fs = new NodeFileSystem({
      rename: async (from, to) => {
        if (!injected && from === source && to.includes('.loom-remove-')) {
          injected = true
          await rename(source, displaced)
          await mkdir(source)
          await writeFile(join(source, 'replacement.txt'), 'user replacement')
        }
        await rename(from, to)
      },
    })

    await expect(fs.moveNoReplace(source, destination)).rejects.toThrow()
    await expect(readFile(join(source, 'replacement.txt'), 'utf8')).resolves.toBe(
      'user replacement',
    )
  })

  it('preserves a source-link replacement created during identity-bound removal', async () => {
    const originalTarget = join(root, 'original-target')
    const replacementTarget = join(root, 'replacement-target')
    const source = join(root, 'source-link')
    const destination = join(root, 'destination-link')
    const displaced = join(root, 'displaced-link')
    await writeFile(originalTarget, 'original')
    await writeFile(replacementTarget, 'replacement')
    await symlink(originalTarget, source)
    let injected = false
    const fs = new NodeFileSystem({
      rename: async (from, to) => {
        if (!injected && from === source && to.includes('.loom-remove-')) {
          injected = true
          await rename(source, displaced)
          await symlink(replacementTarget, source)
        }
        await rename(from, to)
      },
    })

    await expect(fs.moveNoReplace(source, destination)).rejects.toThrow()
    await expect(readlink(source)).resolves.toBe(replacementTarget)
  })

  it('restores an isolated directory when physical removal fails', async () => {
    const source = join(root, 'source')
    const failure = new Error('directory cleanup failed')
    await mkdir(source)
    await writeFile(join(source, 'keep.txt'), 'keep')
    class RemovalFailureFileSystem extends NodeFileSystem {
      private failed = false

      override async removeDir(path: string): Promise<void> {
        if (!this.failed) {
          this.failed = true
          throw failure
        }
        await super.removeDir(path)
      }
    }
    const fs = new RemovalFailureFileSystem()
    const entry = await fs.inspectEntry(source)

    await expect(fs.removeEntryIfIdentity(source, entry!.identity)).rejects.toBe(failure)
    await expect(readFile(join(source, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('preserves a target replacement that appears during identity-bound file install', async () => {
    const target = join(root, 'target.txt')
    const temporary = join(root, 'temporary.txt')
    await writeFile(target, 'original')
    await writeFile(temporary, 'projected')
    const original = await new NodeFileSystem().inspectEntry(target)
    class ReplacementFileSystem extends NodeFileSystem {
      override async moveNoReplace(src: string, dest: string, expected?: string) {
        if (src === temporary && dest === target) await writeFile(target, 'user replacement')
        return super.moveNoReplace(src, dest, expected)
      }
    }

    await expect(
      new ReplacementFileSystem().replaceFileIfIdentity(temporary, target, original!.identity),
    ).rejects.toThrow()
    await expect(readFile(target, 'utf8')).resolves.toBe('user replacement')
  })

  it('distinguishes directories from files and missing paths', async () => {
    const fs = new NodeFileSystem()
    await mkdir(join(root, 'directory'))
    await writeFile(join(root, 'file.txt'), 'content')

    await expect(fs.isDirectory(join(root, 'directory'))).resolves.toBe(true)
    await expect(fs.isDirectory(join(root, 'file.txt'))).resolves.toBe(false)
    await expect(fs.isDirectory(join(root, 'missing'))).resolves.toBe(false)
  })

  it('replaceFile replaces a target and consumes the temporary file', async () => {
    const fs = new NodeFileSystem()
    const target = join(root, 'target')
    const temporary = join(root, 'temporary')
    await writeFile(target, 'old')
    await writeFile(temporary, 'new')
    await fs.replaceFile(temporary, target)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await fs.exists(temporary)).toBe(false)
  })

  it('replaceFile succeeds when the target is absent', async () => {
    const target = join(root, 'absent')
    const temporary = join(root, 'temporary')
    await writeFile(temporary, 'new')
    await new NodeFileSystem().replaceFile(temporary, target)
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('restores an existing target when installing the temp fails', async () => {
    let calls = 0
    const fs = new NodeFileSystem({
      platform: 'win32',
      rename: async (from, to) => {
        calls++
        if (calls === 2) throw new Error('install')
        await import('node:fs/promises').then((m) => m.rename(from, to))
      },
    })
    const target = join(root, 'target')
    const temporary = join(root, 'temporary')
    await writeFile(target, 'old')
    await writeFile(temporary, 'new')
    await expect(fs.replaceFile(temporary, target)).rejects.toThrow('install')
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(
      (await import('node:fs/promises').then((m) => m.readdir(root))).some((x) =>
        x.includes('replace-backup'),
      ),
    ).toBe(false)
  })

  it('preserves the backup and original cause when restoring fails', async () => {
    let calls = 0
    const install = new Error('install')
    const restore = new Error('restore')
    const fs = new NodeFileSystem({
      platform: 'win32',
      rename: async (from, to) => {
        calls++
        if (calls === 2) throw install
        if (calls === 3) throw restore
        await import('node:fs/promises').then((m) => m.rename(from, to))
      },
    })
    const target = join(root, 'target')
    const temporary = join(root, 'temporary')
    await writeFile(target, 'old')
    await writeFile(temporary, 'new')
    const failure = await fs.replaceFile(temporary, target).catch((error) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause).toBe(install)
    expect(failure.errors).toEqual([install, restore])
    expect(
      (await import('node:fs/promises').then((m) => m.readdir(root))).some((x) =>
        x.includes('replace-backup'),
      ),
    ).toBe(true)
  })

  it('uses one direct rename on POSIX and leaves target untouched on failure', async () => {
    const calls: Array<[string, string]> = []
    const failure = new Error('rename')
    const fs = new NodeFileSystem({
      platform: 'linux',
      rename: async (from, to) => {
        calls.push([from, to])
        throw failure
      },
    })
    const target = join(root, 'target')
    const temporary = join(root, 'temporary')
    await writeFile(target, 'old')
    await writeFile(temporary, 'new')
    await expect(fs.replaceFile(temporary, target)).rejects.toBe(failure)
    expect(calls).toEqual([[temporary, target]])
    expect(await readFile(target, 'utf8')).toBe('old')
  })

  it('removeFile removes files and links but refuses directories', async () => {
    const fs = new NodeFileSystem()
    const file = join(root, 'file')
    await writeFile(file, 'x')
    await fs.removeFile(file)
    expect(await fs.exists(file)).toBe(false)
    const directory = join(root, 'directory')
    await mkdir(directory)
    const linkTarget = join(root, 'link-target')
    await writeFile(linkTarget, 'target')
    const link = join(root, 'file-link')
    let linkCreated = false
    try {
      await symlink(linkTarget, link)
      linkCreated = true
    } catch (error) {
      if (!isWindowsFileSymlinkPrivilegeError(error)) throw error
    }
    if (linkCreated) {
      await fs.removeFile(link)
      expect(await fs.isLink(link)).toBe(false)
      expect(await fs.exists(linkTarget)).toBe(true)
    }
    await expect(fs.removeFile(directory)).rejects.toThrow()
  })
  it('createLink makes a link to a dir target, returns fallback null', async () => {
    const target = join(root, 'target')
    await mkdir(target)
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    const res = await fs.createLink(target, link)
    expect(res.fallback).toBe(null)
    expect(await fs.exists(link)).toBe(true)
  })

  it('removeLink removes only the link, not target contents', async () => {
    const target = join(root, 'target')
    await mkdir(target)
    await writeFile(join(target, 'f.txt'), 'data')
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    await fs.createLink(target, link)
    expect(await fs.isLink(link)).toBe(true)
    await fs.removeLink(link)
    expect(await fs.exists(link)).toBe(false)
    expect(await fs.exists(join(target, 'f.txt'))).toBe(true)
  })

  it('createLink refuses to overwrite a real file', async () => {
    const target = join(root, 'target')
    await mkdir(target)
    const link = join(root, 'link')
    await writeFile(link, 'real')
    await expect(new NodeFileSystem().createLink(target, link)).rejects.toThrow(/refuse|exists/)
  })

  it('createLink falls back to copy (fallback:"copy") when symlink throws EXDEV/EPERM', async () => {
    const target = join(root, 't')
    await mkdir(target)
    await writeFile(join(target, 'f'), 'x')
    const link = join(root, 'link')
    const fs = new NodeFileSystem({ forceLinkError: 'EXDEV' } as any)
    const res = await fs.createLink(target, link)
    expect(res.fallback).toBe('copy')
    expect(await fs.exists(join(link, 'f'))).toBe(true)
    expect(await fs.isLink(link)).toBe(false)
  })

  it.skipIf(platform() !== 'win32')(
    'Windows junction: removeLink does not recursively delete target',
    async () => {
      const target = join(root, 'target')
      await mkdir(target)
      await writeFile(join(target, 'f.txt'), 'keep')
      const link = join(root, 'link')
      const fs = new NodeFileSystem()
      await fs.createLink(target, link)
      await fs.removeLink(link)
      expect(await fs.exists(join(target, 'f.txt'))).toBe(true)
    },
  )

  it('uses rmdir for Windows junctions to remain compatible with Bun', async () => {
    const target = join(root, 'target')
    await mkdir(target)
    await writeFile(join(target, 'f.txt'), 'keep')
    const link = join(root, 'link')
    await symlink(target, link, 'junction')
    const removed: string[] = []
    const fs = new NodeFileSystem({
      platform: 'win32',
      rmdir: async (path) => {
        removed.push(path)
        await rm(path, { force: true })
      },
    })

    await fs.removeLink(link)

    expect(removed).toEqual([link])
    expect(await fs.isLink(link)).toBe(false)
    expect(await fs.exists(join(target, 'f.txt'))).toBe(true)
  })

  it('createLink replaces existing link to new target', async () => {
    const targetA = join(root, 'a')
    await mkdir(targetA)
    await writeFile(join(targetA, 'f'), 'A')
    const targetB = join(root, 'b')
    await mkdir(targetB)
    await writeFile(join(targetB, 'f'), 'B')
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    await fs.createLink(targetA, link)
    await fs.createLink(targetB, link)
    expect(await fs.isLink(link)).toBe(true)
    expect(await fs.exists(join(link, 'f'))).toBe(true)
  })

  it('copyDir recursively copies nested dirs + files', async () => {
    const src = join(root, 'src')
    await mkdir(join(src, 'sub'), { recursive: true })
    await writeFile(join(src, 'f.txt'), 'x')
    await writeFile(join(src, 'sub', 'g.txt'), 'y')
    const dest = join(root, 'dest')
    await new NodeFileSystem().copyDir(src, dest)
    expect(await new NodeFileSystem().exists(join(dest, 'f.txt'))).toBe(true)
    expect(await new NodeFileSystem().exists(join(dest, 'sub', 'g.txt'))).toBe(true)
  })

  it('copyFile preserves binary contents and creates destination parents', async () => {
    const src = join(root, 'image.bin')
    const dest = join(root, 'nested', 'image.bin')
    const bytes = Buffer.from([0, 255, 1, 128, 13, 10])
    await writeFile(src, bytes)

    await new NodeFileSystem().copyFile(src, dest)

    expect(await readFile(dest)).toEqual(bytes)
  })

  it('createFileLink falls back to a binary-safe copy', async () => {
    const target = join(root, 'asset.bin')
    const link = join(root, 'nested', 'asset.bin')
    const bytes = Buffer.from([0, 255, 42, 128])
    await writeFile(target, bytes)
    const fs = new NodeFileSystem({ forceLinkError: 'EXDEV' })

    await expect(fs.createFileLink(target, link)).resolves.toEqual({ fallback: 'copy' })
    expect(await readFile(link)).toEqual(bytes)
    expect(await fs.isLink(link)).toBe(false)
  })

  it.skipIf(platform() === 'win32')(
    'createLink replaces a broken symlink (stale target) to a new target',
    async () => {
      const target1 = join(root, 't1')
      await mkdir(target1)
      const link = join(root, 'link')
      const fs = new NodeFileSystem()
      await fs.createLink(target1, link)
      await rm(target1, { recursive: true, force: true })
      // link is now broken: still a link on disk, but stat-following exists() is false
      expect(await fs.isLink(link)).toBe(true)
      expect(await fs.exists(link)).toBe(false)
      const target2 = join(root, 't2')
      await mkdir(target2)
      await writeFile(join(target2, 'f'), 'B')
      await expect(fs.createLink(target2, link)).resolves.toEqual({ fallback: null })
      expect(await fs.isLink(link)).toBe(true)
      expect(await fs.exists(join(link, 'f'))).toBe(true)
    },
  )
})

function isWindowsFileSymlinkPrivilegeError(error: unknown): boolean {
  return (
    platform() === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EPERM'
  )
}
