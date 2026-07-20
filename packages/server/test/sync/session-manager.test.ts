import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { simpleGit } from 'simple-git'
import { SyncSessionManager } from '../../src/sync/session-manager'
import { ResourceLeaseCoordinator } from '../../src/concurrency/resource-lease-coordinator.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { cleanupGitTestTemplates, createBareRepo, createDivergedRepo } from '../helpers/git'
import { bunExecutable, serverPackagePath } from '../helpers/project-path'

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

async function sessionStateFile(home: string): Promise<string> {
  const stateRoot = join(home, '.loom', 'state', 'sync-sessions')
  const [repoHash] = await readdir(stateRoot)
  const [name] = await readdir(join(stateRoot, repoHash!))
  return join(stateRoot, repoHash!, name!)
}

async function gitWithInput(repo: string, args: string[], input: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim())
      else reject(new Error(Buffer.concat(stderr).toString('utf8')))
    })
    child.stdin.end(input)
  })
}

interface SyncChildResult {
  ok: boolean
  operation: 'save' | 'abort'
  code?: string
  message?: string
}

interface SyncChild {
  ready: Promise<void>
  result: Promise<SyncChildResult>
  release(): void
  terminate(): Promise<void>
}

function syncOperationChild(
  operation: SyncChildResult['operation'],
  home: string,
  sessionId: string,
): SyncChild {
  const child = spawn(
    bunExecutable(),
    [serverPackagePath('test/sync/session-manager-child.ts'), operation, home, sessionId],
    { cwd: serverPackagePath(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let output = ''
  let errorOutput = ''
  let ready!: () => void
  let rejectReady!: (err: Error) => void
  let resolveResult!: (result: SyncChildResult) => void
  let rejectResult!: (err: Error) => void
  let readySettled = false
  let resultSettled = false
  let released = false
  let termination: Promise<void> | undefined
  const readyPromise = new Promise<void>((resolveReady, rejectChildReady) => {
    ready = resolveReady
    rejectReady = rejectChildReady
  })
  const resultPromise = new Promise<SyncChildResult>((resolveChildResult, rejectChildResult) => {
    resolveResult = resolveChildResult
    rejectResult = rejectChildResult
  })
  void readyPromise.catch(() => undefined)
  void resultPromise.catch(() => undefined)
  const rejectChild = (err: Error) => {
    if (!readySettled) {
      readySettled = true
      rejectReady(err)
    }
    if (!resultSettled) {
      resultSettled = true
      rejectResult(err)
    }
  }
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    const lines = output.split('\n')
    if (lines.includes('ready') && !readySettled) {
      readySettled = true
      ready()
    }
    const resultLine = lines.find((line) => line.startsWith('{'))
    if (resultLine && !resultSettled) {
      try {
        const result = JSON.parse(resultLine) as SyncChildResult
        resultSettled = true
        resolveResult(result)
      } catch (error) {
        rejectChild(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    errorOutput += chunk
  })
  child.once('error', rejectChild)
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', (code) => {
      if (!resultSettled) {
        rejectChild(new Error(`sync child exited with ${code}: ${output}\n${errorOutput}`))
      }
      resolveClosed()
    })
  })
  return {
    ready: readyPromise,
    result: resultPromise,
    release() {
      if (released) return
      released = true
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('go\n')
    },
    terminate() {
      termination ??= (async () => {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.destroy()
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await closed
      })()
      return termination
    },
  }
}

describe.concurrent('SyncSessionManager', () => {
  it('reports whether it uses a specific lease coordinator', () => {
    const leases = new ResourceLeaseCoordinator(async () => async () => undefined)
    const manager = new SyncSessionManager({ home: '/tmp/loom-sync-coordinator', leases })

    expect(manager.usesLeaseCoordinator(leases)).toBe(true)
    expect(
      manager.usesLeaseCoordinator(new ResourceLeaseCoordinator(async () => async () => undefined)),
    ).toBe(false)
  })

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
    const leaseEvents: string[] = []
    const leases = new ResourceLeaseCoordinator(async (key) => {
      leaseEvents.push(`acquire:${key}`)
      return async () => {
        leaseEvents.push(`release:${key}`)
      }
    })
    const manager = new SyncSessionManager({
      home,
      leases,
      leaseKeys: () => ['/agent-target'],
      onApplied: async (repoPath) => {
        applied.push(repoPath)
        leaseEvents.push('applied')
      },
    })
    const pulled = await manager.pull(repo)
    leaseEvents.length = 0

    const saved = await manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'value: chosen\n')

    expect(saved.clean).toBe(true)
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: chosen\n')
    const parents = (await simpleGit(repo).raw(['rev-list', '--parents', '-n', '1', 'HEAD']))
      .trim()
      .split(' ')
    expect(parents).toHaveLength(3)
    expect(await manager.getSession(repo)).toBeNull()
    expect(applied).toEqual([repo])
    const namespaceKey = leaseEvents
      .find((event) => event.startsWith('acquire:loom:sync-session:'))!
      .slice('acquire:'.length)
    expect(leaseEvents).toEqual([
      'acquire:/agent-target',
      `acquire:${repo}`,
      `acquire:${namespaceKey}`,
      'applied',
      `release:${namespaceKey}`,
      `release:${repo}`,
      'release:/agent-target',
    ])
  })

  it('serializes conflict saves from independent managers and reloads session revision', async () => {
    const { root, home, repo } = await createDivergedRepo([
      { path: 'first.yaml', base: 'base\n', ours: 'local\n', theirs: 'remote\n' },
      { path: 'second.yaml', base: 'base\n', ours: 'local\n', theirs: 'remote\n' },
    ])
    created.push(root)
    const firstManager = new SyncSessionManager({ home })
    const secondManager = new SyncSessionManager({ home })
    const pulled = await firstManager.pull(repo)

    const results = await Promise.all([
      firstManager.saveConflict(pulled.sessionId!, 'first.yaml', 'chosen first\n'),
      secondManager.saveConflict(pulled.sessionId!, 'second.yaml', 'chosen second\n'),
    ])

    expect(results.map((result) => result.clean).sort()).toEqual([false, true])
    expect(await readFile(join(repo, 'first.yaml'), 'utf8')).toBe('chosen first\n')
    expect(await readFile(join(repo, 'second.yaml'), 'utf8')).toBe('chosen second\n')
    expect(await firstManager.getSession(repo)).toBeNull()
  })

  it('serializes save and abort across independent processes', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const save = syncOperationChild('save', home, pulled.sessionId!)
    const abort = syncOperationChild('abort', home, pulled.sessionId!)
    try {
      await Promise.all([save.ready, abort.ready])
      save.release()
      abort.release()
      const results = await Promise.all([save.result, abort.result])

      expect(results.filter(({ ok }) => ok)).toHaveLength(1)
      expect(results.find(({ ok }) => !ok)?.code).toBe('session_not_found')
      expect(['value: local\n', 'value: child-save\n']).toContain(
        await readFile(join(repo, 'skills.yaml'), 'utf8'),
      )
      expect(await manager.getSession(repo)).toBeNull()
    } finally {
      await Promise.all([save.terminate(), abort.terminate()])
    }
  })

  it('accepts a legal conflict path whose name starts with two dots', async () => {
    const { root, home, repo } = await createDivergedRepo([
      { path: '..safe.yaml', base: 'base\n', ours: 'local\n', theirs: 'remote\n' },
    ])
    created.push(root)
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)

    const saved = await manager.saveConflict(pulled.sessionId!, '..safe.yaml', 'chosen\n')

    expect(saved.clean).toBe(true)
    expect(await readFile(join(repo, '..safe.yaml'), 'utf8')).toBe('chosen\n')
  })

  it('recovers projection after Git apply without losing the durable session', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const projectionError = new Error('projection failed')
    const manager = new SyncSessionManager({
      home,
      onApplied: async () => Promise.reject(projectionError),
    })
    const pulled = await manager.pull(repo)

    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'value: chosen\n'),
    ).rejects.toBe(projectionError)

    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: chosen\n')
    expect((await manager.getSession(repo))?.sessionId).toBe(pulled.sessionId)
    await expect(manager.abort(pulled.sessionId!)).rejects.toMatchObject({
      code: 'cleanup_pending',
    })

    const applied: string[] = []
    const recovered = new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    })
    await recovered.recover()

    expect(applied).toEqual([repo])
    expect(await recovered.getSession(repo)).toBeNull()
  })

  it('recovers clean-pull projection after Git apply', async () => {
    const { root, home, repo } = await createDivergedRepo([
      { path: 'local.yaml', base: 'value: base\n', ours: 'value: local\n' },
      { path: 'remote.yaml', base: 'value: base\n', theirs: 'value: remote\n' },
    ])
    created.push(root)
    const projectionError = new Error('clean pull projection failed')
    const manager = new SyncSessionManager({
      home,
      onApplied: async () => Promise.reject(projectionError),
    })

    await expect(manager.pull(repo)).rejects.toBe(projectionError)

    expect(await readFile(join(repo, 'local.yaml'), 'utf8')).toBe('value: local\n')
    expect(await readFile(join(repo, 'remote.yaml'), 'utf8')).toBe('value: remote\n')
    const pending = await manager.getSession(repo)
    expect(pending?.sessionId).toBeTruthy()
    expect(pending?.conflicts).toEqual([])
    await expect(manager.abort(pending!.sessionId!)).rejects.toMatchObject({
      code: 'cleanup_pending',
    })

    const applied: string[] = []
    const recovered = new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    })
    await recovered.recover()

    expect(applied).toEqual([repo])
    expect(await recovered.getSession(repo)).toBeNull()
  })

  it('replays an interrupted clean-pull applying phase idempotently', async () => {
    const { root, home, repo } = await createDivergedRepo([
      { path: 'local.yaml', base: 'value: base\n', ours: 'value: local\n' },
      { path: 'remote.yaml', base: 'value: base\n', theirs: 'value: remote\n' },
    ])
    created.push(root)
    const projectionError = new Error('clean pull projection failed')
    await expect(
      new SyncSessionManager({
        home,
        onApplied: async () => Promise.reject(projectionError),
      }).pull(repo),
    ).rejects.toBe(projectionError)
    const file = await sessionStateFile(home)
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...session, status: 'applying' }), 'utf8')
    const headBeforeRecovery = await simpleGit(repo).revparse(['HEAD'])
    const applied: string[] = []

    const recovered = new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    })
    await recovered.recover()

    expect(applied).toEqual([repo])
    expect(await simpleGit(repo).revparse(['HEAD'])).toBe(headBeforeRecovery)
    expect(await readFile(join(repo, 'local.yaml'), 'utf8')).toBe('value: local\n')
    expect(await readFile(join(repo, 'remote.yaml'), 'utf8')).toBe('value: remote\n')
    expect(await recovered.getSession(repo)).toBeNull()
  })

  it('auto-merges independent line edits', async () => {
    const { home, repo } = await setupRepo(
      'first: base\ncontext: unchanged\nsecond: base\n',
      'first: local\ncontext: unchanged\nsecond: base\n',
      'first: base\ncontext: unchanged\nsecond: remote\n',
    )

    const result = await new SyncSessionManager({ home }).pull(repo)

    expect(result.clean).toBe(true)
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe(
      'first: local\ncontext: unchanged\nsecond: remote\n',
    )
  })

  it('applies a nested file added only by the remote', async () => {
    const { root, home, repo } = await createDivergedRepo([
      { path: 'skills.yaml', base: 'skills: []\n' },
      { path: 'vars/local.yaml', theirs: 'key: value\n' },
    ])
    created.push(root)

    const result = await new SyncSessionManager({ home }).pull(repo)

    expect(result.clean).toBe(true)
    expect(await readFile(join(repo, 'vars', 'local.yaml'), 'utf8')).toBe('key: value\n')
  })

  it('isolates a conflict in a nested skill asset', async () => {
    const { root, home, repo } = await createDivergedRepo([
      {
        path: 'assets/skills/example/SKILL.md',
        base: 'version 1\n',
        ours: 'version 2\n',
        theirs: 'version 3\n',
      },
    ])
    created.push(root)

    const result = await new SyncSessionManager({ home }).pull(repo)

    expect(result.clean).toBe(false)
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
      'assets/skills/example/SKILL.md',
    ])
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

  it('rejects a symlink conflict without reading or writing its worktree target', async () => {
    const { root, home, repo } = await createDivergedRepo([
      {
        path: 'linked-config',
        base: 'base-target',
        ours: 'local-target',
        theirs: 'remote-target',
        baseMode: '120000',
        oursMode: '120000',
        theirsMode: '120000',
      },
    ])
    created.push(root)
    const manager = new SyncSessionManager({ home })

    const pulled = await manager.pull(repo)

    expect(pulled.clean).toBe(false)
    expect(pulled.conflicts[0]).toMatchObject({
      path: 'linked-config',
      binary: true,
      modes: ['120000', '120000', '120000'],
      unsupportedReason: 'non-regular-mode',
    })
    await expect(
      manager.saveConflict(pulled.sessionId!, 'linked-config', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
    await manager.abort(pulled.sessionId!)
  })

  it('marks oversized conflict blobs as unsupported before reading them', async () => {
    const { home, repo } = await setupRepo('base value\n', 'local value\n', 'remote value\n')
    const manager = new SyncSessionManager({ home, maxResultBytes: 4 })

    const pulled = await manager.pull(repo)

    expect(pulled.conflicts[0]).toMatchObject({
      binary: true,
      unsupportedReason: 'too-large',
      base: null,
      ours: null,
      theirs: null,
    })
    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'text'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
  })

  it('marks NUL conflict blobs as binary content', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\0\n', 'value: remote\0\n')
    const manager = new SyncSessionManager({ home })

    const pulled = await manager.pull(repo)

    expect(pulled.conflicts[0]).toMatchObject({
      binary: true,
      unsupportedReason: 'binary-content',
    })
    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
  })

  it('marks invalid UTF-8 index blobs as unsupported', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
    const [repoHash] = await readdir(cacheRoot)
    const worktree = join(cacheRoot, repoHash!, pulled.sessionId!)
    const oid = await gitWithInput(worktree, ['hash-object', '-w', '--stdin'], Uint8Array.of(0xff))
    await gitWithInput(
      worktree,
      ['update-index', '--index-info'],
      Buffer.from(`100644 ${oid} 2\tskills.yaml\n`),
    )

    const restored = await manager.getSession(repo)

    expect(restored?.conflicts[0]).toMatchObject({
      binary: true,
      unsupportedReason: 'invalid-utf8',
      ours: null,
    })
    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
  })

  it('rejects a regular conflict replaced by a symlink before save', async () => {
    const { root, home, repo } = await setupRepo(
      'value: base\n',
      'value: local\n',
      'value: remote\n',
    )
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
    const [repoHash] = await readdir(cacheRoot)
    const conflictPath = join(cacheRoot, repoHash!, pulled.sessionId!, 'skills.yaml')
    const sentinel = join(root, 'sentinel.txt')
    await writeFile(sentinel, 'outside')
    await rm(conflictPath)
    await symlink(sentinel, conflictPath)

    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
    expect(await readFile(sentinel, 'utf8')).toBe('outside')
    await manager.abort(pulled.sessionId!)
  })

  it('rejects a conflict target replaced by a hardlink', async () => {
    const { root, home, repo } = await setupRepo(
      'value: base\n',
      'value: local\n',
      'value: remote\n',
    )
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
    const [repoHash] = await readdir(cacheRoot)
    const conflictPath = join(cacheRoot, repoHash!, pulled.sessionId!, 'skills.yaml')
    const sentinel = join(root, 'hardlink-sentinel')
    await writeFile(sentinel, 'outside\n')
    await rm(conflictPath)
    await link(sentinel, conflictPath)

    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
    expect(await readFile(sentinel, 'utf8')).toBe('outside\n')
  })

  it('rejects a conflict whose parent was replaced by a link', async () => {
    const { root, home, repo } = await createDivergedRepo([
      {
        path: 'nested/config.yaml',
        base: 'value: base\n',
        ours: 'value: local\n',
        theirs: 'value: remote\n',
      },
    ])
    created.push(root)
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
    const [repoHash] = await readdir(cacheRoot)
    const parent = join(cacheRoot, repoHash!, pulled.sessionId!, 'nested')
    const external = join(root, 'external-parent')
    await mkdir(external)
    await writeFile(join(external, 'config.yaml'), 'outside\n')
    await rename(parent, `${parent}.backup`)
    await symlink(external, parent, 'dir')

    await expect(
      manager.saveConflict(pulled.sessionId!, 'nested/config.yaml', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
    expect(await readFile(join(external, 'config.yaml'), 'utf8')).toBe('outside\n')
  })

  it('rejects a conflict target replaced by a directory', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
    const [repoHash] = await readdir(cacheRoot)
    const conflictPath = join(cacheRoot, repoHash!, pulled.sessionId!, 'skills.yaml')
    await rm(conflictPath)
    await mkdir(conflictPath)

    await expect(
      manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'replacement'),
    ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a conflict target replaced by a FIFO without opening it',
    async () => {
      const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
      const manager = new SyncSessionManager({ home })
      const pulled = await manager.pull(repo)
      const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
      const [repoHash] = await readdir(cacheRoot)
      const conflictPath = join(cacheRoot, repoHash!, pulled.sessionId!, 'skills.yaml')
      await rm(conflictPath)
      await new Promise<void>((resolveFifo, rejectFifo) => {
        execFile('mkfifo', [conflictPath], (err) => {
          if (err) rejectFifo(err)
          else resolveFifo()
        })
      })

      await expect(
        manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'replacement'),
      ).rejects.toMatchObject({ code: 'unsupported_conflict_type' })
      await manager.abort(pulled.sessionId!)
    },
  )

  it('preserves executable mode when saving a regular conflict', async () => {
    const { root, home, repo } = await createDivergedRepo([
      {
        path: 'script.sh',
        base: 'echo base\n',
        ours: 'echo local\n',
        theirs: 'echo remote\n',
        baseMode: '100755',
        oursMode: '100755',
        theirsMode: '100755',
      },
    ])
    created.push(root)
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)

    await manager.saveConflict(pulled.sessionId!, 'script.sh', 'echo chosen\n')

    expect((await lstat(join(repo, 'script.sh'))).mode & 0o111).toBe(0o111)
  })

  it('does not follow a worktree directory symlink while enforcing quota', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })
    const pulled = await manager.pull(repo)
    const cacheRoot = join(home, '.loom', 'cache', 'sync-worktrees')
    const [repoHash] = await readdir(cacheRoot)
    const worktree = join(cacheRoot, repoHash!, pulled.sessionId!)
    await symlink(worktree, join(worktree, 'loop'), 'dir')

    const saved = await manager.saveConflict(pulled.sessionId!, 'skills.yaml', 'value: chosen\n')

    expect(saved.clean).toBe(true)
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: chosen\n')
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

  it('resumes cleanup without repeating completed journal steps', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    let removeWorktreeCalls = 0
    let removeDirectoryCalls = 0
    const removeWorktree = async (_repoPath: string, worktreePath: string) => {
      removeWorktreeCalls++
      await rm(worktreePath, { recursive: true, force: true })
    }
    const removeDirectory = async (path: string) => {
      removeDirectoryCalls++
      if (removeDirectoryCalls === 1) throw new Error('directory is temporarily busy')
      await rm(path, { recursive: true, force: true })
    }
    const manager = new SyncSessionManager({
      home,
      cleanupOperations: { removeWorktree, removeDirectory },
    })
    const session = await manager.pull(repo)

    await expect(manager.abort(session.sessionId!)).rejects.toMatchObject({
      code: 'cleanup_pending',
      message: '同步结果已处理，但临时文件清理失败',
    })
    expect(removeWorktreeCalls).toBe(1)
    const pending = JSON.parse(await readFile(await sessionStateFile(home), 'utf8')) as {
      cleanupProgress: Record<string, boolean>
    }
    expect(pending.cleanupProgress).toMatchObject({
      worktreeRemoved: true,
      directoryRemoved: false,
    })

    await manager.recover()

    expect(removeWorktreeCalls).toBe(1)
    expect(removeDirectoryCalls).toBe(2)
    expect(await manager.getSession(repo)).toBeNull()
  })

  it('does not delete a session worktree restored after the cleanup snapshot', async () => {
    const first = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const second = await setupRepo('value: base\n', 'value: other\n', 'value: upstream\n')
    const bootstrap = new SyncSessionManager({ home: first.home })
    const concurrent = await bootstrap.pull(second.repo)
    const concurrentState = await sessionStateFile(first.home)
    const concurrentDocument = JSON.parse(await readFile(concurrentState, 'utf8')) as {
      worktreePath: string
    }
    const stagedState = `${concurrentState}.staged`
    const stagedWorktree = join(second.root, 'staged-sync-worktree')
    await rename(concurrentState, stagedState)
    await rename(concurrentDocument.worktreePath, stagedWorktree)

    let directoryRemoval = 0
    const manager = new SyncSessionManager({
      home: first.home,
      cleanupOperations: {
        removeDirectory: async (path) => {
          directoryRemoval += 1
          if (directoryRemoval === 1) throw new Error('directory is temporarily busy')
          await rename(stagedState, concurrentState)
          await rename(stagedWorktree, concurrentDocument.worktreePath)
          await rm(path, { recursive: true, force: true })
        },
      },
    })
    const deleting = await manager.pull(first.repo)
    await expect(manager.abort(deleting.sessionId!)).rejects.toMatchObject({
      code: 'cleanup_pending',
    })

    await manager.recover()

    await expect(readFile(concurrentState, 'utf8')).resolves.toContain(concurrent.sessionId!)
    expect((await lstat(concurrentDocument.worktreePath)).isDirectory()).toBe(true)
    expect((await manager.getSession(second.repo))?.sessionId).toBe(concurrent.sessionId)
  })

  it('preserves an orphan path replacement after capturing the original identity', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'loom-sync-orphan-identity-')))
    created.push(home)
    const repoHash = 'a'.repeat(24)
    const sessionId = randomUUID()
    const cacheParent = join(home, '.loom', 'cache', 'sync-worktrees', repoHash)
    const candidate = join(cacheParent, sessionId)
    const parked = join(home, 'parked-orphan')
    const sentinel = join(candidate, 'sentinel.txt')
    await mkdir(candidate, { recursive: true })
    await writeFile(join(candidate, 'original.txt'), 'original')

    const nodeFs = new NodeFileSystem()
    let resumeRemoval!: () => void
    let removalStarted!: () => void
    const removalGate = new Promise<void>((resolve) => {
      resumeRemoval = resolve
    })
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve
    })
    const errors: Array<Record<string, unknown> | undefined> = []
    const manager = new SyncSessionManager({
      home,
      logger: {
        error: (_message, context) => errors.push(context),
        warn: () => undefined,
      },
      orphanFs: {
        inspectEntry: nodeFs.inspectEntry.bind(nodeFs),
        realPath: nodeFs.realPath.bind(nodeFs),
        removeEntryIfIdentity: async (path, identity) => {
          removalStarted()
          await removalGate
          await nodeFs.removeEntryIfIdentity(path, identity)
        },
      },
    })

    const recovery = manager.recover()
    await started
    await rename(candidate, parked)
    await mkdir(candidate)
    await writeFile(sentinel, 'replacement')
    resumeRemoval()
    await recovery

    await expect(readFile(sentinel, 'utf8')).resolves.toBe('replacement')
    await expect(readFile(join(parked, 'original.txt'), 'utf8')).resolves.toBe('original')
    expect(errors).toContainEqual(
      expect.objectContaining({
        err: expect.any(Error),
        path: candidate,
      }),
    )
  })

  it('cleans managed session state after its repository is deleted', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const manager = new SyncSessionManager({ home })
    await manager.pull(repo)
    const stateFile = await sessionStateFile(home)
    const session = JSON.parse(await readFile(stateFile, 'utf8')) as { worktreePath: string }
    await rm(repo, { recursive: true, force: true })
    const removeWorktree = vi.fn(async () => undefined)
    const deleteRef = vi.fn(async () => undefined)
    const pruneWorktrees = vi.fn(async () => undefined)

    await new SyncSessionManager({
      home,
      cleanupOperations: { removeWorktree, deleteRef, pruneWorktrees },
    }).recover()

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(deleteRef).not.toHaveBeenCalled()
    expect(pruneWorktrees).not.toHaveBeenCalled()
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(session.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans Git metadata when a missing repository returns during cleanup', async () => {
    const { home, repo, root } = await setupRepo(
      'value: base\n',
      'value: local\n',
      'value: remote\n',
    )
    const active = await new SyncSessionManager({ home }).pull(repo)
    const stateFile = await sessionStateFile(home)
    const session = JSON.parse(await readFile(stateFile, 'utf8')) as { worktreePath: string }
    const parkedRepo = join(root, 'parked-repository')
    await rename(repo, parkedRepo)
    let restored = false

    await new SyncSessionManager({
      home,
      cleanupOperations: {
        removeDirectory: async (path) => {
          if (!restored) {
            await rename(parkedRepo, repo)
            restored = true
          }
          await rm(path, { recursive: true, force: true })
        },
      },
    }).recover()

    expect(restored).toBe(true)
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const refs = await simpleGit(repo).raw([
      'for-each-ref',
      '--format=%(refname)',
      'refs/loom/sync',
    ])
    expect(refs).not.toContain(active.sessionId!)
    const worktrees = await simpleGit(repo).raw(['worktree', 'list', '--porcelain'])
    expect(worktrees).not.toContain(session.worktreePath)
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

  it('initializes a genuinely unborn repository during force pull', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'loom-unborn-sync-')))
    const bare = await createBareRepo([
      { message: 'initial', files: { 'skills.yaml': 'value: remote\n' } },
    ])
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    created.push(root, bare)
    await mkdir(repo)
    const git = simpleGit(repo)
    await git.raw(['init', '-b', 'main'])
    await git.addRemote('origin', bare)

    const result = await new SyncSessionManager({ home }).forcePull(repo)

    expect(result.clean).toBe(true)
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: remote\n')
  })

  it('does not classify an invalid existing HEAD as unborn', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const oid = await gitWithInput(
      repo,
      ['hash-object', '-w', '--stdin'],
      Buffer.from('not a commit'),
    )
    await simpleGit(repo).raw(['update-ref', 'refs/loom/invalid-head', oid])
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/loom/invalid-head\n')
    const logger = { error: vi.fn(), warn: vi.fn() }

    await expect(new SyncSessionManager({ home, logger }).forcePull(repo)).rejects.toBeDefined()

    expect(logger.error).toHaveBeenCalledWith(
      'force pull HEAD read failed',
      expect.objectContaining({ err: expect.anything(), repoPath: repo }),
    )
  })

  it('recovers force-pull projection after the repository was reset', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const projectionError = new Error('force projection failed')
    const manager = new SyncSessionManager({
      home,
      onApplied: async () => Promise.reject(projectionError),
    })

    await expect(manager.forcePull(repo)).rejects.toBe(projectionError)

    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: remote\n')
    expect(await manager.getSession(repo)).not.toBeNull()
    const applied: string[] = []
    const recovered = new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    })
    await recovered.recover()

    expect(applied).toEqual([repo])
    expect(await recovered.getSession(repo)).toBeNull()
  })

  it('replays an interrupted force-pull applying phase before projection', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const projectionError = new Error('force projection failed')
    await expect(
      new SyncSessionManager({
        home,
        onApplied: async () => Promise.reject(projectionError),
      }).forcePull(repo),
    ).rejects.toBe(projectionError)
    const file = await sessionStateFile(home)
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...session, status: 'applying' }), 'utf8')
    await writeFile(join(repo, 'skills.yaml'), 'value: drifted\n')
    await writeFile(join(repo, 'local-only.yaml'), 'remove me\n')
    const applied: string[] = []

    const recovered = new SyncSessionManager({
      home,
      onApplied: async (repoPath) => {
        applied.push(repoPath)
      },
    })
    await recovered.recover()

    expect(applied).toEqual([repo])
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).toBe('value: remote\n')
    await expect(readFile(join(repo, 'local-only.yaml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await recovered.getSession(repo)).toBeNull()
  })

  it.each(['state', 'cache'] as const)(
    'rejects a linked %s root without writing through it',
    async (managedRoot) => {
      const { root, home, repo } = await setupRepo(
        'value: base\n',
        'value: local\n',
        'value: remote\n',
      )
      const external = join(root, `external-${managedRoot}`)
      await mkdir(join(home, '.loom'), { recursive: true })
      await mkdir(external)
      await writeFile(join(external, 'sentinel'), 'outside\n')
      await symlink(external, join(home, '.loom', managedRoot), 'dir')

      await expect(new SyncSessionManager({ home }).pull(repo)).rejects.toMatchObject({
        code: 'cleanup_pending',
      })

      expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe('outside\n')
      expect(await readdir(external)).toEqual(['sentinel'])
    },
  )

  it('cleans an interrupted setup session during recovery', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const projectionError = new Error('projection failed')
    await expect(
      new SyncSessionManager({
        home,
        onApplied: async () => Promise.reject(projectionError),
      }).forcePull(repo),
    ).rejects.toBe(projectionError)
    const file = await sessionStateFile(home)
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(
      file,
      JSON.stringify({
        ...session,
        operation: 'merge',
        setupStep: 'initialized',
        status: 'setup',
      }),
      'utf8',
    )

    const recovered = new SyncSessionManager({ home })
    await recovered.recover()

    expect(await recovered.getSession(repo)).toBeNull()
  })

  it('fails closed when persisted session metadata is tampered with', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const projectionError = new Error('projection failed')
    await expect(
      new SyncSessionManager({
        home,
        onApplied: async () => Promise.reject(projectionError),
      }).forcePull(repo),
    ).rejects.toBe(projectionError)
    const file = await sessionStateFile(home)
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const cases = [
      ['version', 1],
      ['revision', 0],
      ['status', 'unknown'],
      ['repoHash', '0'.repeat(24)],
      ['repoIdentity', '0:0'],
      ['worktreePath', join(home, 'outside')],
      ['startHead', 'not-an-oid'],
      ['createdAt', 'not-a-date'],
    ] as const

    for (const [field, value] of cases) {
      await writeFile(file, JSON.stringify({ ...original, [field]: value }), 'utf8')
      const logger = { error: vi.fn(), warn: vi.fn() }
      await expect(new SyncSessionManager({ home, logger }).getSession(repo)).rejects.toMatchObject(
        {
          code: 'cleanup_pending',
        },
      )
      expect(logger.error).toHaveBeenCalledWith(
        'sync session state unreadable',
        expect.objectContaining({ err: expect.anything(), path: file }),
      )
    }
  })

  it('rejects duplicate active sessions for the same repository', async () => {
    const { home, repo } = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
    const projectionError = new Error('projection failed')
    await expect(
      new SyncSessionManager({
        home,
        onApplied: async () => Promise.reject(projectionError),
      }).forcePull(repo),
    ).rejects.toBe(projectionError)
    const file = await sessionStateFile(home)
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const sessionId = randomUUID()
    const duplicate = {
      ...original,
      sessionId,
      worktreePath: join(
        home,
        '.loom',
        'cache',
        'sync-worktrees',
        original.repoHash as string,
        sessionId,
      ),
    }
    await writeFile(join(dirname(file), `${sessionId}.json`), JSON.stringify(duplicate), 'utf8')

    await expect(new SyncSessionManager({ home }).getSession(repo)).rejects.toMatchObject({
      code: 'cleanup_pending',
      message: '检测到重复的同步会话，已停止继续操作',
    })
  })
})
