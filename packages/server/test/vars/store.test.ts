import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { VarsStore } from '../../src/vars/store'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-vars-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const typed = (value: string) => ({
  format: 'typed' as const,
  entries: { KEY: { type: 'string' as const, value } },
})

async function symlinkDirectory(target: string, path: string) {
  await import('node:fs/promises').then((m) =>
    m.symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir'),
  )
}

async function symlinkFile(target: string, path: string) {
  await import('node:fs/promises').then((m) => m.symlink(target, path, 'file'))
}

describe('VarsStore', () => {
  it('validates environment names before constructing paths', async () => {
    const store = new VarsStore(root, new NodeFileSystem())
    for (const name of ['', '..', '../x', '/tmp/x', 'a/b', 'a\\b'])
      await expect(store.read(name)).rejects.toThrow(/environment/i)
  })

  it('lists yaml only, reads typed and legacy, and reports missing', async () => {
    const fs = new NodeFileSystem()
    const store = new VarsStore(root, fs)
    await fs.mkdir(join(root, 'vars'))
    await fs.writeFile(join(root, 'vars', 'typed.yaml'), 'KEY:\n  type: number\n  value: 3\n')
    await fs.writeFile(join(root, 'vars', 'legacy.yaml'), 'KEY: 3\n')
    await fs.writeFile(join(root, 'vars', 'ignore.txt'), 'x')
    expect(await store.list()).toEqual(['legacy', 'typed'])
    expect((await store.read('typed')).format).toBe('typed')
    expect((await store.read('legacy')).entries.KEY.value).toBe('3')
    await expect(store.read('missing')).rejects.toMatchObject({ code: 'environment_not_found' })
  })

  it('creates, writes and deletes environments', async () => {
    const store = new VarsStore(root, new NodeFileSystem())
    await store.create('dev', typed('one'))
    expect((await store.read('dev')).entries.KEY.value).toBe('one')
    expect(await store.writeMany({ dev: typed('two') })).toEqual(['dev'])
    await store.delete('dev')
    await expect(store.read('dev')).rejects.toMatchObject({ code: 'environment_not_found' })
  })

  it('rolls back changed and newly-created files and cleans temps on replacement failure', async () => {
    class FailingFs extends NodeFileSystem {
      calls = 0
      override async replaceFile(a: string, b: string) {
        if (++this.calls === 2) throw new Error('replace failed')
        return super.replaceFile(a, b)
      }
    }
    const fs = new FailingFs()
    const logger = { error: vi.fn() }
    const store = new VarsStore(root, fs, logger)
    await fs.mkdir(join(root, 'vars'))
    await fs.writeFile(join(root, 'vars', 'a.yaml'), 'KEY: old\n')
    await expect(store.writeMany({ a: typed('new'), b: typed('new') })).rejects.toThrow(
      'replace failed',
    )
    expect((await store.read('a')).entries.KEY.value).toBe('old')
    await expect(store.read('b')).rejects.toMatchObject({ code: 'environment_not_found' })
    expect((await readdir(join(root, 'vars'))).every((x) => !x.includes('.tmp-'))).toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), files: ['a', 'b'] }),
      'vars atomic write failed',
    )
  })

  it('serializes every value before any filesystem write', async () => {
    const fs = new NodeFileSystem()
    const write = vi.spyOn(fs, 'writeFile')
    const replace = vi.spyOn(fs, 'replaceFile')
    const store = new VarsStore(root, fs)
    await expect(
      store.writeMany({
        good: typed('ok'),
        bad: { format: 'typed', entries: { KEY: { type: 'number', value: Number.NaN } } },
      }),
    ).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('returns sorted changes and performs no writes for identical content', async () => {
    const fs = new NodeFileSystem()
    const store = new VarsStore(root, fs)
    expect(await store.writeMany({ z: typed('z'), a: typed('a') })).toEqual(['a', 'z'])
    const write = vi.spyOn(fs, 'writeFile')
    const replace = vi.spyOn(fs, 'replaceFile')
    expect(await store.writeMany({ z: typed('z'), a: typed('a') })).toEqual([])
    expect(write).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('aggregates original and rollback errors and logs both complete errors', async () => {
    const original = new Error('original')
    const rollback = new Error('rollback')
    class Fs extends NodeFileSystem {
      calls = 0
      override async replaceFile(a: string, b: string) {
        this.calls++
        if (this.calls === 2) throw original
        if (this.calls === 3) throw rollback
        return super.replaceFile(a, b)
      }
    }
    const fs = new Fs()
    const logger = { error: vi.fn() }
    const store = new VarsStore(root, fs, logger)
    await fs.mkdir(join(root, 'vars'))
    await fs.writeFile(join(root, 'vars', 'a.yaml'), 'KEY: old\n')
    const failure = await store
      .writeMany({ a: typed('new'), b: typed('new') })
      .catch((error) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause).toBe(original)
    expect(failure.errors).toEqual(expect.arrayContaining([original, rollback]))
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: rollback }),
      'vars atomic rollback failed',
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: original }),
      'vars atomic write failed',
    )
  })

  it('attempts every cleanup and rejects a successful write when cleanup fails', async () => {
    class Fs extends NodeFileSystem {
      removed: string[] = []
      override async removeFile(path: string) {
        this.removed.push(path)
        if (path.includes('.tmp-') && !path.endsWith('.restore') && this.removed.length === 1)
          throw new Error('cleanup')
        return super.removeFile(path)
      }
    }
    const fs = new Fs()
    const logger = { error: vi.fn() }
    const store = new VarsStore(root, fs, logger)
    const failure = await store.writeMany({ a: typed('a'), b: typed('b') }).catch((error) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(fs.removed.filter((path) => path.includes('.tmp-'))).toHaveLength(4)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'vars temporary file cleanup failed',
    )
  })

  it('does not roll back a target whose replacement never succeeded', async () => {
    class Fs extends NodeFileSystem {
      calls = 0
      override async replaceFile(a: string, b: string) {
        this.calls++
        if (this.calls === 2) {
          await this.writeFile(b, 'KEY: external\n')
          throw new Error('replace')
        }
        return super.replaceFile(a, b)
      }
    }
    const fs = new Fs()
    const store = new VarsStore(root, fs)
    await expect(store.writeMany({ a: typed('a'), b: typed('b') })).rejects.toThrow('replace')
    expect((await store.read('b')).entries.KEY.value).toBe('external')
  })

  it('rejects every operation when vars is a symlink outside the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'loom-vars-outside-'))
    try {
      await symlinkDirectory(outside, join(root, 'vars'))
      await import('node:fs/promises').then((m) =>
        m.writeFile(join(outside, 'dev.yaml'), 'KEY: safe\n'),
      )
      const store = new VarsStore(root, new NodeFileSystem())
      const operations = [
        () => store.list(),
        () => store.read('dev'),
        () => store.write('dev', typed('changed')),
        () => store.create('new', typed('new')),
        () => store.delete('dev'),
      ]
      for (const operation of operations) await expect(operation()).rejects.toThrow(/vars path/i)
      expect(
        await import('node:fs/promises').then((m) => m.readFile(join(outside, 'dev.yaml'), 'utf8')),
      ).toBe('KEY: safe\n')
      expect(await new NodeFileSystem().exists(join(outside, 'new.yaml'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects every operation when an environment yaml is a symlink outside the repository', async () => {
    const fs = new NodeFileSystem()
    await fs.mkdir(join(root, 'vars'))
    const outside =
      process.platform === 'win32'
        ? await mkdtemp(join(root, 'outside-env-'))
        : join(root, 'outside.yaml')
    const protectedFile = process.platform === 'win32' ? join(outside, 'secret.yaml') : outside
    await fs.writeFile(protectedFile, 'KEY: secret\n')
    if (process.platform === 'win32')
      await symlinkDirectory(outside, join(root, 'vars', 'dev.yaml'))
    else await symlinkFile(outside, join(root, 'vars', 'dev.yaml'))
    const store = new VarsStore(root, fs)
    const operations = [
      () => store.list(),
      () => store.read('dev'),
      () => store.write('dev', typed('changed')),
      () => store.create('dev', typed('new')),
      () => store.delete('dev'),
    ]
    for (const operation of operations)
      await expect(operation()).rejects.toMatchObject({ code: 'vars_symlink_not_allowed' })
    expect(await fs.readFile(protectedFile)).toBe('KEY: secret\n')
  })
})
