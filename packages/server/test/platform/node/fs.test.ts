import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../../src/platform/node/fs'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('NodeFileSystem', () => {
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
