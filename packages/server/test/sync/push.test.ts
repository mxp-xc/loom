import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { syncPush } from '../../src/sync/push'
import type { IGit } from '../../src/ports/git'
import { testGit } from '../helpers/git'

function fakeGit(overrides: Partial<IGit>): IGit {
  return {
    init: vi.fn(),
    fetch: vi.fn(),
    merge: vi.fn(),
    unmergedPaths: vi.fn(),
    showIndexStage: vi.fn(),
    abortMerge: vi.fn(),
    mergeBase: vi.fn(),
    lsRemote: vi.fn(),
    clone: vi.fn(),
    checkout: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    status: vi.fn(),
    show: vi.fn(),
    revParseHead: vi.fn(),
    revParse: vi.fn(),
    lsTree: vi.fn(),
    commitTree: vi.fn(),
    updateRef: vi.fn(),
    resetHard: vi.fn(),
    writeTree: vi.fn(),
    addOrUpdateRemote: vi.fn(),
    getRemoteUrl: vi.fn(),
    ...overrides,
  } as IGit
}

function fakeLogger() {
  return { error: vi.fn() }
}

describe('syncPush', () => {
  let bare: string
  const created: string[] = []
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'pushbare-'))
    await testGit().raw(['init', '--bare', '-b', 'main', bare])
    const w = await mkdtemp(join(tmpdir(), 'pushw-'))
    const gw = testGit(w)
    await gw.raw(['init', '-b', 'main'])
    await writeFile(join(w, 'a.txt'), 'x')
    await gw.add('.')
    await gw.commit('init')
    await gw.addRemote('origin', bare)
    await gw.push('origin', 'HEAD:main')
  })
  afterEach(async () => {
    for (const p of created.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
  })

  it('pushes a clean repo without creating an auto-commit', async () => {
    const calls: string[] = []
    const git = fakeGit({
      status: vi.fn(async () => {
        calls.push('status')
        return { dirty: false }
      }),
      add: vi.fn(async () => {
        calls.push('add')
      }),
      commit: vi.fn(async () => {
        calls.push('commit')
      }),
      push: vi.fn(async () => {
        calls.push('push')
        return { ok: true }
      }),
    })

    const result = await syncPush('/repo', git, fakeLogger())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['status', 'push'])
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('auto-commits a dirty repo before pushing', async () => {
    const calls: string[] = []
    const git = fakeGit({
      status: vi.fn(async () => {
        calls.push('status')
        return { dirty: true }
      }),
      add: vi.fn(async () => {
        calls.push('add')
      }),
      commit: vi.fn(async () => {
        calls.push('commit')
      }),
      push: vi.fn(async () => {
        calls.push('push')
        return { ok: true }
      }),
    })

    const result = await syncPush('/repo', git, fakeLogger())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['status', 'add', 'commit', 'push'])
    expect(git.add).toHaveBeenCalledWith('/repo', ['.'])
    expect(git.commit).toHaveBeenCalledWith('/repo', 'loom: sync changes')
  })

  it('preserves a non-fast-forward push result', async () => {
    const logger = fakeLogger()
    const err = new Error('updates were rejected because the tip of your current branch is behind')
    const git = fakeGit({
      status: vi.fn(async () => ({ dirty: false })),
      push: vi.fn(async () => ({
        ok: false,
        nonFastForward: true,
        message: 'updates were rejected because the tip of your current branch is behind',
        cause: err,
      })),
    })

    const result = await syncPush('/repo', git, logger)

    expect(result).toEqual({
      ok: false,
      nonFastForward: true,
      message: 'updates were rejected because the tip of your current branch is behind',
    })
    expect(logger.error).toHaveBeenCalledWith(
      'push rejected',
      expect.objectContaining({
        err,
        repoPath: '/repo',
        nonFastForward: true,
        result: expect.not.objectContaining({ cause: err, message: expect.any(String) }),
      }),
    )
  })

  it('classifies non-fast-forward push messages when the adapter does not flag them', async () => {
    const git = fakeGit({
      status: vi.fn(async () => ({ dirty: false })),
      push: vi.fn(async () => ({
        ok: false,
        message: 'Updates were rejected because the tip of your current branch is behind',
      })),
    })

    const result = await syncPush('/repo', git, fakeLogger())

    expect(result).toEqual({
      ok: false,
      nonFastForward: true,
      message: 'Updates were rejected because the tip of your current branch is behind',
    })
  })

  it('classifies no-remote push failures returned by the git adapter', async () => {
    const logger = fakeLogger()
    const err = new Error("fatal: 'origin' does not appear to be a git repository")
    const git = fakeGit({
      status: vi.fn(async () => ({ dirty: false })),
      push: vi.fn(async () => ({
        ok: false,
        message: "fatal: 'origin' does not appear to be a git repository",
        cause: err,
      })),
    })

    const result = await syncPush('/repo', git, logger)

    expect(result).toEqual({
      ok: false,
      error: 'no_remote',
      message: "fatal: 'origin' does not appear to be a git repository",
    })
    expect(logger.error).toHaveBeenCalledWith(
      'push rejected',
      expect.objectContaining({
        repoPath: '/repo',
        err,
        error: 'no_remote',
        result: expect.objectContaining({ ok: false }),
      }),
    )
    expect(logger.error).toHaveBeenCalledWith(
      'push rejected',
      expect.objectContaining({
        result: expect.not.objectContaining({ message: expect.any(String) }),
      }),
    )
  })

  it('classifies a non-git repo status failure and logs the thrown error object', async () => {
    const logger = fakeLogger()
    const err = new Error('fatal: not a git repository')
    const git = fakeGit({
      status: vi.fn(async () => {
        throw err
      }),
    })

    const result = await syncPush('/repo', git, logger)

    expect(result).toEqual({
      ok: false,
      error: 'no_remote',
      message: 'fatal: not a git repository',
    })
    expect(logger.error).toHaveBeenCalledWith(
      'push failed',
      expect.objectContaining({ err, repoPath: '/repo', error: 'no_remote' }),
    )
  })

  it('classifies other thrown git errors and logs the full error object', async () => {
    const logger = fakeLogger()
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const git = fakeGit({
      status: vi.fn(async () => ({ dirty: true })),
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => {
        throw err
      }),
    })

    const result = await syncPush('/repo', git, logger)

    expect(result).toEqual({ ok: false, error: 'other', message: 'permission denied' })
    expect(logger.error).toHaveBeenCalledWith(
      'push failed',
      expect.objectContaining({ err, repoPath: '/repo', error: 'other' }),
    )
  })

  it('non-fast-forward when local behind', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'pushdest-'))
    created.push(dest)
    await simpleGit().clone(bare, dest)
    const w2 = await mkdtemp(join(tmpdir(), 'pushw2-'))
    created.push(w2)
    const gw2 = testGit(w2)
    await gw2.clone(bare, '.')
    await writeFile(join(w2, 'b.txt'), 'y')
    await gw2.add('.')
    await gw2.commit('remote-update')
    await gw2.push('origin', 'HEAD:main')
    const res = await syncPush(dest, new NodeGit())
    expect(res.ok).toBe(false)
    expect(res.nonFastForward).toBe(true)
  })
})
