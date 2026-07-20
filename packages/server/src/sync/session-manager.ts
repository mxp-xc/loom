import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import lockfile from 'proper-lockfile'
import { simpleGit } from 'simple-git'
import { ResourceLeaseCoordinator } from '../concurrency/resource-lease-coordinator.js'
import { NodeFileSystem } from '../platform/node/fs.js'
import { readGitHead } from '../platform/node/git-head.js'
import type { IFileSystem } from '../ports/fs.js'

type SessionStatus = 'setup' | 'resolving' | 'applying' | 'projection_pending' | 'deleting'
type SessionOperation = 'merge' | 'force_pull'
type SetupStep = 'initialized' | 'worktree_created' | 'remote_ref_created' | 'completed'

interface CleanupProgress {
  worktreeRemoved: boolean
  directoryRemoved: boolean
  remoteRefDeleted: boolean
  resolvedRefDeleted: boolean
  candidateRefDeleted: boolean
  worktreesPruned: boolean
}

interface SyncSession {
  version: 2
  sessionId: string
  repoPath: string
  repoHash: string
  repoIdentity: string
  revision: number
  worktreePath: string
  startHead: string
  remoteTip: string
  operation: SessionOperation
  setupStep: SetupStep
  cleanupProgress: CleanupProgress
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface SyncSessionResult {
  sessionId?: string
  clean: boolean
  conflicts: GitConflictFile[]
}

export type RepositoryLeaseGuard = (lockedRepoPath: string) => Promise<void>

export interface GitConflictFile {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string | null
  binary: boolean
  modes?: string[]
  unsupportedReason?: 'non-regular-mode' | 'binary-content' | 'invalid-utf8' | 'too-large'
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
      | 'active_session_exists'
      | 'unsupported_conflict_type'
      | 'manager_disposed',
    message: string,
  ) {
    super(message)
  }
}

export interface SyncSessionManagerOptions {
  home: string
  logger?: Logger
  onApplied?: (repoPath: string, home: string) => Promise<void>
  maxWorktrees?: number
  maxTotalBytes?: number
  maxSessionBytes?: number
  maxResultBytes?: number
  cleanupOperations?: Partial<CleanupOperations>
  orphanFs?: Pick<IFileSystem, 'inspectEntry' | 'realPath' | 'removeEntryIfIdentity'>
  leases?: ResourceLeaseCoordinator
  leaseKeys?: (repoPath: string, home: string) => string[] | Promise<string[]>
}

interface CleanupOperations {
  removeWorktree: (repoPath: string, worktreePath: string) => Promise<void>
  removeDirectory: (path: string) => Promise<void>
  deleteRef: (repoPath: string, ref: string) => Promise<void>
  pruneWorktrees: (repoPath: string) => Promise<void>
}

interface StableSyncDirectory {
  path: string
  identity: string
}

interface StableOrphanCandidates {
  parent: StableSyncDirectory
  candidates: StableSyncDirectory[]
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})(?: |$)/m
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPO_HASH_PATTERN = /^[0-9a-f]{24}$/
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SESSION_STATUSES = new Set<SessionStatus>([
  'setup',
  'resolving',
  'applying',
  'projection_pending',
  'deleting',
])
const SESSION_OPERATIONS = new Set<SessionOperation>(['merge', 'force_pull'])
const SETUP_STEPS = new Set<SetupStep>([
  'initialized',
  'worktree_created',
  'remote_ref_created',
  'completed',
])
const execFileAsync = promisify(execFile)
const MAX_CONFLICTS = 1_000
const MAX_UNMERGED_OUTPUT_BYTES = 16 * 1024 * 1024

function emptyCleanupProgress(): CleanupProgress {
  return {
    worktreeRemoved: false,
    directoryRemoved: false,
    remoteRefDeleted: false,
    resolvedRefDeleted: false,
    candidateRefDeleted: false,
    worktreesPruned: false,
  }
}

export class SyncSessionManager {
  private home: string
  private cacheRoot: string
  private stateRoot: string
  private homeInitialization?: Promise<void>
  private readonly logger?: Logger
  private readonly onApplied?: (repoPath: string, home: string) => Promise<void>
  private readonly maxWorktrees: number
  private readonly maxTotalBytes: number
  private readonly maxSessionBytes: number
  private readonly maxResultBytes: number
  private readonly cleanupOperations: CleanupOperations
  private readonly orphanFs: Pick<
    IFileSystem,
    'inspectEntry' | 'realPath' | 'removeEntryIfIdentity'
  >
  private readonly leases: ResourceLeaseCoordinator
  private readonly leaseKeys: (repoPath: string, home: string) => string[] | Promise<string[]>
  private state: 'running' | 'disposing' | 'disposed' = 'running'
  private readonly pendingTasks = new Set<Promise<unknown>>()
  private readonly maintenanceTimers = new Set<ReturnType<typeof setInterval>>()
  private maintenanceCleanup: Promise<void> | null = null
  private disposePromise: Promise<void> | null = null

  constructor(options: SyncSessionManagerOptions) {
    this.home = options.home
    const loomRoot = join(options.home, '.loom')
    this.cacheRoot = join(loomRoot, 'cache', 'sync-worktrees')
    this.stateRoot = join(loomRoot, 'state', 'sync-sessions')
    this.logger = options.logger
    this.onApplied = options.onApplied
    this.orphanFs = options.orphanFs ?? new NodeFileSystem()
    this.leases = options.leases ?? new ResourceLeaseCoordinator()
    this.leaseKeys = options.leaseKeys ?? (() => [])
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

  usesLeaseCoordinator(candidate: ResourceLeaseCoordinator): boolean {
    return this.leases === candidate
  }

  startMaintenance(intervalMs = 10 * 60_000): () => void {
    if (this.state !== 'running') {
      throw new SyncSessionError('manager_disposed', '同步会话管理器已关闭')
    }
    let active = true
    const timer = setInterval(() => {
      if (this.state !== 'running' || this.maintenanceCleanup) return
      const task = this.trackTask(this.retryCleanup())
      this.maintenanceCleanup = task
      void task
        .catch((err) => this.logger?.error('periodic sync cleanup failed', { err }))
        .finally(() => {
          if (this.maintenanceCleanup === task) this.maintenanceCleanup = null
        })
        .catch(() => undefined)
    }, intervalMs)
    this.maintenanceTimers.add(timer)
    timer.unref?.()
    return () => {
      if (!active) return
      active = false
      clearInterval(timer)
      this.maintenanceTimers.delete(timer)
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.state = 'disposing'
    for (const timer of this.maintenanceTimers) clearInterval(timer)
    this.maintenanceTimers.clear()
    this.disposePromise = this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks])
    }
    this.state = 'disposed'
  }

  private runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'running') {
      return Promise.reject(new SyncSessionError('manager_disposed', '同步会话管理器已关闭'))
    }
    return this.trackTask(operation())
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    this.pendingTasks.add(task)
    void task.finally(() => this.pendingTasks.delete(task)).catch(() => undefined)
    return task
  }

  pull(repoPath: string, guard?: RepositoryLeaseGuard): Promise<SyncSessionResult> {
    return this.runOperation(() => this.pullInternal(repoPath, guard))
  }

  private async pullInternal(
    repoPath: string,
    guard?: RepositoryLeaseGuard,
  ): Promise<SyncSessionResult> {
    const canonical = guard ? repoPath : await realpath(repoPath)
    return this.withRepoLock(
      canonical,
      async () => {
        await this.retryCleanupForRepo(canonical)
        const active = await this.loadForRepo(canonical)
        if (active) {
          if (active.status === 'setup' || active.status === 'deleting') {
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
        await ensurePhysicalChildDirectory(this.cacheRoot, repoHash)
        await ensurePhysicalChildDirectory(this.stateRoot, repoHash)
        const now = new Date().toISOString()
        const session: SyncSession = {
          version: 2,
          sessionId,
          repoPath: canonical,
          repoHash,
          repoIdentity: await directoryIdentity(canonical),
          revision: 0,
          worktreePath,
          startHead,
          remoteTip,
          operation: 'merge',
          setupStep: 'initialized',
          cleanupProgress: emptyCleanupProgress(),
          status: 'setup',
          createdAt: now,
          updatedAt: now,
        }
        await this.writeSession(session)
        await git.raw(['worktree', 'add', '--detach', worktreePath, startHead])
        await this.advanceSetup(session, 'worktree_created')
        await git.raw(['update-ref', this.ref(session, 'remote'), remoteTip])
        await this.advanceSetup(session, 'remote_ref_created')

        const merge = await mergeRef(worktreePath, remoteTip)
        session.setupStep = 'completed'
        session.status = 'resolving'
        session.updatedAt = new Date().toISOString()
        await this.writeSession(session)
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
      },
      guard,
    )
  }

  forcePull(repoPath: string, guard?: RepositoryLeaseGuard): Promise<SyncSessionResult> {
    return this.runOperation(() => this.forcePullInternal(repoPath, guard))
  }

  private async forcePullInternal(
    repoPath: string,
    guard?: RepositoryLeaseGuard,
  ): Promise<SyncSessionResult> {
    const canonical = guard ? repoPath : await realpath(repoPath)
    return this.withRepoLock(
      canonical,
      async () => {
        this.logger?.info?.('force pull started', { repoPath: canonical })
        await this.retryCleanupForRepo(canonical)
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
        let head
        try {
          head = await readGitHead(git)
        } catch (err) {
          this.logger?.error('force pull HEAD read failed', { err, repoPath: canonical })
          throw err
        }
        const startHead = head.kind === 'commit' ? head.oid : remoteTip
        const now = new Date().toISOString()
        const repoHash = hashPath(canonical)
        const sessionId = randomUUID()
        const session: SyncSession = {
          version: 2,
          sessionId,
          repoPath: canonical,
          repoHash,
          repoIdentity: await directoryIdentity(canonical),
          revision: 0,
          worktreePath: join(this.cacheRoot, repoHash, sessionId),
          startHead,
          remoteTip,
          operation: 'force_pull',
          setupStep: 'initialized',
          cleanupProgress: emptyCleanupProgress(),
          status: 'setup',
          createdAt: now,
          updatedAt: now,
        }
        await this.writeSession(session)
        session.setupStep = 'completed'
        session.status = 'applying'
        session.updatedAt = new Date().toISOString()
        await this.writeSession(session)
        await this.applyForcePull(session)
        session.status = 'projection_pending'
        session.updatedAt = new Date().toISOString()
        await this.writeSession(session)
        await this.completeProjection(session)
        this.logger?.info?.('force pull completed', { repoPath: canonical, remoteTip })
        return { clean: true, conflicts: [] }
      },
      guard,
    )
  }

  getSession(repoPath: string): Promise<SyncSessionResult | null> {
    return this.runOperation(() => this.getSessionInternal(repoPath))
  }

  private async getSessionInternal(repoPath: string): Promise<SyncSessionResult | null> {
    const canonical = await realpath(repoPath)
    const session = await this.loadForRepo(canonical)
    if (!session || session.status === 'deleting') return null
    return this.resultFor(session)
  }

  saveConflict(
    sessionId: string,
    path: string,
    result: string,
  ): Promise<{ clean: boolean; remaining: GitConflictFile[]; sessionId?: string }> {
    return this.runOperation(() => this.saveConflictInternal(sessionId, path, result))
  }

  private async saveConflictInternal(
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
      const current = await this.loadById(sessionId)
      if (!current || current.repoPath !== session.repoPath || current.status !== 'resolving') {
        throw new SyncSessionError('session_not_found', '同步会话不存在或已结束')
      }
      const conflict = await this.assertConflictPath(current, path)
      await writeConflictResult(current.worktreePath, conflict, result)
      const worktreeGit = simpleGit(current.worktreePath)
      await worktreeGit.add([path])
      await this.assertSessionSize(current)
      const remaining = await unmergedEntries(current.worktreePath)
      if (remaining.length > 0) {
        current.updatedAt = new Date().toISOString()
        await this.writeSession(current)
        return {
          clean: false,
          remaining: await readConflicts(
            current.worktreePath,
            remaining,
            this.maxResultBytes,
            this.maxSessionBytes,
            this.logger,
          ),
          sessionId,
        }
      }

      await worktreeGit.commit('merge: resolve conflicts')
      const finalized = await this.finalize(current)
      return {
        clean: finalized.clean,
        remaining: finalized.conflicts,
        sessionId: finalized.sessionId,
      }
    })
  }

  abort(sessionId: string): Promise<void> {
    return this.runOperation(() => this.abortInternal(sessionId))
  }

  private async abortInternal(sessionId: string): Promise<void> {
    const session = await this.loadById(sessionId)
    if (!session) throw new SyncSessionError('session_not_found', '同步会话不存在或已结束')
    if (session.status === 'projection_pending') {
      throw new SyncSessionError('cleanup_pending', '同步结果等待投影，不能放弃会话')
    }
    await this.withRepoLock(session.repoPath, async () => {
      const current = await this.loadById(sessionId)
      if (!current || current.repoPath !== session.repoPath) {
        throw new SyncSessionError('session_not_found', '同步会话不存在或已结束')
      }
      if (current.status === 'projection_pending') {
        throw new SyncSessionError('cleanup_pending', '同步结果等待投影，不能放弃会话')
      }
      await this.cleanup(current)
    })
  }

  recover(): Promise<void> {
    return this.runOperation(() => this.recoverInternal())
  }

  private async recoverInternal(): Promise<void> {
    await this.ensureManagedRoots()
    await this.retryCleanup()
    for (const session of await this.loadAll()) {
      if (
        session.status !== 'setup' &&
        session.status !== 'applying' &&
        session.status !== 'projection_pending'
      )
        continue
      try {
        await this.withRepoLock(session.repoPath, async () => {
          const current = await this.loadForRepo(session.repoPath)
          if (!current || current.sessionId !== session.sessionId) return
          if (current.status === 'setup') await this.cleanup(current)
          else if (current.status === 'projection_pending') await this.completeProjection(current)
          else if (current.status === 'applying') {
            if (current.operation === 'force_pull') {
              await this.applyForcePull(current)
              current.status = 'projection_pending'
              current.updatedAt = new Date().toISOString()
              await this.writeSession(current)
              await this.completeProjection(current)
            } else {
              await this.finalize(current)
            }
          }
        })
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
    await ensurePhysicalChildDirectory(this.cacheRoot, repoHash)
    await ensurePhysicalChildDirectory(this.stateRoot, repoHash)
    const now = new Date().toISOString()
    const session: SyncSession = {
      version: 2,
      sessionId,
      repoPath,
      repoHash,
      repoIdentity: await directoryIdentity(repoPath),
      revision: 0,
      worktreePath,
      startHead,
      remoteTip,
      operation: 'merge',
      setupStep: 'initialized',
      cleanupProgress: emptyCleanupProgress(),
      status: 'setup',
      createdAt: now,
      updatedAt: now,
    }
    await this.writeSession(session)
    await git.raw(['worktree', 'add', '--detach', worktreePath, startHead])
    await this.advanceSetup(session, 'worktree_created')
    await git.raw(['update-ref', this.ref(session, 'remote'), remoteTip])
    await this.advanceSetup(session, 'remote_ref_created')
    await mergeRef(worktreePath, remoteTip)
    session.setupStep = 'completed'
    session.status = 'resolving'
    session.updatedAt = new Date().toISOString()
    await this.writeSession(session)
  }

  private async advanceSetup(session: SyncSession, setupStep: SetupStep): Promise<void> {
    session.setupStep = setupStep
    session.updatedAt = new Date().toISOString()
    await this.writeSession(session)
  }

  private async applyForcePull(session: SyncSession): Promise<void> {
    const git = simpleGit(session.repoPath)
    const head = await readGitHead(git)
    if (head.kind === 'unborn') await git.raw(['update-ref', 'HEAD', session.remoteTip])
    await git.raw(['reset', '--hard', session.remoteTip])
    await git.raw(['clean', '-fd'])
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
    session.status = 'projection_pending'
    session.updatedAt = new Date().toISOString()
    await this.writeSession(session)
    return this.completeProjection(session)
  }

  private async completeProjection(session: SyncSession): Promise<SyncSessionResult> {
    await this.onApplied?.(session.repoPath, this.home)
    await this.cleanup(session)
    return { clean: true, conflicts: [] }
  }

  private async resultFor(session: SyncSession): Promise<SyncSessionResult> {
    if (session.status === 'setup' || session.status === 'projection_pending') {
      return {
        sessionId: session.sessionId,
        clean: false,
        conflicts: [],
      }
    }
    const entries = await unmergedEntries(session.worktreePath)
    return {
      sessionId: session.sessionId,
      clean: entries.length === 0 && session.status === 'deleting',
      conflicts: await readConflicts(
        session.worktreePath,
        entries,
        this.maxResultBytes,
        this.maxSessionBytes,
        this.logger,
      ),
    }
  }

  private async assertConflictPath(session: SyncSession, path: string): Promise<UnmergedEntry> {
    const entry = (await unmergedEntries(session.worktreePath)).find((item) => item.path === path)
    if (!entry) throw new Error(`不是当前冲突文件: ${path}`)
    gitWorktreePath(session.worktreePath, path)
    if (!isRegularConflict(entry)) {
      throw new SyncSessionError('unsupported_conflict_type', '该冲突文件类型不支持文本编辑')
    }
    const stages = await readConflictStages(
      session.worktreePath,
      entry,
      this.maxResultBytes,
      { remaining: this.maxResultBytes * 4 },
      this.logger,
    )
    if ('unsupportedReason' in stages) {
      throw new SyncSessionError('unsupported_conflict_type', '该冲突内容不支持文本编辑')
    }
    if (stages.contents.some((content) => content?.includes('\0') ?? false)) {
      throw new SyncSessionError('unsupported_conflict_type', '二进制冲突不支持文本编辑')
    }
    return entry
  }

  private async cleanup(session: SyncSession, repositoryAvailable = true): Promise<void> {
    if (session.status !== 'deleting') {
      session.status = 'deleting'
      session.updatedAt = new Date().toISOString()
      await this.writeSession(session)
    }
    const errors: unknown[] = []
    if (!session.cleanupProgress.worktreeRemoved && repositoryAvailable) {
      try {
        await this.cleanupOperations.removeWorktree(session.repoPath, session.worktreePath)
      } catch (err) {
        if (await pathExists(session.worktreePath)) {
          errors.push(err)
          this.logger?.error('git worktree removal failed', { err, sessionId: session.sessionId })
        }
      }
    }
    if (
      !session.cleanupProgress.worktreeRemoved &&
      (!repositoryAvailable || !(await pathExists(session.worktreePath)))
    ) {
      await this.markCleanupStep(session, 'worktreeRemoved')
    }
    if (!session.cleanupProgress.directoryRemoved) {
      try {
        await this.cleanupOperations.removeDirectory(session.worktreePath)
        await this.markCleanupStep(session, 'directoryRemoved')
      } catch (err) {
        errors.push(err)
        this.logger?.error('sync worktree directory removal failed', {
          err,
          sessionId: session.sessionId,
        })
      }
    }
    if (!repositoryAvailable) {
      const availability = await this.repositoryAvailability(session)
      repositoryAvailable = availability === 'available'
      if (availability === 'replaced') {
        const err = new Error('sync repository identity changed during cleanup')
        this.logger?.error('sync session repository identity mismatch', {
          err,
          repoPath: session.repoPath,
          sessionId: session.sessionId,
        })
      }
    }
    const refs = [
      ['remote', 'remoteRefDeleted'],
      ['resolved', 'resolvedRefDeleted'],
      ['candidate', 'candidateRefDeleted'],
    ] as const
    for (const [name, step] of refs) {
      if (session.cleanupProgress[step]) continue
      if (repositoryAvailable) {
        try {
          await this.cleanupOperations.deleteRef(session.repoPath, this.ref(session, name))
          await this.markCleanupStep(session, step)
        } catch (err) {
          errors.push(err)
          this.logger?.error('sync session ref removal failed', {
            err,
            sessionId: session.sessionId,
            ref: name,
          })
        }
      } else {
        await this.markCleanupStep(session, step)
      }
    }
    if (!session.cleanupProgress.worktreesPruned) {
      if (repositoryAvailable) {
        try {
          await this.cleanupOperations.pruneWorktrees(session.repoPath)
          await this.markCleanupStep(session, 'worktreesPruned')
        } catch (err) {
          errors.push(err)
          this.logger?.error('git worktree prune failed', { err, sessionId: session.sessionId })
        }
      } else {
        await this.markCleanupStep(session, 'worktreesPruned')
      }
    }
    if (errors.length > 0)
      throw new SyncSessionError('cleanup_pending', '同步结果已处理，但临时文件清理失败')
    await rm(this.sessionFile(session), { force: true })
  }

  private async markCleanupStep(session: SyncSession, step: keyof CleanupProgress): Promise<void> {
    session.cleanupProgress[step] = true
    session.updatedAt = new Date().toISOString()
    await this.writeSession(session)
  }

  private async retryCleanup(): Promise<void> {
    const snapshots = await this.loadAll()
    for (const snapshot of snapshots) {
      try {
        await this.withRepoLease(snapshot.repoPath, async () => {
          await this.withProcessLock(snapshot.repoPath, async () => {
            await this.retrySessionCleanup(snapshot)
          })
        })
      } catch (err) {
        this.logger?.error('sync session cleanup retry failed', {
          err,
          sessionId: snapshot.sessionId,
        })
      }
    }
    await this.retryOrphanedWorktrees()
  }

  private async retryCleanupForRepo(repoPath: string): Promise<void> {
    const snapshots = (await this.loadAll()).filter((session) => session.repoPath === repoPath)
    for (const snapshot of snapshots) {
      try {
        await this.retrySessionCleanup(snapshot)
      } catch (err) {
        this.logger?.error('sync session cleanup retry failed', {
          err,
          sessionId: snapshot.sessionId,
        })
      }
    }
    await this.retryOrphanedWorktreesForRepo(repoPath)
  }

  private async retrySessionCleanup(snapshot: SyncSession): Promise<void> {
    const current = (await this.loadAll()).find(
      (session) => session.sessionId === snapshot.sessionId,
    )
    if (!current) return
    const repository = await this.repositoryAvailability(current)
    if (repository === 'missing') {
      await this.cleanup(current, false)
      return
    }
    if (repository === 'replaced') {
      const err = new Error('sync repository identity changed')
      this.logger?.error('sync session repository identity mismatch', {
        err,
        repoPath: current.repoPath,
        sessionId: current.sessionId,
      })
      return
    }
    if (current.status === 'deleting') await this.cleanup(current)
  }

  private async retryOrphanedWorktrees(): Promise<void> {
    const cacheRoot = await requireStableSyncDirectory(this.orphanFs, this.cacheRoot)
    const hashEntries = await readdir(cacheRoot.path, { withFileTypes: true })
    await assertStableSyncDirectory(this.orphanFs, cacheRoot)
    for (const entry of hashEntries) {
      if (!REPO_HASH_PATTERN.test(entry.name)) continue
      const repoHash = entry.name
      await this.leases.runMutation([this.sessionNamespaceKey(repoHash)], async () => {
        await this.removeOrphanedWorktrees(cacheRoot, repoHash)
      })
    }
  }

  private async retryOrphanedWorktreesForRepo(repoPath: string): Promise<void> {
    const cacheRoot = await requireStableSyncDirectory(this.orphanFs, this.cacheRoot)
    const repoHash = hashPath(repoPath)
    const hashEntries = await readdir(cacheRoot.path, { withFileTypes: true })
    await assertStableSyncDirectory(this.orphanFs, cacheRoot)
    if (!hashEntries.some((entry) => entry.name === repoHash)) return
    await this.removeOrphanedWorktrees(cacheRoot, repoHash)
  }

  private async removeOrphanedWorktrees(
    cacheRoot: StableSyncDirectory,
    repoHash: string,
  ): Promise<void> {
    const { parent, candidates } = await listStableOrphanCandidates(
      this.orphanFs,
      cacheRoot,
      repoHash,
    )
    const known = new Set(
      (await this.loadAll())
        .filter((session) => session.repoHash === repoHash)
        .map((session) => session.worktreePath),
    )
    for (const candidate of candidates) {
      if (known.has(candidate.path)) continue
      try {
        await assertStableSyncDirectory(this.orphanFs, cacheRoot)
        await assertStableSyncDirectory(this.orphanFs, parent)
        await assertStableSyncDirectory(this.orphanFs, candidate)
        await this.orphanFs.removeEntryIfIdentity(candidate.path, candidate.identity)
        this.logger?.info?.('orphaned sync worktree directory removed', {
          path: candidate.path,
        })
      } catch (err) {
        this.logger?.error('orphaned sync worktree directory removal failed', {
          err,
          path: candidate.path,
        })
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

  private async withRepoLock<T>(
    repoPath: string,
    operation: () => Promise<T>,
    guard?: RepositoryLeaseGuard,
  ): Promise<T> {
    return this.withRepoLease(repoPath, async () => {
      await guard?.(repoPath)
      return this.withProcessLock(repoPath, operation)
    })
  }

  private async withRepoLease<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
    await this.ensureCanonicalHome()
    return this.leases.runMutation(
      [
        repoPath,
        ...(await this.leaseKeys(repoPath, this.home)),
        this.sessionNamespaceKey(hashPath(repoPath)),
      ],
      operation,
    )
  }

  private async withProcessLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(repoPath, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 250 },
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

  private sessionNamespaceKey(repoHash: string): string {
    return `loom:sync-session:${repoHash}`
  }

  private async loadForRepo(repoPath: string): Promise<SyncSession | null> {
    await this.ensureManagedRoots()
    const file = join(this.stateRoot, hashPath(repoPath))
    let names: string[]
    try {
      names = await readdir(file)
    } catch (err) {
      if (isMissing(err)) return null
      this.logger?.error('sync repository session directory unreadable', { err, path: file })
      throw new SyncSessionError('cleanup_pending', '同步会话状态目录无法读取')
    }
    await assertPhysicalDirectory(file)
    const sessions: SyncSession[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const path = join(file, name)
      const session = await this.readSessionDocument(path)
      if (session) {
        await this.assertSessionRepositoryIdentity(session, path)
        sessions.push(session)
      }
    }
    if (sessions.length > 1) {
      throw new SyncSessionError('cleanup_pending', '检测到重复的同步会话，已停止继续操作')
    }
    return sessions[0] ?? null
  }

  private async loadById(sessionId: string): Promise<SyncSession | null> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null
    const session = (await this.loadAll()).find((candidate) => candidate.sessionId === sessionId)
    if (!session) return null
    await this.assertSessionRepositoryIdentity(session, this.sessionFile(session))
    return session
  }

  private async loadAll(): Promise<SyncSession[]> {
    await this.ensureManagedRoots()
    const sessions: SyncSession[] = []
    let hashes
    try {
      hashes = await readdir(this.stateRoot, { withFileTypes: true })
    } catch (err) {
      this.logger?.error('sync session state root unreadable', { err, path: this.stateRoot })
      throw new SyncSessionError('cleanup_pending', '同步会话状态目录无法读取')
    }
    for (const entry of hashes) {
      const hash = entry.name
      if (!/^[0-9a-f]{24}$/.test(hash) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new SyncSessionError('cleanup_pending', '同步会话状态目录包含无效条目')
      }
      await assertPhysicalDirectory(join(this.stateRoot, hash))
      let names: string[] = []
      try {
        names = await readdir(join(this.stateRoot, hash))
      } catch (err) {
        this.logger?.error('sync session state directory unreadable', { err, hash })
        throw new SyncSessionError('cleanup_pending', '同步会话状态目录无法读取')
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const session = await this.readSessionDocument(join(this.stateRoot, hash, name))
        if (session) sessions.push(session)
      }
    }
    const sessionIds = new Set<string>()
    const repoHashes = new Set<string>()
    for (const session of sessions) {
      if (sessionIds.has(session.sessionId) || repoHashes.has(session.repoHash)) {
        throw new SyncSessionError('cleanup_pending', '检测到重复的同步会话，已停止继续操作')
      }
      sessionIds.add(session.sessionId)
      repoHashes.add(session.repoHash)
    }
    return sessions
  }

  private async readSessionDocument(path: string): Promise<SyncSession | null> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new Error('sync session state entry is not an independent regular file')
      }
      const value = JSON.parse(await readFile(path, 'utf8')) as SyncSession
      const valid =
        value.version === 2 &&
        UUID_PATTERN.test(value.sessionId) &&
        /^[0-9a-f]{24}$/.test(value.repoHash) &&
        basename(path) === `${value.sessionId}.json` &&
        basename(dirname(path)) === value.repoHash &&
        value.worktreePath === join(this.cacheRoot, value.repoHash, value.sessionId) &&
        isAbsolute(value.repoPath) &&
        hashPath(value.repoPath) === value.repoHash &&
        /^\d+:\d+$/.test(value.repoIdentity) &&
        Number.isSafeInteger(value.revision) &&
        value.revision > 0 &&
        SESSION_STATUSES.has(value.status) &&
        SESSION_OPERATIONS.has(value.operation) &&
        SETUP_STEPS.has(value.setupStep) &&
        validCleanupProgress(value.cleanupProgress) &&
        validSessionPhase(value) &&
        COMMIT_PATTERN.test(value.startHead) &&
        COMMIT_PATTERN.test(value.remoteTip) &&
        validTimestamp(value.createdAt) &&
        validTimestamp(value.updatedAt) &&
        Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
      if (!valid) throw new Error('sync session metadata validation failed')
      return value
    } catch (err) {
      this.logger?.error('sync session state unreadable', { err, path })
      throw new SyncSessionError('cleanup_pending', '同步会话状态损坏，已停止创建新会话')
    }
  }

  private async assertSessionRepositoryIdentity(session: SyncSession, path: string): Promise<void> {
    try {
      if ((await directoryIdentity(session.repoPath)) !== session.repoIdentity) {
        throw new Error('sync repository identity changed')
      }
    } catch (err) {
      this.logger?.error('sync session state unreadable', { err, path })
      throw new SyncSessionError('cleanup_pending', '同步会话状态损坏，已停止创建新会话')
    }
  }

  private async repositoryAvailability(
    session: SyncSession,
  ): Promise<'available' | 'missing' | 'replaced'> {
    try {
      return (await directoryIdentity(session.repoPath)) === session.repoIdentity
        ? 'available'
        : 'replaced'
    } catch (err) {
      if (isMissing(err)) return 'missing'
      throw err
    }
  }

  private async writeSession(session: SyncSession): Promise<void> {
    await this.ensureManagedRoots()
    const file = this.sessionFile(session)
    await ensurePhysicalChildDirectory(this.stateRoot, session.repoHash)
    const existingInfo = await lstat(file).catch((err) => {
      if (isMissing(err)) return null
      throw err
    })
    if (existingInfo) {
      const current = await this.readSessionDocument(file)
      if (!current || current.revision !== session.revision) {
        throw new SyncSessionError('cleanup_pending', '同步会话已被其他进程更新')
      }
    } else if (session.revision !== 0) {
      throw new SyncSessionError('cleanup_pending', '同步会话状态意外缺失')
    }
    const nextRevision = session.revision + 1
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ ...session, revision: nextRevision }, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
      })
      const confirmedInfo = await lstat(file).catch((err) => {
        if (isMissing(err)) return null
        throw err
      })
      if (!sameFileIdentity(existingInfo, confirmedInfo)) {
        throw new SyncSessionError('cleanup_pending', '同步会话状态在写入期间发生变化')
      }
      await rename(temporary, file)
      session.revision = nextRevision
    } catch (err) {
      await rm(temporary, { force: true }).catch((cleanupError) => {
        throw new AggregateError([err, cleanupError], 'sync session write and cleanup failed', {
          cause: err,
        })
      })
      throw err
    }
  }

  private sessionFile(session: SyncSession): string {
    return join(this.stateRoot, session.repoHash, `${session.sessionId}.json`)
  }

  private ref(session: SyncSession, name: string): string {
    return `refs/loom/sync/${session.sessionId}/${name}`
  }

  private async ensureManagedRoots(): Promise<void> {
    await this.ensureCanonicalHome()
    await ensurePhysicalDirectoryChain(this.home, ['.loom', 'cache', 'sync-worktrees'])
    await ensurePhysicalDirectoryChain(this.home, ['.loom', 'state', 'sync-sessions'])
  }

  private async ensureCanonicalHome(): Promise<void> {
    this.homeInitialization ??= (async () => {
      await mkdir(this.home, { recursive: true })
      this.home = await realpath(this.home)
      const loomRoot = join(this.home, '.loom')
      this.cacheRoot = join(loomRoot, 'cache', 'sync-worktrees')
      this.stateRoot = join(loomRoot, 'state', 'sync-sessions')
    })()
    await this.homeInitialization
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
  return (await unmergedEntries(repoPath)).map((entry) => entry.path)
}

interface UnmergedStage {
  mode: string
  oid: string
  stage: 1 | 2 | 3
}

interface UnmergedEntry {
  path: string
  stages: Partial<Record<1 | 2 | 3, UnmergedStage>>
}

async function unmergedEntries(repoPath: string): Promise<UnmergedEntry[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '--unmerged', '-z'], {
    cwd: repoPath,
    encoding: 'buffer',
    maxBuffer: MAX_UNMERGED_OUTPUT_BYTES,
  })
  const output = decodeUtf8(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
  if (output === null) throw new Error('Invalid UTF-8 in unmerged index metadata')
  const entries = new Map<string, UnmergedEntry>()
  for (const record of output.split('\0')) {
    if (!record) continue
    const separator = record.indexOf('\t')
    if (separator < 0) throw new Error('Invalid unmerged index record')
    const [mode, oid, rawStage] = record.slice(0, separator).split(' ')
    const stage = Number(rawStage)
    if (!mode || !oid || (stage !== 1 && stage !== 2 && stage !== 3)) {
      throw new Error('Invalid unmerged index metadata')
    }
    const path = record.slice(separator + 1)
    const entry = entries.get(path) ?? { path, stages: {} }
    entry.stages[stage] = { mode, oid, stage }
    entries.set(path, entry)
    if (entries.size > MAX_CONFLICTS) {
      throw new SyncSessionError('storage_quota_exceeded', '同步冲突文件数量超过限制')
    }
  }
  return [...entries.values()]
}

async function readConflicts(
  repoPath: string,
  entries: UnmergedEntry[],
  maxFileBytes: number,
  maxTotalBytes: number,
  logger?: Logger,
): Promise<GitConflictFile[]> {
  const conflicts: GitConflictFile[] = []
  const budget = { remaining: maxTotalBytes }
  for (const entry of entries) {
    const modes = Object.values(entry.stages).map((stage) => stage.mode)
    if (!isRegularConflict(entry)) {
      conflicts.push(unsupportedConflict(entry, modes, 'non-regular-mode'))
      continue
    }
    const stages = await readConflictStages(repoPath, entry, maxFileBytes, budget, logger)
    if ('unsupportedReason' in stages) {
      conflicts.push(unsupportedConflict(entry, modes, stages.unsupportedReason))
      continue
    }
    const [base, ours, theirs] = stages.contents
    let result: string | null = null
    try {
      const path = gitWorktreePath(repoPath, entry.path)
      const info = await lstat(path)
      if (!info.isFile() || info.nlink !== 1) {
        throw new SyncSessionError('unsupported_conflict_type', '冲突结果不是独立的普通文件')
      }
      if (info.size > maxFileBytes) {
        conflicts.push(unsupportedConflict(entry, modes, 'too-large'))
        continue
      }
      if (info.size > budget.remaining) {
        conflicts.push(unsupportedConflict(entry, modes, 'too-large'))
        continue
      }
      budget.remaining -= info.size
      result = decodeUtf8(await readFile(path))
      if (result === null) {
        conflicts.push(unsupportedConflict(entry, modes, 'invalid-utf8'))
        continue
      }
    } catch (err) {
      if (!isMissing(err)) {
        logger?.error('git conflict worktree file unavailable', {
          err,
          repoPath,
          path: entry.path,
        })
        throw err
      }
    }
    const binary = [base, ours, theirs, result].some((text) => text?.includes('\0') ?? false)
    conflicts.push({
      path: entry.path,
      base,
      ours,
      theirs,
      result,
      binary,
      modes,
      ...(binary ? { unsupportedReason: 'binary-content' as const } : {}),
    })
  }
  return conflicts
}

async function readConflictStages(
  repoPath: string,
  entry: UnmergedEntry,
  maxFileBytes: number,
  budget: { remaining: number },
  logger?: Logger,
): Promise<
  | { contents: [string | null, string | null, string | null] }
  | { unsupportedReason: 'invalid-utf8' | 'too-large' }
> {
  const contents: [string | null, string | null, string | null] = [null, null, null]
  for (const stage of [1, 2, 3] as const) {
    const metadata = entry.stages[stage]
    if (!metadata) continue
    try {
      const sizeText = await simpleGit(repoPath).raw(['cat-file', '-s', metadata.oid])
      const size = Number(sizeText.trim())
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid git blob size')
      if (size > maxFileBytes) return { unsupportedReason: 'too-large' }
      if (size > budget.remaining) return { unsupportedReason: 'too-large' }
      budget.remaining -= size
      const { stdout } = await execFileAsync('git', ['cat-file', 'blob', metadata.oid], {
        cwd: repoPath,
        encoding: 'buffer',
        maxBuffer: maxFileBytes + 1,
      })
      const decoded = decodeUtf8(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      if (decoded === null) return { unsupportedReason: 'invalid-utf8' }
      contents[stage - 1] = decoded
    } catch (err) {
      logger?.error('git conflict index stage read failed', {
        err,
        repoPath,
        path: entry.path,
        stage,
      })
      throw err
    }
  }
  return { contents }
}

function unsupportedConflict(
  entry: UnmergedEntry,
  modes: string[],
  unsupportedReason: NonNullable<GitConflictFile['unsupportedReason']>,
): GitConflictFile {
  return {
    path: entry.path,
    base: null,
    ours: null,
    theirs: null,
    result: null,
    binary: true,
    modes,
    unsupportedReason,
  }
}

function decodeUtf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return null
  }
}

function isRegularConflict(entry: UnmergedEntry): boolean {
  const stages = Object.values(entry.stages)
  return (
    stages.length > 0 && stages.every((stage) => stage.mode === '100644' || stage.mode === '100755')
  )
}

async function writeConflictResult(
  worktreePath: string,
  entry: UnmergedEntry,
  result: string,
): Promise<void> {
  const target = gitWorktreePath(worktreePath, entry.path)
  const parent = dirname(target)
  const root = await realpath(worktreePath)
  const parentRealPath = await realpath(parent)
  const parentRelative = relative(root, parentRealPath)
  if (
    parentRelative === '..' ||
    parentRelative.startsWith(`..${sep}`) ||
    isAbsolute(parentRelative)
  ) {
    throw new SyncSessionError('unsupported_conflict_type', '冲突文件父目录越出worktree')
  }
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new SyncSessionError('unsupported_conflict_type', '冲突文件父目录不是普通目录')
  }
  const targetInfo = await lstat(target).catch((err) => {
    if (isMissing(err)) return null
    throw err
  })
  if (
    targetInfo &&
    (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink !== 1)
  ) {
    throw new SyncSessionError('unsupported_conflict_type', '冲突结果不是独立的普通文件')
  }
  const preferredMode = entry.stages[2]?.mode ?? entry.stages[3]?.mode ?? entry.stages[1]?.mode
  const mode = preferredMode === '100755' ? 0o755 : 0o644
  const temporary = join(parent, `.${basename(target)}.loom-sync-${randomUUID()}`)
  try {
    await writeFile(temporary, result, { encoding: 'utf8', flag: 'wx', mode })
    const confirmedParent = await lstat(parent)
    const confirmedTarget = await lstat(target).catch((err) => {
      if (isMissing(err)) return null
      throw err
    })
    if (
      confirmedParent.dev !== parentInfo.dev ||
      confirmedParent.ino !== parentInfo.ino ||
      !sameFileIdentity(targetInfo, confirmedTarget)
    ) {
      throw new SyncSessionError('unsupported_conflict_type', '冲突文件在保存前已被替换')
    }
    await rename(temporary, target)
  } catch (err) {
    await rm(temporary, { force: true }).catch((cleanupError) => {
      throw new AggregateError([err, cleanupError], 'sync conflict save and cleanup failed', {
        cause: err,
      })
    })
    throw err
  }
}

function gitWorktreePath(worktreePath: string, path: string): string {
  const segments = path.split('/')
  if (
    path.length === 0 ||
    path.includes('\\') ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new SyncSessionError('unsupported_conflict_type', '无效的冲突文件路径')
  }
  return join(worktreePath, ...segments)
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>> | null,
  right: Awaited<ReturnType<typeof lstat>> | null,
): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.dev === right.dev && left.ino === right.ino)
  )
}

async function ensurePhysicalDirectoryChain(root: string, segments: string[]): Promise<void> {
  await mkdir(root, { recursive: true })
  await assertPhysicalDirectory(root)
  let parent = root
  for (const segment of segments) {
    parent = await ensurePhysicalChildDirectory(parent, segment)
  }
}

async function ensurePhysicalChildDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  try {
    await mkdir(path)
  } catch (err) {
    if (!isAlreadyExists(err)) throw err
  }
  await assertPhysicalDirectory(path)
  const [parentCanonical, canonical] = await Promise.all([realpath(parent), realpath(path)])
  if (dirname(canonical) !== parentCanonical || canonical !== path) {
    throw new SyncSessionError('cleanup_pending', '同步托管目录不是物理直接子目录')
  }
  return path
}

async function assertPhysicalDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SyncSessionError('cleanup_pending', '同步托管路径不是物理目录')
  }
  if ((await realpath(path)) !== path) {
    throw new SyncSessionError('cleanup_pending', '同步托管目录越出可信路径')
  }
}

async function requireStableSyncDirectory(
  fs: Pick<IFileSystem, 'inspectEntry' | 'realPath'>,
  path: string,
): Promise<StableSyncDirectory> {
  const before = await fs.inspectEntry(path)
  if (before?.kind !== 'directory') {
    throw new SyncSessionError('cleanup_pending', '同步 worktree 托管路径不是物理目录')
  }
  const canonical = await fs.realPath(path)
  const after = await fs.inspectEntry(path)
  if (canonical !== path || after?.kind !== 'directory' || after.identity !== before.identity) {
    throw new SyncSessionError('cleanup_pending', '同步 worktree 托管目录身份发生变化')
  }
  return { path, identity: before.identity }
}

async function assertStableSyncDirectory(
  fs: Pick<IFileSystem, 'inspectEntry' | 'realPath'>,
  expected: StableSyncDirectory,
): Promise<void> {
  const current = await requireStableSyncDirectory(fs, expected.path)
  if (current.identity !== expected.identity) {
    throw new SyncSessionError('cleanup_pending', '同步 worktree 托管目录身份发生变化')
  }
}

async function listStableOrphanCandidates(
  fs: Pick<IFileSystem, 'inspectEntry' | 'realPath'>,
  cacheRoot: StableSyncDirectory,
  repoHash: string,
): Promise<StableOrphanCandidates> {
  if (!REPO_HASH_PATTERN.test(repoHash)) {
    throw new SyncSessionError('cleanup_pending', '同步 worktree repository hash 无效')
  }
  await assertStableSyncDirectory(fs, cacheRoot)
  const parent = await requireStableSyncDirectory(fs, join(cacheRoot.path, repoHash))
  if (dirname(parent.path) !== cacheRoot.path) {
    throw new SyncSessionError('cleanup_pending', '同步 worktree hash 目录越出托管路径')
  }
  const entries = await readdir(parent.path, { withFileTypes: true })
  const candidates: StableSyncDirectory[] = []
  for (const entry of entries) {
    if (!UUID_PATTERN.test(entry.name)) continue
    const candidate = await requireStableSyncDirectory(fs, join(parent.path, entry.name))
    if (dirname(candidate.path) !== parent.path) {
      throw new SyncSessionError('cleanup_pending', '同步 worktree session 目录越出托管路径')
    }
    candidates.push(candidate)
  }
  await assertStableSyncDirectory(fs, cacheRoot)
  await assertStableSyncDirectory(fs, parent)
  return { parent, candidates }
}

async function directoryIdentity(path: string): Promise<string> {
  const [canonical, info] = await Promise.all([realpath(path), lstat(path)])
  if (canonical !== path || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('sync repository identity is not a canonical physical directory')
  }
  return `${info.dev}:${info.ino}`
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
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

const MAX_QUOTA_DEPTH = 128
const MAX_QUOTA_ENTRIES = 100_000

async function directorySize(
  root: string,
  state: { visited: Set<string>; entries: number } = { visited: new Set(), entries: 0 },
  depth = 0,
): Promise<number> {
  if (depth > MAX_QUOTA_DEPTH) {
    throw new SyncSessionError('storage_quota_exceeded', '同步worktree目录层级超过限制')
  }
  let info
  try {
    info = await lstat(root)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0
    throw err
  }
  state.entries++
  if (state.entries > MAX_QUOTA_ENTRIES) {
    throw new SyncSessionError('storage_quota_exceeded', '同步worktree文件数量超过限制')
  }
  if (!info.isDirectory()) return info.size
  const identity = `${info.dev}:${info.ino}`
  if (state.visited.has(identity)) return 0
  state.visited.add(identity)
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    total += await directorySize(join(root, entry.name), state, depth + 1)
  }
  return total
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

function validCleanupProgress(value: unknown): value is CleanupProgress {
  if (!value || typeof value !== 'object') return false
  const progress = value as Record<string, unknown>
  return (
    typeof progress.worktreeRemoved === 'boolean' &&
    typeof progress.directoryRemoved === 'boolean' &&
    typeof progress.remoteRefDeleted === 'boolean' &&
    typeof progress.resolvedRefDeleted === 'boolean' &&
    typeof progress.candidateRefDeleted === 'boolean' &&
    typeof progress.worktreesPruned === 'boolean'
  )
}

function validSessionPhase(session: SyncSession): boolean {
  if (session.status === 'deleting') return true
  if (session.status === 'setup') {
    if (session.operation === 'force_pull') return session.setupStep === 'initialized'
    return session.setupStep !== 'completed'
  }
  return session.setupStep === 'completed'
}
