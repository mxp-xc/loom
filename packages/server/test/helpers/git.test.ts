import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cleanupGitTestTemplates,
  createBareRepo,
  createDivergedRepo,
  fastImportPath,
  gitFastImport,
  testGit,
} from './git.js'
import { serverPackagePath } from './project-path.js'

let fixtureTmp: string | undefined

beforeEach(async () => {
  const tempRoot = serverPackagePath('../../temp')
  await mkdir(tempRoot, { recursive: true })
  fixtureTmp = await mkdtemp(join(tempRoot, 'git-helper-'))
  vi.stubEnv('TMPDIR', fixtureTmp)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (fixtureTmp) await rm(fixtureTmp, { recursive: true, force: true })
  fixtureTmp = undefined
})

afterAll(async () => {
  await cleanupGitTestTemplates()
})

describe('Git fixture paths', () => {
  it('accepts dots within a path segment', () => {
    expect(fastImportPath('a..b/file.txt')).toBe('a..b/file.txt')
  })

  it.each(['', '/absolute', 'a//b', 'a/./b', 'a/../b', 'space name'])(
    'rejects unsupported path %j',
    (path) => {
      expect(() => fastImportPath(path)).toThrow('Unsupported test fixture path')
    },
  )
})

describe('Git fixture failures', () => {
  it('removes a partially-created bare repository', async () => {
    await expect(
      createBareRepo([{ message: 'invalid', files: { '../outside': 'content' } }]),
    ).rejects.toThrow('Unsupported test fixture path')

    expect(await readdir(fixtureTmp!)).toEqual([])
  })

  it('evicts a failed diverged template so the same fixture can retry', async () => {
    const files = [{ path: 'file.txt', base: 'base', ours: 'ours', theirs: 'theirs' }]
    const originalPath = process.env.PATH
    vi.stubEnv('PATH', fixtureTmp!)
    await expect(createDivergedRepo(files)).rejects.toThrow()
    expect(await readdir(fixtureTmp!)).toEqual([])

    vi.stubEnv('PATH', originalPath ?? '')
    const fixture = await createDivergedRepo(files)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('shares an immutable fetch remote while preserving the diverged topology', async () => {
    const fixture = await createDivergedRepo([
      { path: 'read-only.txt', base: 'base', ours: 'ours', theirs: 'theirs' },
    ])
    try {
      const git = testGit(fixture.repo)

      const fetchUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim()
      const pushUrl = (await git.raw(['remote', 'get-url', '--push', 'origin'])).trim()
      const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
      const local = (await git.raw(['rev-parse', 'origin/local'])).trim()
      const upstream = (
        await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
      ).trim()

      expect(pushUrl).not.toBe(fetchUrl)
      expect(head).toBe(local)
      expect(upstream).toBe('origin/main')
      await expect(git.raw(['push', 'origin', 'HEAD'])).rejects.toThrow()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects when fast-import closes while stdin is still writing', async () => {
    await expect(
      gitFastImport(join(fixtureTmp!, 'missing.git'), 'x'.repeat(1024 * 1024)),
    ).rejects.toThrow()
  })
})
