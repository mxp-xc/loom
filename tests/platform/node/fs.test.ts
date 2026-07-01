import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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

  it.skipIf(platform() !== 'win32')('Windows junction: removeLink does not recursively delete target', async () => {
    const target = join(root, 'target')
    await mkdir(target)
    await writeFile(join(target, 'f.txt'), 'keep')
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    await fs.createLink(target, link)
    await fs.removeLink(link)
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

  it.skipIf(platform() === 'win32')('createLink replaces a broken symlink (stale target) to a new target', async () => {
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
  })
})
