import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { simpleGit } from 'simple-git'
import { SyncSessionManager } from '../../src/sync/session-manager'
import { cleanupGitTestTemplates, createDivergedRepo } from '../helpers/git'

const created: string[] = []

afterAll(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
  await cleanupGitTestTemplates()
})

async function setupRepo(base: string, local: string, remote: string) {
  const { root, home, repo } = await createDivergedRepo([
    { path: 'skills.yaml', base, ours: local, theirs: remote },
  ])
  created.push(root)

  return { home, repo, root }
}

describe.concurrent('SyncSessionManager', () => {
  it('keeps conflicts isolated and restores the active session after reload', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })

    const pulled = await manager.pull(repo)

    expect(pulled.clean).toBe(false)
    expect(pulled.sessionId).toBeTruthy()
    expect(pulled.conflicts[0].result).toContain('<<<<<<< HEAD')
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
    expect(await simpleGit(repo).raw(['diff', '--name-only', '--diff-filter=U'])).toBe('')

    const restored = await new SyncSessionManager({ home }).getSession(repo)
    expect(restored?.sessionId).toBe(pulled.sessionId)
    expect(restored?.conflicts).toHaveLength(1)
    await expect(manager.forcePull(repo)).rejects.toMatchObject({
      code: 'active_session_exists',
      message: '请先解决或放弃当前同步会话',
    })

    await manager.abort(pulled.sessionId!)

    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
    expect(await manager.getSession(repo)).toBeNull()
    expect(await simpleGit(repo).raw(['diff', '--name-only', '--diff-filter=U'])).toBe('')
  })

  it('applies a resolved merge only after every conflict is saved', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const applied: string[] = []
    const manager = new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    })
    const pulled = await manager.pull(repo)

    const saved = await manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'value: chosen\n')

    expect(saved.clean).toBe(true)
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: chosen\n')
    expect(await manager.getSession(repo)).toBeNull()
    expect(applied).toEqual([repo])
  })

  it('remerges onto formal changes made while the session is open', async () => {
    const { home, repo } = await setupRepo(
      'value: base\nother: base\n',
      'value: local\nother: base\n',
      'value: remote\nother: base\n',
    )
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    await writeFile(join(repo, 'other.txt'), 'new local file\n')

    const saved = await manager.saveConflict(
      pulled.sessionId!,
      'skills.yaml',
      'value: chosen\nother: base\n',
    )

    expect(saved.clean).toBe(true)
    expect(await readFile(join(repo, 'other.txt'), 'utf8')).toBe('new local file\n')
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toContain('value: chosen')
  })

  it('returns a new isolated conflict when the formal repository changes the resolved area', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    await writeFile(join(repo, 'skills.yaml'), 'value: newest local\n')

    const saved = await manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'value: chosen\n')

    expect(saved.clean).toBe(false)
    expect(saved.remaining[0].path).toBe('skills.yaml')
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: newest local\n')
    expect(await simpleGit(repo).raw(['diff', '--name-only', '--diff-filter=U'])).toBe('')
  })

  it('fails closed when an undeletable-or-orphaned worktree reaches the directory quota', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const second = await setupRepo('value: base\n', 'value: other-local\n', 'value: other-remote\n')
    const manager = new SyncSessionManager({ home, maxWorktrees: 1 })
    await manager.pull(repo)

    await expect(manager.pull(second.repo)).rejects.toMatchObject({
      code: 'storage_quota_exceeded',
    })

    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
  })

  it('keeps failed cleanup in deleting state and stops allocating more disk', async () => {
    const first = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const second = await setupRepo('value: base\n', 'value: other-local\n', 'value: other-remote\n')
    const deletionError = new Error('simulated locked directory')
    const manager = new SyncSessionManager({
      home: first.home,
      maxWorktrees: 1,
      cleanupOperations: {
        removeWorktree: async () => Promise.reject(deletionError),
        removeDirectory: async () => Promise.reject(deletionError),
      },
    })
    const session = await manager.pull(first.repo)

    await expect(manager.abort(session.sessionId!)).rejects.toMatchObject({
      code: 'cleanup_pending',
    })
    await expect(manager.pull(second.repo)).rejects.toMatchObject({
      code: 'storage_quota_exceeded',
    })
    await expect(manager.pull(first.repo)).rejects.toMatchObject({ code: 'cleanup_pending' })
  })

  it('migrates a legacy in-place conflict into an isolated session during recovery', async () => {
    const setup = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const managed = join(setup.home, '.loom', 'repos', 'default')
    await mkdir(dirname(managed), { recursive: true })
    await rename(setup.repo, managed)
    const git = simpleGit(managed)
    await git.raw(['fetch', 'origin'])
    await git.raw(['merge', 'FETCH_HEAD', '--no-edit'])
    expect(await readFile(join(managed, 'skills.yaml'), 'utf8')).toContain('<<<<<<< HEAD')

    const manager = new SyncSessionManager({ home: setup.home })
    await manager.recover()

    expect(await readFile(join(managed, 'skills.yaml'), 'utf8')).toBe('value: local\n')
    const restored = await manager.getSession(managed)
    expect(restored?.conflicts[0].path).toBe('skills.yaml')
  })

  it('migrates a legacy conflict before handling a pull even if startup recovery has not run', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const git = simpleGit(repo)
    await git.raw(['fetch', 'origin'])
    await git.raw(['merge', 'FETCH_HEAD', '--no-edit'])

    const result = await new SyncSessionManager({ home }).pull(repo)

    expect(result.clean).toBe(false)
    expect(result.conflicts[0].path).toBe('skills.yaml')
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
  })

  it('forcePull resets to the remote version and removes local-only files', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    await writeFile(join(repo, 'skills.yaml'), 'value: unsaved local edit\n')
    await mkdir(join(repo, 'scratch'), { recursive: true })
    await writeFile(join(repo, 'scratch', 'note.txt'), 'temporary\n')
    await writeFile(join(repo, 'loose.txt'), 'temporary\n')

    const applied: string[] = []
    const result = await new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    }).forcePull(repo)

    expect(result.clean).toBe(true)
    const git = simpleGit(repo)
    expect(await git.raw(['rev-parse', 'HEAD'])).toBe(await git.raw(['rev-parse', 'origin/main']))
    await expect(readFile(join(repo, 'scratch', 'note.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(repo, 'loose.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(applied).toEqual([repo])
  })
})
