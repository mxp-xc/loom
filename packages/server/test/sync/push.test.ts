import { describe, it, expect, vi } from 'vitest'
import { syncForcePush, syncPush } from '../../src/sync/push'
import type { IGit } from '../../src/ports/git'

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
    forcePush: vi.fn(),
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
})

describe('syncForcePush', () => {
  it('force-pushes a clean repo without creating an auto-commit', async () => {
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
      forcePush: vi.fn(async () => {
        calls.push('forcePush')
        return { ok: true }
      }),
    })

    const result = await syncForcePush('/repo', git, fakeLogger())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['status', 'forcePush'])
    expect(git.add).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('auto-commits a dirty repo before force-pushing', async () => {
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
      forcePush: vi.fn(async () => {
        calls.push('forcePush')
        return { ok: true }
      }),
    })

    const result = await syncForcePush('/repo', git, fakeLogger())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['status', 'add', 'commit', 'forcePush'])
    expect(git.add).toHaveBeenCalledWith('/repo', ['.'])
    expect(git.commit).toHaveBeenCalledWith('/repo', 'loom: sync changes')
  })

  it('classifies force push failures and logs the full error object', async () => {
    const logger = fakeLogger()
    const err = new Error('permission denied')
    const git = fakeGit({
      status: vi.fn(async () => ({ dirty: false })),
      forcePush: vi.fn(async () => ({
        ok: false,
        message: 'permission denied',
        cause: err,
      })),
    })

    const result = await syncForcePush('/repo', git, logger)

    expect(result).toEqual({ ok: false, error: 'other', message: 'permission denied' })
    expect(logger.error).toHaveBeenCalledWith(
      'force push rejected',
      expect.objectContaining({ err, repoPath: '/repo', error: 'other' }),
    )
  })
})
