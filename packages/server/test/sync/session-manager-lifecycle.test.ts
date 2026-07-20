import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { SyncSessionManager } from '../../src/sync/session-manager.js'

const created: string[] = []

afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function createGatedOrphanManager() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'loom-sync-lifecycle-')))
  created.push(home)
  const candidate = join(home, '.loom', 'cache', 'sync-worktrees', 'a'.repeat(24), randomUUID())
  await mkdir(candidate, { recursive: true })
  await writeFile(join(candidate, 'orphan.txt'), 'orphan\n')

  const nodeFs = new NodeFileSystem()
  const started = deferred()
  const release = deferred()
  let removals = 0
  const manager = new SyncSessionManager({
    home,
    orphanFs: {
      inspectEntry: nodeFs.inspectEntry.bind(nodeFs),
      realPath: nodeFs.realPath.bind(nodeFs),
      removeEntryIfIdentity: async (path, identity) => {
        removals += 1
        started.resolve()
        await release.promise
        await nodeFs.removeEntryIfIdentity(path, identity)
      },
    },
  })
  return {
    home,
    manager,
    started: started.promise,
    release: release.resolve,
    removals: () => removals,
  }
}

describe('SyncSessionManager lifecycle', () => {
  it.each(['pull', 'forcePull'] as const)(
    'runs an authorization guard before resolving the repository for %s',
    async (operation) => {
      const home = await realpath(await mkdtemp(join(tmpdir(), 'loom-sync-guard-')))
      created.push(home)
      const repo = join(home, 'removed-repo')
      const guardError = new Error('repository authorization expired')
      const guard = vi.fn(async () => Promise.reject(guardError))
      const manager = new SyncSessionManager({ home })

      await expect(manager[operation](repo, guard)).rejects.toBe(guardError)
      expect(guard).toHaveBeenCalledWith(repo)
      await manager.dispose()
    },
  )

  it.each(['pull', 'forcePull'] as const)(
    'does not clean sync state before the authorization guard for %s',
    async (operation) => {
      const { home, manager, release, removals } = await createGatedOrphanManager()
      const repo = join(home, 'repo-without-git')
      await mkdir(repo)
      release()
      const guardError = new Error('repository authorization expired')
      const guard = vi.fn(async () => Promise.reject(guardError))

      await expect(manager[operation](repo, guard)).rejects.toBe(guardError)
      expect(removals()).toBe(0)
      await manager.dispose()
    },
  )

  it('runs an authorization guard before repository Git access', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'loom-sync-guard-')))
    created.push(home)
    const repo = join(home, 'repo-without-git')
    await mkdir(repo)
    const guardError = new Error('repository authorization expired')
    const guard = vi.fn(async () => Promise.reject(guardError))
    const manager = new SyncSessionManager({ home })

    await expect(manager.forcePull(repo, guard)).rejects.toBe(guardError)
    expect(guard).toHaveBeenCalledWith(await realpath(repo))
    await manager.dispose()
  })

  it('waits for an in-flight operation and rejects new work during idempotent disposal', async () => {
    const { manager, started, release } = await createGatedOrphanManager()
    const recovery = manager.recover()
    await started

    const firstDispose = manager.dispose()
    const secondDispose = manager.dispose()
    expect(secondDispose).toBe(firstDispose)
    let disposed = false
    void firstDispose.then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    await expect(manager.getSession('/late')).rejects.toMatchObject({ code: 'manager_disposed' })
    await expect(manager.pull('/late')).rejects.toMatchObject({ code: 'manager_disposed' })
    await expect(manager.forcePull('/late')).rejects.toMatchObject({ code: 'manager_disposed' })
    await expect(manager.saveConflict('late', 'file', '')).rejects.toMatchObject({
      code: 'manager_disposed',
    })
    await expect(manager.abort('late')).rejects.toMatchObject({ code: 'manager_disposed' })
    await expect(manager.recover()).rejects.toMatchObject({ code: 'manager_disposed' })
    expect(() => manager.startMaintenance()).toThrowError(
      expect.objectContaining({ code: 'manager_disposed' }),
    )

    release()
    await recovery
    await firstDispose
    expect(disposed).toBe(true)
  })

  it('does not overlap maintenance cleanup and waits for an active tick during disposal', async () => {
    const { manager, started, release, removals } = await createGatedOrphanManager()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    try {
      const retryCleanup = vi.spyOn(
        manager as unknown as { retryCleanup(): Promise<void> },
        'retryCleanup',
      )
      manager.startMaintenance(100)
      expect(vi.getTimerCount()).toBe(1)

      vi.advanceTimersByTime(100)
      await started
      expect(retryCleanup).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(500)
      expect(retryCleanup).toHaveBeenCalledTimes(1)
      expect(removals()).toBe(1)

      const disposal = manager.dispose()
      expect(vi.getTimerCount()).toBe(0)
      let disposed = false
      void disposal.then(() => {
        disposed = true
      })
      await Promise.resolve()
      expect(disposed).toBe(false)

      release()
      await disposal
      expect(disposed).toBe(true)
      expect(removals()).toBe(1)
    } finally {
      release()
      try {
        await manager.dispose()
      } finally {
        vi.clearAllTimers()
        vi.useRealTimers()
      }
    }
  })
})
