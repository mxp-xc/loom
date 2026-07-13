import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { simpleGit } from 'simple-git'
import type { GitConflictFile } from './pull.js'

type SessionStatus = 'resolving' | 'applying' | 'deleting'

interface SyncSession {
  version: 1
  sessionId: string
  repoPath: string
  repoHash: string
  worktreePath: string
  startHead: string
  remoteTip: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface SyncSessionResult {
  sessionId?: string
  clean: boolean
  conflicts: GitConflictFile[]
}

type Logger = {
  error: (message: string, context?: Record<string, unknown>) => void
  warn: (message: string, context?: Record<string, unknown>) => void
  info?: (message: string, context?: Record<string, unknown>) => void
}

export class SyncSessionError extends Error {
  constructor(
    readonly code:
      | 'session_not_found'
      | 'repo_busy'
      | 'storage_quota_exceeded'
      | 'cleanup_pending'
      | 'active_session_exists',
    message: string,
  ) {
    super(message)
  }
}

export interface SyncSessionManagerOptions {
  home: string
  logger?: Logger
  onApplied?: (repoPath: string) => Promise<void>
  maxWorktrees?: number
  maxTotalBytes?: number
  maxSessionBytes?: number
  maxResultBytes?: number
  cleanupOperations?: Partial<CleanupOperations>
}

interface CleanupOperations {
  removeWorktree: (repoPath: string, worktreePath: string) => Promise<void>
  removeDirectory: (path: string) => Promise<void>
  deleteRef: (repoPath: string, ref: string) => Promise<void>
  pruneWorktrees: (repoPath: string) => Promise<void>
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})(?: |$)/m

export class SyncSessionManager {
  private readonly cacheRoot: string
  private readonly stateRoot: string
  private readonly logger?: Logger
  private readonly onApplied?: (repoPath: string) => Promise<void>
  private readonly maxWorktrees: number
  private readonly maxTotalBytes: number
  private readonly maxSessionBytes: number
  private readonly maxResultBytes: number
  private readonly cleanupOperations: CleanupOperations

  constructor(options: SyncSessionManagerOptions) {
    const loomRoot = join(options.home, '.loom')
    this.cacheRoot = join(loomRoot, 'cache', 'sync-worktrees')
    this.stateRoot = join(loomRoot, 'state', 'sync-sessions')
    this.logger = options.logger
    this.onApplied = options.onApplied
    this.maxWorktrees = options.maxWorktrees ?? envNumber('LOOM_SYNC_MAX_WORKTREES', 16)
    this.maxTotalBytes = options.maxTotalBytes ?? envNumber('LOOM_SYNC_MAX_BYTES', 2 * 1024 ** 3)
    this.maxSessionBytes =
      options.maxSessionBytes ?? envNumber('LOOM_SYNC_MAX_SESSION_BYTES', 512 * 1024 ** 2)
    this.maxResultBytes =
      options.maxResultBytes ?? envNumber('LOOM_SYNC_MAX_RESULT_BYTES', 10 * 1024 ** 2)
    this.cleanupOperations = {
      removeWorktree: async (repoPath, worktreePath) => {
        await simpleGit(repoPath).raw(['worktree', 'remove', '--force', worktreePath])
      },
      removeDirectory: async (path) => rm(path, { recursive: true, force: true }),
      deleteRef: async (repoPath, ref) => {
        await simpleGit(repoPath).raw(['update-ref', '-d', ref])
      },
      pruneWorktrees: async (repoPath) => {
        await simpleGit(repoPath).raw(['worktree', 'prune', '--expire', 'now'])
      },
      ...options.cleanupOperations,
    }
  }

  startMaintenance(intervalMs = 10 * 60_000): () => void {
    const timer = setInterval(() => {
      void this.retryCleanup().catch((err) =>
        this.logger?.error('periodic sync cleanup failed', { err }),
      )
    }, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  async pull(repoPath: string): Promise<SyncSessionResult> {
    const canonical = await realpath(repoPath)
    return this.withRepoLock(canonical, async () => {
      await this.retryCleanup()
      const active = await this.loadForRepo(canonical)
      if (active) {
        if (active.status === 'deleting') {
          throw new SyncSessionError('cleanup_pending', '上一次同步会话仍在清理')
        }
        return this.resultFor(active)
      }

      const legacyPaths = await unmergedPaths(canonical)
      if (legacyPaths.length > 0) {
        const git = simpleGit(canonical)
        const remoteTip = (await git.raw(['rev-parse', 'MERGE_HEAD'])).trim()
        const recoveryRef = `refs/loom/recovery/${hashPath(canonical)}`
        await git.raw(['update-ref', recoveryRef, remoteTip])
        await git.raw(['merge', '--abort'])
        try {
          await this.createFromKnownRemote(canonical, remoteTip)
        } finally {
          await git
            .raw(['update-ref', '-d', recoveryRef])
            .catch((err) =>
              this.logger?.error('legacy recovery ref removal failed', { err, recoveryRef }),
            )
        }
        const migrated = await this.loadForRepo(canonical)
        if (!migrated) throw new Error('旧版冲突迁移后未找到同步会话')
        return this.resultFor(migrated)
      }

      await this.assertQuota()
      const git = simpleGit(canonical)
      if ((await git.status()).isClean() === false) {
        await git.add('.')
        await git.commit('loom: auto-commit before pull')
      }
      await git.raw(['fetch', 'origin', '--tags'])
      const startHead = (await git.raw(['rev-parse', 'HEAD'])).trim()
      const remoteTip = (await git.raw(['rev-parse', 'FETCH_HEAD'])).trim()
      const repoHash = hashPath(canonical)
      const sessionId = randomUUID()
      const worktreePath = join(this.cacheRoot, repoHash, sessionId)
      await mkdir(dirname(worktreePath), { recursive: true })
      await mkdir(join(this.stateRoot, repoHash), { recursive: true })
      await git.raw(['worktree', 'add', '--detach', worktreePath, startHead])

      const now = new Date().toISOString()
      const session: SyncSession = {
        version: 1,
        sessionId,
        repoPath: canonical,
        repoHash,
        worktreePath,
        startHead,
        remoteTip,
        status: 'resolving',
        createdAt: now,
        updatedAt: now,
      }
      await this.writeSession(session)
      await git.raw(['update-ref', this.ref(session, 'remote'), remoteTip])

      const merge = await mergeRef(worktreePath, remoteTip)
      this.logger?.info?.('isolated merge completed', {
        sessionId,
        startHead,
        remoteTip,
        clean: merge.clean,
        worktreeHead: await worktreeGitHead(worktreePath),
      })
      await this.assertSessionSize(session)
      if (!merge.clean) return this.resultFor(session)
      return this.finalize(session)
    })
  }

  async forcePull(repoPath: string): Promise<SyncSessionResult> {
    const canonical = await realpath(repoPath)
    this.logger?.info?.('force pull started', { repoPath: canonical })
    return this.withRepoLock(canonical, async () => {
      await this.retryCleanup()
      const active = await this.loadForRepo(canonical)
      if (active) {
        if (active.status === 'deleting') {
          throw new SyncSessionError('cleanup_pending', '上一次同步会话仍在清理')
        }
        throw new SyncSessionError('active_session_exists', '请先解决或放弃当前同步会话')
      }

      const git = simpleGit(canonical)
      await git.raw(['fetch', 'origin', '--tags'])
      const remoteTip = (await git.raw(['rev-parse', 'FETCH_HEAD'])).trim()
      try {
        await git.raw(['rev-parse', 'HEAD'])
      } catch {
        await git.raw(['update-ref', 'HEAD', remoteTip])
      }
      await git.raw(['reset', '--hard', remoteTip])
      await git.raw(['clean', '-fd'])
      await this.onApplied?.(canonical)
      this.logger?.info?.('force pull completed', { repoPath: canonical, remoteTip })
      return { clean: true, conflicts: [] }
    })
  }

  async getSession(repoPath: string): Promise<SyncSessionResult | null> {
    const canonical = await realpath(repoPath)
    const session = await this.loadForRepo(canonical)
    if (!session || session.status === 'deleting') return null
    return this.resultFor(session)
  }

  async saveConflict(
    sessionId: string,
    path: string,
    result: string,
  ): Promise<{ clean: boolean; remaining: GitConflictFile[]; sessionId?: string }> {
    if (Buffer.byteLength(result, 'utf8') > this.maxResultBytes) {
      throw new SyncSessionError('storage_quota_exceeded', '冲突文件结果超过大小限制')
    }
    if (CONFLICT_MARKER.test(result)) throw new Error('结果仍包含未解决的冲突标记')
    const session = await this.loadById(sessionId)
    if (!session || session.status === 'deleting') {
      throw new SyncSessionError('session_not_found', '同步会话不存在或已结束')
    }
    return this.withRepoLock(session.repoPath, async () => {
      const safePath = await this.assertConflictPath(session, path)
      await writeFile(safePath, result, 'utf8')
      const worktreeGit = simpleGit(session.worktreePath)
      await worktreeGit.add([path])
      await this.assertSessionSize(session)
      const remaining = await unmergedPaths(session.worktreePath)
      if (remaining.length > 0) {
        session.updatedAt = new Date().toISOString()
        await this.writeSession(session)
        return {
          clean: false,
          remaining: await readConflicts(session.worktreePath, remaining, this.logger),
          sessionId,
        }
      }

      await worktreeGit.commit('merge: resolve conflicts')
      const finalized = await this.finalize(session)
      return {
        clean: finalized.clean,
        remaining: finalized.conflicts,
        sessionId: finalized.sessionId,
      }
    })
  }

  async abort(sessionId: string): Promise<void> {
    const session = await this.loadById(sessionId)
    if (!session) throw new SyncSessionError('session_not_found', '同步会话不存在或已结束')
    await this.withRepoLock(session.repoPath, async () => this.cleanup(session))
  }

  async recover(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true })
    await mkdir(this.stateRoot, { recursive: true })
    await this.retryCleanup()
    for (const session of await this.loadAll()) {
      if (session.status !== 'applying') continue
      try {
        await this.withRepoLock(session.repoPath, async () => this.finalize(session))
      } catch (err) {
        this.logger?.error('applying sync session recovery failed', {
          err,
          sessionId: session.sessionId,
        })
      }
    }
    const reposRoot = join(dirname(dirname(this.cacheRoot)), 'repos')
    let names: string[] = []
    try {
      names = await readdir(reposRoot)
    } catch (err) {
      this.logger?.warn('managed repositories unavailable during sync recovery', { err, reposRoot })
      return
    }
    for (const name of names) {
      const repoPath = join(reposRoot, name)
      if (!(await pathExists(join(repoPath, '.git')))) continue
      try {
        await this.migrateLegacyConflict(repoPath)
      } catch (err) {
        if (err instanceof SyncSessionError && err.code === 'repo_busy') {
          this.logger?.warn('legacy conflict migration deferred because repository is busy', {
            err,
            repoPath,
          })
        } else {
          this.logger?.error('legacy conflict migration failed', { err, repoPath })
        }
      }
    }
  }

  private async migrateLegacyConflict(repoPath: string): Promise<void> {
    const canonical = await realpath(repoPath)
    await this.withRepoLock(canonical, async () => {
      if (await this.loadForRepo(canonical)) return
      const paths = await unmergedPaths(canonical)
      if (paths.length === 0) return
      const git = simpleGit(canonical)
      const remoteTip = (await git.raw(['rev-parse', 'MERGE_HEAD'])).trim()
      await git.raw(['merge', '--abort'])
      await this.createFromKnownRemote(canonical, remoteTip)
      this.logger?.info?.('legacy conflict migrated to isolated sync session', {
        repoPath: canonical,
        remoteTip,
        paths,
      })
    })
  }

  private async createFromKnownRemote(repoPath: string, remoteTip: string): Promise<void> {
    await this.assertQuota()
    const git = simpleGit(repoPath)
    const startHead = (await git.raw(['rev-parse', 'HEAD'])).trim()
    const repoHash = hashPath(repoPath)
    const sessionId = randomUUID()
    const worktreePath = join(this.cacheRoot, repoHash, sessionId)
    await mkdir(dirname(worktreePath), { recursive: true })
    await mkdir(join(this.stateRoot, repoHash), { recursive: true })
    await git.raw(['worktree', 'add', '--detach', worktreePath, startHead])
    const now = new Date().toISOString()
    const session: SyncSession = {
      version: 1,
      sessionId,
      repoPath,
      repoHash,
      worktreePath,
      startHead,
      remoteTip,
      status: 'resolving',
      createdAt: now,
      updatedAt: now,
    }
    await this.writeSession(session)
    await git.raw(['update-ref', this.ref(session, 'remote'), remoteTip])
    await mergeRef(worktreePath, remoteTip)
  }

  private async finalize(session: SyncSession): Promise<SyncSessionResult> {
    session.status = 'applying'
    session.updatedAt = new Date().toISOString()
    await this.writeSession(session)
    const worktreeGit = simpleGit(session.worktreePath)
    const resolved = (await worktreeGit.raw(['rev-parse', 'HEAD'])).trim()
    await simpleGit(session.repoPath).raw(['update-ref', this.ref(session, 'resolved'), resolved])

    const formalGit = simpleGit(session.repoPath)
    if ((await formalGit.status()).isClean() === false) {
      await formalGit.add('.')
      await formalGit.commit('loom: sync changes during pull')
    }
    const latest = (await formalGit.raw(['rev-parse', 'HEAD'])).trim()

    let candidate = resolved
    if (latest !== session.startHead) {
      await worktreeGit.raw(['reset', '--hard', latest])
      const merged = await mergeRef(session.worktreePath, resolved)
      session.startHead = latest
      if (!merged.clean) {
        session.status = 'resolving'
        session.updatedAt = new Date().toISOString()
        await this.writeSession(session)
        return this.resultFor(session)
      }
      candidate = (await worktreeGit.raw(['rev-parse', 'HEAD'])).trim()
    }
    await formalGit.raw(['update-ref', this.ref(session, 'candidate'), candidate])

    const currentHead = (await formalGit.raw(['rev-parse', 'HEAD'])).trim()
    const currentStatus = await formalGit.status()
    if (currentHead !== latest || !currentStatus.isClean()) {
      session.status = 'resolving'
      session.updatedAt = new Date().toISOString()
      await this.writeSession(session)
      return this.finalize(session)
    }
    await formalGit.raw(['merge', '--ff-only', candidate])
    await this.cleanup(session)
    await this.onApplied?.(session.repoPath)
    return { clean: true, conflicts: [] }
  }

  private async resultFor(session: SyncSession): Promise<SyncSessionResult> {
    const paths = await unmergedPaths(session.worktreePath)
    return {
      sessionId: session.sessionId,
      clean: paths.length === 0 && session.status === 'deleting',
      conflicts: await readConflicts(session.worktreePath, paths, this.logger),
    }
  }

  private async assertConflictPath(session: SyncSession, path: string): Promise<string> {
    const paths = await unmergedPaths(session.worktreePath)
    if (!paths.includes(path)) throw new Error(`不是当前冲突文件: ${path}`)
    const fullPath = join(session.worktreePath, path)
    const relative = fullPath.slice(session.worktreePath.length + 1)
    if (relative.startsWith('..') || relative !== path) throw new Error('无效的冲突文件路径')
    return fullPath
  }

  private async cleanup(session: SyncSession): Promise<void> {
    session.status = 'deleting'
    session.updatedAt = new Date().toISOString()
    await this.writeSession(session)
    const errors: unknown[] = []
    const repoExists = await pathExists(session.repoPath)
    if (repoExists) {
      try {
        await this.cleanupOperations.removeWorktree(session.repoPath, session.worktreePath)
      } catch (err) {
        if (await pathExists(session.worktreePath)) {
          errors.push(err)
          this.logger?.error('git worktree removal failed', { err, sessionId: session.sessionId })
        }
      }
    }
    try {
      await this.cleanupOperations.removeDirectory(session.worktreePath)
    } catch (err) {
      errors.push(err)
      this.logger?.error('sync worktree directory removal failed', {
        err,
        sessionId: session.sessionId,
      })
    }
    if (repoExists) {
      for (const name of ['remote', 'resolved', 'candidate']) {
        try {
          await this.cleanupOperations.deleteRef(session.repoPath, this.ref(session, name))
        } catch (err) {
          errors.push(err)
          this.logger?.error('sync session ref removal failed', {
            err,
            sessionId: session.sessionId,
            ref: name,
          })
        }
      }
      try {
        await this.cleanupOperations.pruneWorktrees(session.repoPath)
      } catch (err) {
        errors.push(err)
        this.logger?.error('git worktree prune failed', { err, sessionId: session.sessionId })
      }
    }
    if (errors.length > 0)
      throw new SyncSessionError('cleanup_pending', '同步结果已处理，但临时文件清理失败')
    await rm(this.sessionFile(session), { force: true })
  }

  private async retryCleanup(): Promise<void> {
    const sessions = await this.loadAll()
    for (const session of sessions) {
      if (session.status !== 'deleting') continue
      try {
        await this.cleanup(session)
      } catch (err) {
        this.logger?.error('sync session cleanup retry failed', {
          err,
          sessionId: session.sessionId,
        })
      }
    }
    const known = new Set(sessions.map((session) => session.worktreePath))
    for (const path of await listLeafDirectories(this.cacheRoot)) {
      if (known.has(path)) continue
      try {
        await rm(path, { recursive: true, force: true })
        this.logger?.info?.('orphaned sync worktree directory removed', { path })
      } catch (err) {
        this.logger?.error('orphaned sync worktree directory removal failed', { err, path })
      }
    }
  }

  private async assertQuota(): Promise<void> {
    const entries = await listLeafDirectories(this.cacheRoot)
    let total = 0
    for (const path of entries) total += await directorySize(path)
    if (entries.length >= this.maxWorktrees || total >= this.maxTotalBytes) {
      throw new SyncSessionError('storage_quota_exceeded', '同步 worktree 缓存已达到容量限制')
    }
  }

  private async assertSessionSize(session: SyncSession): Promise<void> {
    const sessionBytes = await directorySize(session.worktreePath)
    const worktrees = await listLeafDirectories(this.cacheRoot)
    let totalBytes = 0
    for (const path of worktrees) totalBytes += await directorySize(path)
    if (sessionBytes <= this.maxSessionBytes && totalBytes <= this.maxTotalBytes) return
    await this.cleanup(session).catch((err) => {
      this.logger?.error('oversized sync session cleanup failed', {
        err,
        sessionId: session.sessionId,
      })
    })
    throw new SyncSessionError('storage_quota_exceeded', '同步会话超过单会话容量限制')
  }

  private async withRepoLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(repoPath, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 2, minTimeout: 50, maxTimeout: 200 },
      })
    } catch (err) {
      this.logger?.warn('sync repository lock unavailable', { err, repoPath })
      throw new SyncSessionError('repo_busy', '仓库正在执行其他同步操作')
    }
    try {
      return await operation()
    } finally {
      await release().catch((err) =>
        this.logger?.error('sync repository unlock failed', { err, repoPath }),
      )
    }
  }

  private async loadForRepo(repoPath: string): Promise<SyncSession | null> {
    const file = join(this.stateRoot, hashPath(repoPath))
    let names: string[] = []
    try {
      names = await readdir(file)
    } catch {
      return null
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const session = await this.readSession(join(file, name))
      if (session) return session
    }
    return null
  }

  private async loadById(sessionId: string): Promise<SyncSession | null> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null
    return (await this.loadAll()).find((session) => session.sessionId === sessionId) ?? null
  }

  private async loadAll(): Promise<SyncSession[]> {
    const sessions: SyncSession[] = []
    let hashes: string[] = []
    try {
      hashes = await readdir(this.stateRoot)
    } catch {
      return sessions
    }
    for (const hash of hashes) {
      let names: string[] = []
      try {
        names = await readdir(join(this.stateRoot, hash))
      } catch (err) {
        this.logger?.error('sync session state directory unreadable', { err, hash })
        throw new SyncSessionError('cleanup_pending', '同步会话状态目录无法读取')
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const session = await this.readSession(join(this.stateRoot, hash, name))
        if (session) sessions.push(session)
      }
    }
    return sessions
  }

  private async readSession(path: string): Promise<SyncSession | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as SyncSession
      const valid =
        value.version === 1 &&
        /^[0-9a-f-]{36}$/i.test(value.sessionId) &&
        /^[0-9a-f]{24}$/.test(value.repoHash) &&
        basename(path) === `${value.sessionId}.json` &&
        value.worktreePath === join(this.cacheRoot, value.repoHash, value.sessionId) &&
        hashPath(value.repoPath) === value.repoHash
      if (!valid) throw new Error('sync session metadata validation failed')
      return value
    } catch (err) {
      this.logger?.error('sync session state unreadable', { err, path })
      throw new SyncSessionError('cleanup_pending', '同步会话状态损坏，已停止创建新会话')
    }
  }

  private async writeSession(session: SyncSession): Promise<void> {
    const file = this.sessionFile(session)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(session, null, 2), 'utf8')
    await rename(temporary, file)
  }

  private sessionFile(session: SyncSession): string {
    return join(this.stateRoot, session.repoHash, `${session.sessionId}.json`)
  }

  private ref(session: SyncSession, name: string): string {
    return `refs/loom/sync/${session.sessionId}/${name}`
  }
}

async function mergeRef(repoPath: string, ref: string): Promise<{ clean: boolean }> {
  try {
    const output = await simpleGit(repoPath).raw(['merge', ref, '--no-edit'])
    if ((await unmergedPaths(repoPath)).length > 0) return { clean: false }
    if (output.includes('Already up to date')) {
      const head = await worktreeGitHead(repoPath)
      if (head !== ref) {
        const isAncestor = await simpleGit(repoPath)
          .raw(['merge-base', '--is-ancestor', ref, head])
          .then(
            () => true,
            () => false,
          )
        if (!isAncestor) throw new Error(`git merge unexpectedly made no progress: ${output}`)
      }
    }
    return { clean: true }
  } catch (err) {
    if ((await unmergedPaths(repoPath)).length > 0) return { clean: false }
    throw err
  }
}

async function worktreeGitHead(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).raw(['rev-parse', 'HEAD'])).trim()
}

async function unmergedPaths(repoPath: string): Promise<string[]> {
  const output = await simpleGit(repoPath).raw(['diff', '--name-only', '--diff-filter=U', '-z'])
  return output.split('\0').filter(Boolean)
}

async function readConflicts(
  repoPath: string,
  paths: string[],
  logger?: Logger,
): Promise<GitConflictFile[]> {
  const git = simpleGit(repoPath)
  return Promise.all(
    paths.map(async (path) => {
      const stage = async (number: 1 | 2 | 3) => {
        try {
          return (await git.raw(['show', `:${number}:${path}`])).replace(/\n$/, '')
        } catch (err) {
          logger?.warn('git conflict index stage unavailable', {
            err,
            repoPath,
            path,
            stage: number,
          })
          return null
        }
      }
      const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)])
      let result: string | null = null
      try {
        result = await readFile(join(repoPath, path), 'utf8')
      } catch (err) {
        logger?.warn('git conflict worktree file unavailable', { err, repoPath, path })
        // Delete/modify conflicts may not have a worktree file.
      }
      return {
        path,
        base,
        ours,
        theirs,
        result,
        binary: [base, ours, theirs, result].some((text) => text?.includes('\0') ?? false),
      }
    }),
  )
}

function hashPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 24)
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function listLeafDirectories(root: string): Promise<string[]> {
  let hashes
  try {
    hashes = await readdir(root, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw new SyncSessionError('cleanup_pending', '同步 worktree 缓存目录无法读取')
  }
  const result: string[] = []
  for (const hash of hashes) {
    if (!hash.isDirectory()) continue
    const parent = join(root, hash.name)
    let sessions
    try {
      sessions = await readdir(parent, { withFileTypes: true })
    } catch {
      throw new SyncSessionError('cleanup_pending', '同步 worktree 缓存目录无法读取')
    }
    for (const session of sessions)
      if (session.isDirectory()) result.push(join(parent, session.name))
  }
  return result
}

async function directorySize(root: string): Promise<number> {
  let info
  try {
    info = await stat(root)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0
    throw err
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    total += await directorySize(join(root, entry.name))
  }
  return total
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
