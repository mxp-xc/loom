import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { deriveRepoId, loadRepoManifest, validateManifest, type SkillSource } from '@loom/core'
import { readSkillsProjectionFiles } from '../api/repo-config.js'
import { logger } from '../lib/logger.js'
import type { FileSystemEntry, IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { SourceProjectionCatalog } from '../projection/source-catalog.js'
import {
  SourceCacheBoundaryError,
  assertAuthorizedSourceCache,
  assertStablePhysicalDirectory,
  createSourceCacheStaging,
  inspectDirectDirectory,
  removeStablePhysicalDirectory,
  resolveSourceCache,
  resolveSourceCacheRoot,
  type SourceCacheRoot,
  type StablePhysicalDirectory,
} from './cache-boundary.js'
import {
  SourceCacheHealthCatalog,
  inspectSourceCacheHealth,
  invalidateSourceRuntimeCatalogs,
  refreshSourceRuntimeCatalogs,
} from './source-cache-health.js'
import { scanProjectionSourceTree } from './source-tree.js'

const reconciliationLogger = logger.child('source-cache-reconciliation')
const PINNED_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const OWNER_FILE = '.loom-source-cache-reconciliation-owner.json'
const JOURNAL_FILE = '.loom-source-cache-reconciliation-journal.json'

export interface SourceCacheReconciliationDeps {
  fs: IFileSystem
  git: IGit
  sourceProjectionCatalog?: SourceProjectionCatalog
  sourceCacheHealthCatalog?: SourceCacheHealthCatalog
}

export interface SourceCacheReconciliationResult {
  restored: string[]
  unchanged: string[]
  unavailable: Array<{ source: SkillSource; err: unknown }>
}

interface ReconciliationOwner {
  version: 1
  sourceId: string
  sourceUrl: string
  pinnedCommit: string
}

interface ReconciliationJournal extends ReconciliationOwner {
  candidateIdentity: string
  liveIdentity: string | null
}

class SourceCacheReconciliationHardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceCacheReconciliationHardError'
  }
}

class SourceCacheReconciliationUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceCacheReconciliationUnavailableError'
  }
}

export async function reconcileSourceCachesAfterSync(
  deps: SourceCacheReconciliationDeps,
  repoPath: string,
): Promise<SourceCacheReconciliationResult> {
  const repoManifest = loadRepoManifest(await readSkillsProjectionFiles(deps.fs, repoPath))
  const manifestErrors = validateManifest(repoManifest)
  if (manifestErrors.length > 0) {
    throw hard(`Source cache reconciliation manifest is invalid: ${manifestErrors.join('; ')}`)
  }
  const manifest = repoManifest.skills
  const result: SourceCacheReconciliationResult = {
    restored: [],
    unchanged: [],
    unavailable: [],
  }

  for (const source of manifest.sources) {
    const pinnedCommit = source.pinned_commit?.trim() ?? ''
    if (!PINNED_COMMIT.test(pinnedCommit)) {
      const err = new Error(`Source pinned commit is invalid: ${source.url}`)
      markUnavailable(deps, repoPath, source, err, 'invalid')
      result.unavailable.push({ source, err })
      continue
    }

    const pending = await hasPendingWorkspace(deps.fs, repoPath, source.url, pinnedCommit)
    const health = await inspectSourceCacheHealth(deps.fs, deps.git, repoPath, source)
    if (health.healthy && !pending) {
      deps.sourceCacheHealthCatalog?.put(repoPath, source, health)
      result.unchanged.push(source.url)
      continue
    }
    if (!health.healthy && health.err instanceof SourceCacheBoundaryError) throw health.err

    try {
      await restoreSourceCache(deps, repoPath, source, pinnedCommit)
      const refreshed = await refreshSourceRuntimeCatalogs(
        deps.fs,
        deps.git,
        deps.sourceProjectionCatalog,
        deps.sourceCacheHealthCatalog,
        repoPath,
        source,
      )
      if (!refreshed.healthy) {
        throw new SourceCacheReconciliationHardError(
          'Restored source cache failed post-promotion validation',
          { cause: refreshed.err },
        )
      }
      result.restored.push(source.url)
    } catch (err) {
      if (isHardFailure(err)) throw err
      reconciliationLogger.error('source cache reconciliation failed', {
        err,
        repoPath,
        sourceUrl: source.url,
        pinnedCommit,
      })
      const current = await inspectSourceCacheHealth(deps.fs, deps.git, repoPath, source)
      if (!current.healthy && current.err instanceof SourceCacheBoundaryError) throw current.err
      markUnavailable(deps, repoPath, source, err, current.healthy ? 'invalid' : current.reason)
      result.unavailable.push({ source, err })
    }
  }

  return result
}

async function restoreSourceCache(
  deps: SourceCacheReconciliationDeps,
  repoPath: string,
  source: SkillSource,
  pinnedCommit: string,
): Promise<void> {
  const sourceId = deriveRepoId(source.url)
  const root = await resolveSourceCacheRoot(deps.fs, repoPath, true)
  if (!root) throw new SourceCacheReconciliationHardError('Source cache root is unavailable')
  const owner: ReconciliationOwner = {
    version: 1,
    sourceId,
    sourceUrl: source.url,
    pinnedCommit,
  }
  let workspace = await inspectDirectDirectory(
    deps.fs,
    root,
    workspaceName(source.url, pinnedCommit),
    'source cache reconciliation workspace',
  )

  if (workspace) {
    await assertOwner(deps.fs, workspace, owner)
    const journal = await readJournal(deps.fs, workspace)
    if (journal) {
      await completeSwap(deps, repoPath, source, root, workspace, journal)
      return
    }
    await removeStablePhysicalDirectory(
      deps.fs,
      workspace,
      'incomplete source cache reconciliation workspace',
    )
    workspace = null
  }

  workspace = await createSourceCacheStaging(deps.fs, root, workspaceName(source.url, pinnedCommit))
  let journalWritten = false
  try {
    await deps.fs.writeFileExclusive(join(workspace.path, OWNER_FILE), JSON.stringify(owner))
    const candidatePath = join(workspace.path, 'candidate')
    await deps.git.clone(source.url, candidatePath, false)
    await deps.git.checkout(candidatePath, pinnedCommit)
    const candidate = await requireChildDirectory(
      deps.fs,
      workspace,
      'candidate',
      'source cache reconciliation candidate',
    )
    await requireChildDirectory(
      deps.fs,
      candidate,
      '.git',
      'source cache reconciliation candidate metadata',
    )
    const actualCommit = await deps.git.revParseHead(candidate.path)
    if (actualCommit !== pinnedCommit) {
      throw new Error('Source cache candidate does not match its pinned commit')
    }
    await scanProjectionSourceTree(deps.git, candidate.path, pinnedCommit, source)
    await assertStablePhysicalDirectory(deps.fs, candidate, 'revalidate source cache candidate')

    const live = await resolveSourceCache(deps.fs, repoPath, sourceId)
    const journal: ReconciliationJournal = {
      ...owner,
      candidateIdentity: candidate.identity,
      liveIdentity: live?.directory.identity ?? null,
    }
    try {
      await deps.fs.writeFileExclusive(join(workspace.path, JOURNAL_FILE), JSON.stringify(journal))
    } catch (err) {
      throw hard('Source cache reconciliation journal cannot be persisted', err)
    }
    journalWritten = true
    await completeSwap(deps, repoPath, source, root, workspace, journal)
  } catch (err) {
    if (journalWritten || isHardFailure(err)) throw err
    const cleanupErrors = await cleanupWorkspace(deps.fs, workspace)
    if (cleanupErrors.length > 0) {
      reconciliationLogger.error('failed to clean incomplete source cache reconciliation', {
        err: new AggregateError(
          [err, ...cleanupErrors],
          'source cache preparation cleanup failed',
          {
            cause: err,
          },
        ),
        repoPath,
        sourceUrl: source.url,
      })
    }
    throw err
  }
}

async function completeSwap(
  deps: SourceCacheReconciliationDeps,
  repoPath: string,
  source: SkillSource,
  root: SourceCacheRoot,
  workspace: StablePhysicalDirectory,
  journal: ReconciliationJournal,
): Promise<void> {
  await assertOwner(deps.fs, workspace, journal)
  const sourceId = journal.sourceId
  const livePath = join(root.path, sourceId)
  const candidatePath = join(workspace.path, 'candidate')
  const backupPath = join(workspace.path, 'backup')

  try {
    let live = await inspectDirectDirectory(deps.fs, root, sourceId, 'live source cache')
    let candidate = await inspectDirectDirectory(
      deps.fs,
      workspace,
      'candidate',
      'source cache reconciliation candidate',
    )
    let backup = await inspectDirectDirectory(
      deps.fs,
      workspace,
      'backup',
      'source cache reconciliation backup',
    )
    assertSwapIdentities(live, candidate, backup, journal)

    if (live?.identity !== journal.candidateIdentity) {
      if (journal.liveIdentity && live?.identity === journal.liveIdentity) {
        if (backup) throw hard('Previous source cache exists at two locations')
        await deps.fs.moveDirectoryAtomic(livePath, backupPath, journal.liveIdentity)
        backup = await requireChildDirectory(
          deps.fs,
          workspace,
          'backup',
          'moved source cache reconciliation backup',
        )
        live = null
      }
      if (!candidate) throw hard('Source cache reconciliation candidate is unavailable')
      await deps.fs.moveDirectoryAtomic(candidatePath, livePath, journal.candidateIdentity)
      live = await requireChildDirectory(deps.fs, root, sourceId, 'promoted source cache')
      candidate = null
    }

    if (live.identity !== journal.candidateIdentity) {
      throw hard('Promoted source cache identity changed')
    }
    const installed = await resolveSourceCache(deps.fs, repoPath, sourceId)
    if (!installed || installed.directory.identity !== journal.candidateIdentity) {
      throw hard('Promoted source cache is unavailable')
    }
    await assertAuthorizedSourceCache(deps.fs, installed)
    if ((await deps.git.revParseHead(installed.directory.path)) !== journal.pinnedCommit) {
      throw hard('Promoted source cache does not match its pinned commit')
    }
    await scanProjectionSourceTree(deps.git, installed.directory.path, journal.pinnedCommit, source)
    try {
      await removeStablePhysicalDirectory(
        deps.fs,
        workspace,
        'completed source cache reconciliation workspace',
      )
    } catch (err) {
      throw new SourceCacheReconciliationUnavailableError(
        'Completed source cache reconciliation cleanup failed',
        { cause: err },
      )
    }
  } catch (err) {
    const rollbackErrors = await rollbackSwap(deps.fs, root, workspace, journal)
    if (rollbackErrors.length > 0) {
      throw new SourceCacheReconciliationHardError('Source cache reconciliation rollback failed', {
        cause: new AggregateError(
          [err, ...rollbackErrors],
          'source cache swap and rollback failed',
          {
            cause: err,
          },
        ),
      })
    }
    throw err
  }
}

async function hasPendingWorkspace(
  fs: IFileSystem,
  repoPath: string,
  sourceUrl: string,
  pinnedCommit: string,
): Promise<boolean> {
  const root = await resolveSourceCacheRoot(fs, repoPath)
  if (!root) return false
  return Boolean(
    await inspectDirectDirectory(
      fs,
      root,
      workspaceName(sourceUrl, pinnedCommit),
      'source cache reconciliation workspace',
    ),
  )
}

async function rollbackSwap(
  fs: IFileSystem,
  root: SourceCacheRoot,
  workspace: StablePhysicalDirectory,
  journal: ReconciliationJournal,
): Promise<unknown[]> {
  const errors: unknown[] = []
  const livePath = join(root.path, journal.sourceId)
  const candidatePath = join(workspace.path, 'candidate')
  const backupPath = join(workspace.path, 'backup')
  try {
    const live = await inspectDirectDirectory(
      fs,
      root,
      journal.sourceId,
      'live source cache rollback',
    )
    const candidate = await inspectDirectDirectory(
      fs,
      workspace,
      'candidate',
      'source cache reconciliation candidate rollback',
    )
    if (live?.identity === journal.candidateIdentity) {
      if (candidate) throw hard('Candidate source cache exists at two locations during rollback')
      await fs.moveDirectoryAtomic(livePath, candidatePath, journal.candidateIdentity)
    } else if (live && live.identity !== journal.liveIdentity) {
      throw hard('Live source cache was replaced during rollback')
    }

    const currentLive = await inspectDirectDirectory(
      fs,
      root,
      journal.sourceId,
      'restored live cache',
    )
    const backup = await inspectDirectDirectory(
      fs,
      workspace,
      'backup',
      'source cache reconciliation backup rollback',
    )
    if (journal.liveIdentity) {
      if (!currentLive) {
        if (!backup || backup.identity !== journal.liveIdentity) {
          throw hard('Previous source cache cannot be restored')
        }
        await fs.moveDirectoryAtomic(backupPath, livePath, journal.liveIdentity)
      } else if (currentLive.identity !== journal.liveIdentity) {
        throw hard('Restored source cache identity changed')
      }
    } else if (currentLive) {
      throw hard('Unexpected live source cache remains after rollback')
    }
  } catch (err) {
    errors.push(err)
    return errors
  }

  errors.push(...(await cleanupWorkspace(fs, workspace)))
  return errors
}

function assertSwapIdentities(
  live: StablePhysicalDirectory | null,
  candidate: StablePhysicalDirectory | null,
  backup: StablePhysicalDirectory | null,
  journal: ReconciliationJournal,
): void {
  if (
    live &&
    live.identity !== journal.candidateIdentity &&
    live.identity !== journal.liveIdentity
  ) {
    throw hard('Live source cache identity does not match the reconciliation journal')
  }
  if (candidate && candidate.identity !== journal.candidateIdentity) {
    throw hard('Candidate source cache identity does not match the reconciliation journal')
  }
  if (backup && backup.identity !== journal.liveIdentity) {
    throw hard('Backup source cache identity does not match the reconciliation journal')
  }
  if (live?.identity === journal.candidateIdentity && candidate) {
    throw hard('Candidate source cache exists at two locations')
  }
  if (live?.identity === journal.liveIdentity && backup) {
    throw hard('Previous source cache exists at two locations')
  }
}

async function assertOwner(
  fs: IFileSystem,
  workspace: StablePhysicalDirectory,
  expected: ReconciliationOwner,
): Promise<void> {
  const owner = await readStableJson(fs, workspace, OWNER_FILE)
  if (!isOwner(owner) || !sameOwner(owner, expected)) {
    throw hard('Source cache reconciliation workspace ownership is invalid')
  }
}

async function readJournal(
  fs: IFileSystem,
  workspace: StablePhysicalDirectory,
): Promise<ReconciliationJournal | null> {
  const entry = await inspectTransactionEntry(
    fs,
    join(workspace.path, JOURNAL_FILE),
    'source cache reconciliation journal',
  )
  if (!entry) return null
  const journal = await readStableJson(fs, workspace, JOURNAL_FILE)
  if (!isJournal(journal)) throw hard('Source cache reconciliation journal is invalid')
  return journal
}

async function readStableJson(
  fs: IFileSystem,
  workspace: StablePhysicalDirectory,
  name: string,
): Promise<unknown> {
  await assertStablePhysicalDirectory(fs, workspace, `revalidate ${name} parent`)
  const path = join(workspace.path, name)
  const before = await inspectTransactionEntry(fs, path, name)
  if (before?.kind !== 'file' || before.linkCount !== 1) throw hard(`${name} is unavailable`)
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(path))
  } catch (err) {
    throw hard(`${name} cannot be read`, err)
  }
  const after = await inspectTransactionEntry(fs, path, name)
  if (
    after?.kind !== 'file' ||
    after.identity !== before.identity ||
    after.linkCount !== before.linkCount
  ) {
    throw hard(`${name} changed while reading`)
  }
  await assertStablePhysicalDirectory(fs, workspace, `revalidate ${name} parent`)
  return value
}

async function inspectTransactionEntry(
  fs: IFileSystem,
  path: string,
  description: string,
): Promise<FileSystemEntry | null> {
  try {
    return await fs.inspectEntry(path)
  } catch (err) {
    throw hard(`Failed to inspect ${description}`, err)
  }
}

async function requireChildDirectory(
  fs: IFileSystem,
  parent: StablePhysicalDirectory,
  name: string,
  description: string,
): Promise<StablePhysicalDirectory> {
  const directory = await inspectDirectDirectory(fs, parent, name, description)
  if (!directory) throw new Error(`${description} is unavailable`)
  return directory
}

async function cleanupWorkspace(
  fs: IFileSystem,
  workspace: StablePhysicalDirectory,
): Promise<unknown[]> {
  try {
    const current = await fs.inspectEntry(workspace.path)
    if (!current) return []
    if (current.kind !== 'directory' || current.identity !== workspace.identity) {
      return [hard('Source cache reconciliation workspace identity changed during cleanup')]
    }
    await removeStablePhysicalDirectory(fs, workspace, 'source cache reconciliation workspace')
    return []
  } catch (err) {
    return [err]
  }
}

function markUnavailable(
  deps: SourceCacheReconciliationDeps,
  repoPath: string,
  source: SkillSource,
  err: unknown,
  reason: 'missing' | 'invalid',
): void {
  invalidateSourceRuntimeCatalogs(
    deps.sourceProjectionCatalog,
    deps.sourceCacheHealthCatalog,
    repoPath,
    source.url,
  )
  deps.sourceCacheHealthCatalog?.put(repoPath, source, { healthy: false, reason, err })
}

function workspaceName(sourceUrl: string, pinnedCommit: string): string {
  const key = createHash('sha256').update(`${sourceUrl}\0${pinnedCommit}`).digest('hex')
  return `.loom-cache-reconcile-${key}`
}

function isOwner(value: unknown): value is ReconciliationOwner {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    typeof value.sourceId === 'string' &&
    typeof value.sourceUrl === 'string' &&
    typeof value.pinnedCommit === 'string'
  )
}

function isJournal(value: unknown): value is ReconciliationJournal {
  if (!isOwner(value)) return false
  const journal = value as ReconciliationOwner & Record<string, unknown>
  return (
    typeof journal.candidateIdentity === 'string' &&
    (typeof journal.liveIdentity === 'string' || journal.liveIdentity === null)
  )
}

function sameOwner(left: ReconciliationOwner, right: ReconciliationOwner): boolean {
  return (
    left.version === right.version &&
    left.sourceId === right.sourceId &&
    left.sourceUrl === right.sourceUrl &&
    left.pinnedCommit === right.pinnedCommit
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hard(message: string, cause?: unknown): SourceCacheReconciliationHardError {
  return new SourceCacheReconciliationHardError(
    message,
    cause === undefined ? undefined : { cause },
  )
}

function isHardFailure(error: unknown): boolean {
  return (
    error instanceof SourceCacheReconciliationHardError || error instanceof SourceCacheBoundaryError
  )
}
