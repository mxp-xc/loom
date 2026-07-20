import { createHash, randomUUID } from 'node:crypto'
import { join, normalize } from 'node:path'
import {
  AgentIdSchema,
  LocalSkillIdSchema,
  SkillSourceSchema,
  assertLocalSkillId,
  type SkillSource,
} from '@loom/core'
import { z } from 'zod'
import type { IFileSystem } from '../ports/fs.js'
import type { PreparedSourceUpdate, ScannedSourceBundle } from '../remote/update.js'
import { logger } from '../lib/logger.js'
import { normalizeSkillPath } from './reconciliation.js'
import {
  SOURCE_UPDATE_SESSION_VERSION,
  SourceUpdateWorkspaceError,
  assertOwnedDirectory,
  createSourceUpdateWorkspace,
  deriveSourceUpdateWorkspace,
  ensureSourceUpdateChildDirectory,
  inspectOptionalOwnedDirectory,
  inspectSourceUpdateStateFile,
  removeSourceUpdateWorkspace,
  assertSourceUpdateSessionId,
  sourceUpdateKey,
  verifySourceUpdateWorkspace,
  workspaceIdentity,
  type SourceUpdateWorkspace,
  type SourceUpdateWorkspaceIdentity,
} from './source-update-workspace.js'

const sessionLogger = logger.child('source-update-session')
export const SOURCE_UPDATE_PRESERVED_MARKER = '.loom-source-update-owner.json'
const SOURCE_UPDATE_PRESERVED_MARKER_VERSION = 1

type SessionFileSystem = Pick<
  IFileSystem,
  | 'readFile'
  | 'writeFile'
  | 'writeFileExclusive'
  | 'replaceFile'
  | 'inspectEntry'
  | 'realPath'
  | 'mkdir'
  | 'moveNoReplace'
  | 'moveDirectoryAtomic'
  | 'removeDir'
  | 'removeEntryIfIdentity'
  | 'removeFile'
  | 'readDir'
>

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_SESSIONS_PER_REPO = 8

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const IdentitySchema = z.string().min(1)
const SafeRelativePathSchema = z
  .string()
  .refine((value) => isSafeRelativePath(value, true), 'must be a normalized relative path')
const SkillPathSchema = z.string().refine((value) => {
  try {
    return normalizeSkillPath(value) === value
  } catch {
    return false
  }
}, 'must identify a normalized SKILL.md path')
const ScannedSourceBundleSchema = z
  .object({
    name: LocalSkillIdSchema,
    entry: SkillPathSchema,
    description: z.string().optional(),
  })
  .strict()
const SkillMemberChangeSchema = z
  .object({
    name: LocalSkillIdSchema,
    previousPath: SkillPathSchema.optional(),
    nextPath: SkillPathSchema.optional(),
    agents: z.array(AgentIdSchema).optional(),
  })
  .strict()
const SkillMemberChangesSchema = z
  .object({
    added: z.array(SkillMemberChangeSchema),
    updated: z.array(SkillMemberChangeSchema),
    removed: z.array(SkillMemberChangeSchema),
    unchanged: z.array(SkillMemberChangeSchema),
  })
  .strict()
const ResourceBoundaryChangeSchema = z
  .object({
    name: LocalSkillIdSchema,
    entry: SkillPathSchema,
    path: SafeRelativePathSchema.refine(Boolean, 'path must not be empty'),
  })
  .strict()
const ProjectionPathMoveSchema = z
  .object({
    agent: AgentIdSchema,
    kind: z.enum(['bundle', 'resource-file', 'resource-directory']),
    sourcePath: SafeRelativePathSchema,
    previousTargetPath: SafeRelativePathSchema.optional(),
    nextTargetPath: SafeRelativePathSchema.optional(),
  })
  .strict()
const PreservedDestinationSchema = z
  .object({
    name: LocalSkillIdSchema,
    ownerToken: z.string().uuid(),
    identity: IdentitySchema,
  })
  .strict()
const PreservedDestinationMarkerSchema = z
  .object({
    version: z.literal(SOURCE_UPDATE_PRESERVED_MARKER_VERSION),
    sessionId: z.string().uuid(),
    ownerToken: z.string().uuid(),
    skillId: LocalSkillIdSchema,
  })
  .strict()
const SourceFinalizeJournalSchema = z
  .object({
    originalManifest: z.string(),
    nextManifestHash: Sha256Schema,
    originalManifestIdentity: IdentitySchema,
    nextManifestIdentity: IdentitySchema,
    candidateAnchorIdentity: IdentitySchema,
    candidateDirectoryIdentity: IdentitySchema.optional(),
    liveCacheDirectoryIdentity: IdentitySchema.optional(),
    liveCacheAnchorIdentity: IdentitySchema.optional(),
    hadLiveCache: z.boolean(),
    rollbackProjectionRequired: z.boolean(),
    preservedDestinations: z.array(PreservedDestinationSchema),
  })
  .strict()
  .superRefine((journal, context) => {
    if (
      journal.liveCacheDirectoryIdentity !== undefined &&
      journal.hadLiveCache !== Boolean(journal.liveCacheDirectoryIdentity)
    ) {
      context.addIssue({ code: 'custom', message: 'live cache directory identity is inconsistent' })
    }
    if (journal.rollbackProjectionRequired !== Boolean(journal.liveCacheAnchorIdentity)) {
      context.addIssue({ code: 'custom', message: 'live cache anchor identity is inconsistent' })
    }
  })
const CompletedSourceUpdateSchema = z
  .object({
    preserved: z.array(LocalSkillIdSchema),
    deleted: z.array(LocalSkillIdSchema),
  })
  .strict()
const TimestampSchema = z.string().datetime({ offset: true })
const PersistedSourceUpdateSessionSchema = z
  .object({
    version: z.literal(SOURCE_UPDATE_SESSION_VERSION),
    id: z.string().uuid(),
    ownerToken: z.string().uuid(),
    sourceKey: Sha256Schema,
    rootIdentity: IdentitySchema,
    sourceBaseline: Sha256Schema,
    source: SkillSourceSchema,
    newRef: z.string().min(1),
    pinned_commit: z.string().min(1),
    newMembers: z.array(ScannedSourceBundleSchema),
    changes: SkillMemberChangesSchema,
    resourceBoundaryChanges: z.array(ResourceBoundaryChangeSchema),
    pathMoves: z.array(ProjectionPathMoveSchema),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
    finalize: SourceFinalizeJournalSchema.optional(),
    completed: CompletedSourceUpdateSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    if (Boolean(session.createdAt) !== Boolean(session.updatedAt)) {
      context.addIssue({ code: 'custom', message: 'session timestamps must be present together' })
    }
    if (
      session.createdAt &&
      session.updatedAt &&
      Date.parse(session.updatedAt) < Date.parse(session.createdAt)
    ) {
      context.addIssue({ code: 'custom', message: 'session timestamps are not monotonic' })
    }
    if (session.finalize && session.completed) {
      context.addIssue({ code: 'custom', message: 'session cannot be finalizing and completed' })
    }
  })

type PersistedSourceUpdateSession = z.infer<typeof PersistedSourceUpdateSessionSchema>

export interface PreservedDestinationOwnership {
  name: string
  ownerToken: string
  identity: string
}

export interface SourceFinalizeJournal {
  originalManifest: string
  nextManifestHash: string
  originalManifestIdentity: string
  nextManifestIdentity: string
  candidateAnchorIdentity: string
  candidateDirectoryIdentity?: string
  liveCacheDirectoryIdentity?: string
  liveCacheAnchorIdentity?: string
  hadLiveCache: boolean
  rollbackProjectionRequired: boolean
  preservedDestinations: PreservedDestinationOwnership[]
}

export interface SourceUpdateSession extends PreparedSourceUpdate, SourceUpdateWorkspace {
  sourceBaseline: string
  source: SkillSource
  newRef: string
  createdAt?: string
  updatedAt?: string
  finalize?: SourceFinalizeJournal
  completed?: { preserved: string[]; deleted: string[] }
}

export interface BeginSourceFinalizeInput {
  originalManifest: string
  nextManifest: string
  hadLiveCache: boolean
  rollbackProjectionRequired: boolean
  preservedDestinations: PreservedDestinationOwnership[]
}

export class SourceUpdateSessionError extends Error {
  constructor(
    readonly code: 'invalid_update_session_state' | 'update_session_unavailable',
    readonly status: 422 | 500,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SourceUpdateSessionError'
  }
}

export class SourceUpdateSessionStore {
  private readonly sessions = new Map<string, SourceUpdateSession>()

  constructor(
    private readonly fs: SessionFileSystem,
    private readonly options: {
      now?: () => Date
      ttlMs?: number
      maxSessionsPerRepo?: number
    } = {},
  ) {}

  async createWorkspace(repoPath: string, sourceUrl: string): Promise<SourceUpdateWorkspace> {
    return createSourceUpdateWorkspace(this.fs, repoPath, sourceUrl)
  }

  async create(input: {
    workspace: SourceUpdateWorkspace
    source: SkillSource
    newRef: string
    prepared: PreparedSourceUpdate
  }): Promise<SourceUpdateSession> {
    const source = SkillSourceSchema.parse(input.source)
    const verifiedWorkspace = await verifySourceUpdateWorkspace(
      this.fs,
      input.workspace.repoPath,
      source.url,
      input.workspace,
    )
    const createdAt = this.now()
    const session: SourceUpdateSession = {
      ...verifiedWorkspace,
      ...input.prepared,
      sourceBaseline: sourceUpdateBaseline(source),
      source,
      newRef: input.newRef,
      createdAt,
      updatedAt: createdAt,
    }
    try {
      await this.save(session)
    } catch (error) {
      try {
        await removeSourceUpdateWorkspace(this.fs, verifiedWorkspace, source.url)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'source update session creation and cleanup failed',
          { cause: error },
        )
      }
      throw error
    }
    this.sessions.set(session.id, session)
    return session
  }

  async beginFinalize(
    session: SourceUpdateSession,
    input: BeginSourceFinalizeInput,
  ): Promise<void> {
    const workspace = await this.verify(session)
    await ensureSourceUpdateChildDirectory(this.fs, session.repoPath, 'remote-cache')
    const manifest = await assertRegularFile(this.fs, workspace.manifestPath, 'skills manifest')
    if ((await this.fs.readFile(workspace.manifestPath)) !== input.originalManifest) {
      throw invalidState('skills manifest changed before finalize')
    }
    const candidate = await inspectOptionalOwnedDirectory(
      this.fs,
      workspace.candidateDir,
      'source update candidate',
    )
    if (!candidate) throw invalidState('source update candidate is missing')
    const candidateAnchor = await assertCacheAnchorFile(
      this.fs,
      workspace.candidateDir,
      'source update candidate',
    )
    const liveCache = await inspectOptionalOwnedDirectory(
      this.fs,
      workspace.liveCacheDir,
      'live source cache',
    )
    if (input.hadLiveCache !== Boolean(liveCache)) {
      throw invalidState('live source cache changed before finalize')
    }
    if (input.rollbackProjectionRequired && !liveCache) {
      throw invalidState('rollback projection requires a live source cache')
    }
    const liveCacheAnchor = input.rollbackProjectionRequired
      ? await assertCacheAnchorFile(this.fs, workspace.liveCacheDir, 'live source cache')
      : null
    const backup = await this.fs.inspectEntry(workspace.backupCacheDir)
    if (backup) throw invalidState('source update backup already exists')
    await this.removeStaleManifestArtifact(workspace.manifestBackupPath)
    await this.removeStaleManifestArtifact(workspace.manifestCandidatePath)
    const preservedDestinations = input.preservedDestinations.map((destination) =>
      PreservedDestinationSchema.parse(destination),
    )
    const preservedNames = new Set<string>()
    for (const destination of preservedDestinations) {
      if (destination.ownerToken !== session.ownerToken) {
        throw invalidState('preserved destination owner token does not match the session')
      }
      if (preservedNames.has(destination.name)) {
        throw invalidState(`preserved destination is duplicated: ${destination.name}`)
      }
      preservedNames.add(destination.name)
      if (
        await this.fs.inspectEntry(join(session.repoPath, 'assets', 'skills', destination.name))
      ) {
        throw invalidState(`preserved destination already exists: ${destination.name}`)
      }
    }

    let manifestCandidate: Awaited<ReturnType<typeof assertRegularFile>> | undefined
    try {
      await this.fs.writeFileExclusive(workspace.manifestCandidatePath, input.nextManifest)
      manifestCandidate = await assertRegularFile(
        this.fs,
        workspace.manifestCandidatePath,
        'source update manifest candidate',
      )
      const next = cloneSession(session)
      next.finalize = {
        originalManifest: input.originalManifest,
        nextManifestHash: hashText(input.nextManifest),
        originalManifestIdentity: manifest.identity,
        nextManifestIdentity: manifestCandidate.identity,
        candidateAnchorIdentity: candidateAnchor.identity,
        candidateDirectoryIdentity: candidate.identity,
        ...(liveCache ? { liveCacheDirectoryIdentity: liveCache.identity } : {}),
        ...(liveCacheAnchor ? { liveCacheAnchorIdentity: liveCacheAnchor.identity } : {}),
        hadLiveCache: input.hadLiveCache,
        rollbackProjectionRequired: input.rollbackProjectionRequired,
        preservedDestinations,
      }
      await this.commitTransition(session, next)
    } catch (error) {
      if (!manifestCandidate) throw error
      try {
        await this.fs.removeEntryIfIdentity(
          workspace.manifestCandidatePath,
          manifestCandidate.identity,
        )
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'source update finalize preparation and cleanup failed',
          { cause: error },
        )
      }
      throw error
    }
  }

  async applyManifest(session: SourceUpdateSession): Promise<void> {
    const journal = session.finalize
    if (!journal) throw invalidState('source update finalize journal is missing')
    const workspace = await this.verify(session)
    await assertStableRegularFile(
      this.fs,
      workspace.manifestPath,
      journal.originalManifestIdentity,
      'skills manifest',
    )
    if ((await this.fs.readFile(workspace.manifestPath)) !== journal.originalManifest) {
      throw invalidState('skills manifest changed before install')
    }
    await assertStableRegularFile(
      this.fs,
      workspace.manifestCandidatePath,
      journal.nextManifestIdentity,
      'source update manifest candidate',
    )
    await this.fs.moveNoReplace(
      workspace.manifestPath,
      workspace.manifestBackupPath,
      journal.originalManifestIdentity,
    )
    try {
      await this.fs.moveNoReplace(
        workspace.manifestCandidatePath,
        workspace.manifestPath,
        journal.nextManifestIdentity,
      )
    } catch (error) {
      try {
        await this.fs.moveNoReplace(
          workspace.manifestBackupPath,
          workspace.manifestPath,
          journal.originalManifestIdentity,
        )
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'manifest install and rollback failed', {
          cause: error,
        })
      }
      throw error
    }
  }

  async recoverFinalize(session: SourceUpdateSession): Promise<{ projectionRequired: boolean }> {
    const journal = session.finalize
    if (!journal) return { projectionRequired: false }

    try {
      const workspace = await this.verify(session)
      await this.restoreManifest(workspace, journal)
      await this.restoreCache(workspace, journal)
      await this.removeOwnedPreservedDestinations(session, journal)
      return { projectionRequired: journal.rollbackProjectionRequired }
    } catch (err) {
      sessionLogger.error('source update finalize recovery failed', {
        err,
        sessionId: session.id,
        repoPath: session.repoPath,
      })
      throw err
    }
  }

  async completeFinalizeRecovery(session: SourceUpdateSession): Promise<void> {
    const next = cloneSession(session)
    delete next.finalize
    await this.commitTransition(session, next)
  }

  async markCompleted(
    session: SourceUpdateSession,
    result: NonNullable<SourceUpdateSession['completed']>,
  ): Promise<void> {
    const parsed = CompletedSourceUpdateSchema.parse(result)
    const next = cloneSession(session)
    delete next.finalize
    next.completed = parsed
    await this.commitTransition(session, next)
  }

  async get(id: string, repoPath: string): Promise<SourceUpdateSession | undefined> {
    const current = this.sessions.get(id)
    if (current) {
      if (current.repoPath !== repoPath) return undefined
      await this.verify(current)
      return current
    }

    let raw: string | undefined
    try {
      raw = await inspectSourceUpdateStateFile(this.fs, repoPath, id)
    } catch (error) {
      const err = normalizeSessionError(error, 'failed to inspect source update state')
      sessionLogger.error('source update session recovery failed', { err, sessionId: id, repoPath })
      throw err
    }
    if (raw === undefined) return undefined

    try {
      const parsedJson: unknown = JSON.parse(raw)
      const persisted = PersistedSourceUpdateSessionSchema.parse(parsedJson)
      if (persisted.id !== id || persisted.sourceKey !== sourceUpdateKey(persisted.source.url)) {
        throw invalidState('persisted source update identity is inconsistent')
      }
      if (persisted.sourceBaseline !== sourceUpdateBaseline(persisted.source)) {
        throw invalidState('persisted source update baseline is inconsistent')
      }
      const session = await this.inflate(repoPath, persisted)
      this.sessions.set(id, session)
      return session
    } catch (error) {
      const err = normalizeSessionError(error, 'persisted source update state is invalid', 422)
      sessionLogger.error('source update session recovery failed', { err, sessionId: id, repoPath })
      throw err
    }
  }

  async discard(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    await this.verify(session)
    await removeSourceUpdateWorkspace(this.fs, session, session.source.url)
    this.sessions.delete(id)
  }

  async prune(repoPath: string, reserveCapacity = 0): Promise<void> {
    const ids = await this.listSessionIds(repoPath)
    const eligible: SourceUpdateSession[] = []
    for (const id of ids) {
      try {
        const session = await this.get(id, repoPath)
        if (!session || session.finalize) continue
        if (session.completed) {
          await this.discard(session.id)
          continue
        }
        if (session.createdAt && session.updatedAt) eligible.push(session)
      } catch (err) {
        sessionLogger.error('source update session prune failed', { err, sessionId: id, repoPath })
      }
    }

    eligible.sort(compareSessionAge)
    const now = this.nowMs()
    const ttlMs = this.options.ttlMs ?? DEFAULT_SESSION_TTL_MS
    const capacity = Math.max(0, this.options.maxSessionsPerRepo ?? DEFAULT_MAX_SESSIONS_PER_REPO)
    const retainedCapacity = Math.max(0, capacity - reserveCapacity)
    const expired = eligible.filter((session) => now - Date.parse(session.updatedAt!) >= ttlMs)
    const expiredIds = new Set(expired.map(({ id }) => id))
    const retained = eligible.filter(({ id }) => !expiredIds.has(id))
    const overCapacity = retained.slice(0, Math.max(0, retained.length - retainedCapacity))
    for (const session of new Set([...expired, ...overCapacity])) {
      try {
        await this.discard(session.id)
      } catch (err) {
        sessionLogger.error('source update session prune failed', {
          err,
          sessionId: session.id,
          repoPath,
        })
      }
    }
  }

  private async inflate(
    repoPath: string,
    persisted: PersistedSourceUpdateSession,
  ): Promise<SourceUpdateSession> {
    const identity: SourceUpdateWorkspaceIdentity = {
      version: persisted.version,
      id: persisted.id,
      ownerToken: persisted.ownerToken,
      sourceKey: persisted.sourceKey,
      rootIdentity: persisted.rootIdentity,
    }
    const workspace = await verifySourceUpdateWorkspace(
      this.fs,
      repoPath,
      persisted.source.url,
      identity,
    )
    return {
      ...workspace,
      sourceBaseline: persisted.sourceBaseline,
      source: persisted.source,
      newRef: persisted.newRef,
      pinned_commit: persisted.pinned_commit,
      newMembers: persisted.newMembers,
      changes: persisted.changes,
      resourceBoundaryChanges: persisted.resourceBoundaryChanges,
      pathMoves: persisted.pathMoves,
      ...(persisted.createdAt ? { createdAt: persisted.createdAt } : {}),
      ...(persisted.updatedAt ? { updatedAt: persisted.updatedAt } : {}),
      ...(persisted.finalize ? { finalize: persisted.finalize } : {}),
      ...(persisted.completed ? { completed: persisted.completed } : {}),
    }
  }

  private async verify(session: SourceUpdateSession): Promise<SourceUpdateWorkspace> {
    return verifySourceUpdateWorkspace(
      this.fs,
      session.repoPath,
      session.source.url,
      workspaceIdentity(session),
    )
  }

  private async commitTransition(
    current: SourceUpdateSession,
    next: SourceUpdateSession,
  ): Promise<void> {
    next.updatedAt = this.now()
    await this.save(next)
    replaceSessionState(current, next)
    this.sessions.set(current.id, current)
  }

  private async listSessionIds(repoPath: string): Promise<string[]> {
    await assertPhysicalDirectory(this.fs, repoPath, 'repository root')
    const temp = join(repoPath, 'temp')
    if (!(await this.fs.inspectEntry(temp))) return []
    await assertPhysicalDirectory(this.fs, temp, 'repository temp')
    const updates = join(temp, 'source-updates')
    if (!(await this.fs.inspectEntry(updates))) return []
    await assertPhysicalDirectory(this.fs, updates, 'source update root')
    return (await this.fs.readDir(updates)).filter((id) => {
      try {
        assertSourceUpdateSessionId(id)
        return true
      } catch {
        return false
      }
    })
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime()
  }

  private async save(session: SourceUpdateSession): Promise<void> {
    const workspace = await this.verify(session)
    const persisted = persistedSession(session)
    PersistedSourceUpdateSessionSchema.parse(persisted)
    const temporary = join(workspace.sessionRoot, `session.next-${randomUUID()}.json`)
    try {
      await this.fs.writeFileExclusive(temporary, JSON.stringify(persisted))
      await this.fs.replaceFile(temporary, workspace.stateFile)
    } catch (error) {
      try {
        await this.fs.removeFile(temporary)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'source update state save and cleanup failed',
          { cause: error },
        )
      }
      throw error
    }
  }

  private async restoreManifest(
    workspace: SourceUpdateWorkspace,
    journal: SourceFinalizeJournal,
  ): Promise<void> {
    const current = await this.fs.inspectEntry(workspace.manifestPath)
    const candidate = await this.fs.inspectEntry(workspace.manifestCandidatePath)
    const backup = await this.fs.inspectEntry(workspace.manifestBackupPath)

    if (current?.kind === 'file' && current.identity === journal.originalManifestIdentity) {
      if (backup) throw invalidState('original skills manifest exists at two locations')
      if (candidate?.kind !== 'file' || candidate.identity !== journal.nextManifestIdentity) {
        throw invalidState('source update manifest candidate changed')
      }
      if ((await this.fs.readFile(workspace.manifestPath)) !== journal.originalManifest) {
        throw invalidState('original skills manifest content changed')
      }
      return
    }
    if (!current) {
      if (candidate?.kind !== 'file' || candidate.identity !== journal.nextManifestIdentity) {
        throw invalidState('source update manifest candidate changed')
      }
      if (backup?.kind !== 'file' || backup.identity !== journal.originalManifestIdentity) {
        throw invalidState('source update manifest backup changed')
      }
      if (
        hashText(await this.fs.readFile(workspace.manifestCandidatePath)) !==
        journal.nextManifestHash
      ) {
        throw invalidState('next skills manifest content changed')
      }
      await this.fs.moveNoReplace(
        workspace.manifestBackupPath,
        workspace.manifestPath,
        journal.originalManifestIdentity,
      )
      return
    }
    if (current?.kind !== 'file' || current.identity !== journal.nextManifestIdentity) {
      throw invalidState('skills manifest no longer belongs to this source update')
    }
    if (backup?.kind !== 'file' || backup.identity !== journal.originalManifestIdentity) {
      throw invalidState('source update manifest backup changed')
    }
    if (candidate) throw invalidState('next skills manifest exists at two locations')
    if (hashText(await this.fs.readFile(workspace.manifestPath)) !== journal.nextManifestHash) {
      throw invalidState('next skills manifest content changed')
    }

    await this.fs.moveNoReplace(
      workspace.manifestPath,
      workspace.manifestCandidatePath,
      journal.nextManifestIdentity,
    )
    await this.fs.moveNoReplace(
      workspace.manifestBackupPath,
      workspace.manifestPath,
      journal.originalManifestIdentity,
    )
  }

  private async restoreCache(
    workspace: SourceUpdateWorkspace,
    journal: SourceFinalizeJournal,
  ): Promise<void> {
    await ensureSourceUpdateChildDirectory(this.fs, workspace.repoPath, 'remote-cache')
    let candidate = await inspectOptionalOwnedDirectory(
      this.fs,
      workspace.candidateDir,
      'source update candidate',
    )
    let live = await inspectOptionalOwnedDirectory(
      this.fs,
      workspace.liveCacheDir,
      'live source cache',
    )
    let backup = await inspectOptionalOwnedDirectory(
      this.fs,
      workspace.backupCacheDir,
      'source update cache backup',
    )

    let candidateDirectoryIdentity = journal.candidateDirectoryIdentity
    let liveCacheDirectoryIdentity = journal.liveCacheDirectoryIdentity
    if (!candidateDirectoryIdentity) {
      if (candidate) {
        const anchor = await assertCacheAnchorFile(
          this.fs,
          workspace.candidateDir,
          'source update candidate',
        )
        if (anchor.identity === journal.candidateAnchorIdentity) {
          candidateDirectoryIdentity = candidate.identity
        }
      }
      if (!candidateDirectoryIdentity && live) {
        const anchor = await assertCacheAnchorFile(
          this.fs,
          workspace.liveCacheDir,
          'live source cache',
        )
        if (anchor.identity === journal.candidateAnchorIdentity) {
          candidateDirectoryIdentity = live.identity
        }
      }
    }
    if (!candidateDirectoryIdentity) {
      throw invalidState('source update candidate directory identity is missing from journal')
    }
    if (journal.hadLiveCache && !liveCacheDirectoryIdentity) {
      if (!journal.liveCacheAnchorIdentity) {
        throw invalidState('live cache identity is missing from journal')
      }
      if (live) {
        const anchor = await assertCacheAnchorFile(
          this.fs,
          workspace.liveCacheDir,
          'live source cache',
        )
        if (anchor.identity === journal.liveCacheAnchorIdentity) {
          liveCacheDirectoryIdentity = live.identity
        }
      }
      if (!liveCacheDirectoryIdentity && backup) {
        const anchor = await assertCacheAnchorFile(
          this.fs,
          workspace.backupCacheDir,
          'source update cache backup',
        )
        if (anchor.identity === journal.liveCacheAnchorIdentity) {
          liveCacheDirectoryIdentity = backup.identity
        }
      }
    }

    if (candidate && candidate.identity !== candidateDirectoryIdentity) {
      throw invalidState('source update candidate identity changed')
    }
    if (
      live &&
      live.identity !== candidateDirectoryIdentity &&
      live.identity !== liveCacheDirectoryIdentity
    ) {
      throw invalidState('live source cache was replaced by another actor')
    }
    if (backup && backup.identity !== liveCacheDirectoryIdentity) {
      throw invalidState('source update cache backup identity changed')
    }
    if (candidate) {
      await assertStableCacheAnchorFile(
        this.fs,
        workspace.candidateDir,
        journal.candidateAnchorIdentity,
        'source update candidate',
      )
    }
    if (live?.identity === candidateDirectoryIdentity) {
      await assertStableCacheAnchorFile(
        this.fs,
        workspace.liveCacheDir,
        journal.candidateAnchorIdentity,
        'live source cache',
      )
    }
    if (live?.identity === liveCacheDirectoryIdentity && journal.liveCacheAnchorIdentity) {
      await assertStableCacheAnchorFile(
        this.fs,
        workspace.liveCacheDir,
        journal.liveCacheAnchorIdentity,
        'live source cache',
      )
    }
    if (backup && journal.liveCacheAnchorIdentity) {
      await assertStableCacheAnchorFile(
        this.fs,
        workspace.backupCacheDir,
        journal.liveCacheAnchorIdentity,
        'source update cache backup',
      )
    }

    if (live?.identity === candidateDirectoryIdentity) {
      if (candidate) throw invalidState('candidate cache exists at two locations')
      await this.fs.moveDirectoryAtomic(
        workspace.liveCacheDir,
        workspace.candidateDir,
        candidateDirectoryIdentity,
      )
      candidate = await inspectOptionalOwnedDirectory(
        this.fs,
        workspace.candidateDir,
        'restored source update candidate',
      )
      await assertStableCacheAnchorFile(
        this.fs,
        workspace.candidateDir,
        journal.candidateAnchorIdentity,
        'restored source update candidate',
      )
      live = null
    }

    if (journal.hadLiveCache) {
      if (!liveCacheDirectoryIdentity) {
        throw invalidState('live cache directory identity is missing from journal')
      }
      if (live?.identity === liveCacheDirectoryIdentity && backup) {
        throw invalidState('previous live cache exists at two locations')
      }
      if (!live) {
        if (!backup) throw invalidState('previous live cache cannot be recovered')
        await this.fs.moveDirectoryAtomic(
          workspace.backupCacheDir,
          workspace.liveCacheDir,
          liveCacheDirectoryIdentity,
        )
        live = await inspectOptionalOwnedDirectory(
          this.fs,
          workspace.liveCacheDir,
          'restored live source cache',
        )
        if (journal.liveCacheAnchorIdentity) {
          await assertStableCacheAnchorFile(
            this.fs,
            workspace.liveCacheDir,
            journal.liveCacheAnchorIdentity,
            'restored live source cache',
          )
        }
        backup = null
      } else if (live.identity !== liveCacheDirectoryIdentity) {
        throw invalidState('previous live source cache cannot be recovered')
      }
    } else {
      if (journal.liveCacheDirectoryIdentity || journal.liveCacheAnchorIdentity || backup) {
        throw invalidState('unexpected previous cache exists for a new source cache')
      }
      if (live) throw invalidState('new live source cache could not be rolled back')
    }

    void candidate
    void live
    void backup
  }

  private async removeOwnedPreservedDestinations(
    session: SourceUpdateSession,
    journal: SourceFinalizeJournal,
  ): Promise<void> {
    for (const artifact of journal.preservedDestinations) {
      if (artifact.ownerToken !== session.ownerToken) {
        throw invalidState(`preserved local skill owner mismatch: ${artifact.name}`)
      }
      assertLocalSkillId(artifact.name)
      const destination = join(session.repoPath, 'assets', 'skills', artifact.name)
      const current = await inspectOptionalOwnedDirectory(
        this.fs,
        destination,
        `preserved local skill ${artifact.name}`,
      )
      if (!current) continue
      const marker = await assertPreservedDestinationMarker(this.fs, destination, session, artifact)
      if (marker.identity !== artifact.identity) {
        throw invalidState(`preserved local skill was replaced: ${artifact.name}`)
      }
      await this.fs.removeEntryIfIdentity(destination, current.identity)
    }
  }

  private async removeStaleManifestArtifact(path: string): Promise<void> {
    const entry = await this.fs.inspectEntry(path)
    if (!entry) return
    if (entry.kind !== 'file') throw invalidState('source update manifest artifact is not a file')
    await this.fs.removeEntryIfIdentity(path, entry.identity)
  }
}

async function assertCacheAnchorFile(
  fs: SessionFileSystem,
  cachePath: string,
  description: string,
) {
  return assertRegularFile(fs, join(cachePath, '.git', 'HEAD'), `${description} metadata anchor`)
}

async function assertStableCacheAnchorFile(
  fs: SessionFileSystem,
  cachePath: string,
  identity: string,
  description: string,
): Promise<void> {
  const anchor = await assertCacheAnchorFile(fs, cachePath, description)
  if (anchor.identity !== identity) throw invalidState(`${description} identity changed`)
}

async function assertStableRegularFile(
  fs: SessionFileSystem,
  path: string,
  identity: string,
  description: string,
): Promise<void> {
  const entry = await assertRegularFile(fs, path, description)
  if (entry.identity !== identity) throw invalidState(`${description} identity changed`)
}

export function serializeSourceUpdatePreservedMarker(
  session: Pick<SourceUpdateSession, 'id' | 'ownerToken'>,
  skillId: string,
): string {
  assertLocalSkillId(skillId)
  return `${JSON.stringify({
    version: SOURCE_UPDATE_PRESERVED_MARKER_VERSION,
    sessionId: session.id,
    ownerToken: session.ownerToken,
    skillId,
  })}\n`
}

export function sourceUpdateBaseline(source: SkillSource): string {
  const stable = {
    ...(source.name ? { name: source.name } : {}),
    url: source.url,
    ref: source.ref,
    ...(source.type ? { type: source.type } : {}),
    ...(source.pinned_commit ? { pinned_commit: source.pinned_commit } : {}),
    members: (source.members ?? []).map(({ name, entry }) => ({ name, entry })),
    ...(source.resources ? { resources: source.resources } : {}),
  }
  return hashText(JSON.stringify(stable))
}

export function persistedMembers(
  source: SkillSource,
  scanned: ScannedSourceBundle[],
  enabledEntries: ReadonlySet<string> = new Set(),
): NonNullable<SkillSource['members']> {
  const previous = new Map((source.members ?? []).map((member) => [member.entry, member]))
  return scanned.flatMap(({ name, entry }) => {
    const member = previous.get(entry)
    if (!member && !enabledEntries.has(entry)) return []
    if (!member) return [{ name, entry }]
    return [{ name, entry, ...(member.agents ? { agents: member.agents } : {}) }]
  })
}

function persistedSession(session: SourceUpdateSession): PersistedSourceUpdateSession {
  return {
    version: SOURCE_UPDATE_SESSION_VERSION,
    id: session.id,
    ownerToken: session.ownerToken,
    sourceKey: session.sourceKey,
    rootIdentity: session.rootIdentity,
    sourceBaseline: session.sourceBaseline,
    source: session.source,
    newRef: session.newRef,
    pinned_commit: session.pinned_commit,
    newMembers: session.newMembers,
    changes: session.changes,
    resourceBoundaryChanges: session.resourceBoundaryChanges,
    pathMoves: session.pathMoves,
    ...(session.createdAt ? { createdAt: session.createdAt } : {}),
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    ...(session.finalize ? { finalize: session.finalize } : {}),
    ...(session.completed ? { completed: session.completed } : {}),
  }
}

function compareSessionAge(left: SourceUpdateSession, right: SourceUpdateSession): number {
  return (
    Date.parse(left.updatedAt!) - Date.parse(right.updatedAt!) ||
    Date.parse(left.createdAt!) - Date.parse(right.createdAt!) ||
    left.id.localeCompare(right.id, 'en')
  )
}

async function assertPhysicalDirectory(
  fs: SessionFileSystem,
  path: string,
  description: string,
): Promise<void> {
  const before = await fs.inspectEntry(path)
  if (before?.kind !== 'directory') throw invalidState(`${description} is not a physical directory`)
  let canonical: string
  try {
    canonical = await fs.realPath(path)
  } catch (error) {
    throw unavailable(`failed to resolve ${description}`, error)
  }
  const after = await fs.inspectEntry(path)
  if (
    after?.kind !== 'directory' ||
    after.identity !== before.identity ||
    normalize(canonical) !== normalize(path)
  ) {
    throw invalidState(`${description} escaped or changed during authorization`)
  }
}

function cloneSession(session: SourceUpdateSession): SourceUpdateSession {
  const cloneChanges = (changes: SourceUpdateSession['changes']['added']) =>
    changes.map((change) => ({
      ...change,
      ...(change.agents ? { agents: [...change.agents] } : {}),
    }))
  return {
    ...session,
    newMembers: session.newMembers.map((member) => ({ ...member })),
    changes: {
      added: cloneChanges(session.changes.added),
      updated: cloneChanges(session.changes.updated),
      removed: cloneChanges(session.changes.removed),
      unchanged: cloneChanges(session.changes.unchanged),
    },
    resourceBoundaryChanges: session.resourceBoundaryChanges.map((change) => ({ ...change })),
    pathMoves: session.pathMoves.map((move) => ({ ...move })),
    ...(session.finalize
      ? {
          finalize: {
            ...session.finalize,
            preservedDestinations: session.finalize.preservedDestinations.map((item) => ({
              ...item,
            })),
          },
        }
      : {}),
    ...(session.completed
      ? {
          completed: {
            preserved: [...session.completed.preserved],
            deleted: [...session.completed.deleted],
          },
        }
      : {}),
  }
}

function replaceSessionState(current: SourceUpdateSession, next: SourceUpdateSession): void {
  delete current.finalize
  delete current.completed
  Object.assign(current, next)
}

async function assertRegularFile(
  fs: Pick<IFileSystem, 'inspectEntry' | 'realPath'>,
  path: string,
  description: string,
): Promise<{ kind: 'file'; identity: string }> {
  const before = await fs.inspectEntry(path)
  if (before?.kind !== 'file') throw invalidState(`${description} is not a regular file`)
  let canonical: string
  try {
    canonical = await fs.realPath(path)
  } catch (error) {
    throw unavailable(`failed to resolve ${description}`, error)
  }
  const after = await fs.inspectEntry(path)
  if (
    after?.kind !== 'file' ||
    after.identity !== before.identity ||
    normalize(canonical) !== normalize(path)
  ) {
    throw invalidState(`${description} escaped or changed during authorization`)
  }
  return { kind: 'file', identity: after.identity }
}

async function assertPreservedDestinationMarker(
  fs: SessionFileSystem,
  destination: string,
  session: Pick<SourceUpdateSession, 'id' | 'ownerToken'>,
  artifact: PreservedDestinationOwnership,
): Promise<{ identity: string }> {
  const markerPath = join(destination, SOURCE_UPDATE_PRESERVED_MARKER)
  const before = await assertRegularFile(fs, markerPath, 'preserved local skill ownership marker')
  let raw: string
  try {
    raw = await fs.readFile(markerPath)
  } catch (error) {
    throw unavailable('failed to read preserved local skill ownership marker', error)
  }
  const after = await assertRegularFile(fs, markerPath, 'preserved local skill ownership marker')
  if (after.identity !== before.identity) {
    throw invalidState('preserved local skill ownership marker changed during recovery')
  }
  let marker: z.infer<typeof PreservedDestinationMarkerSchema>
  try {
    marker = PreservedDestinationMarkerSchema.parse(JSON.parse(raw))
  } catch (error) {
    throw invalidState('preserved local skill ownership marker is invalid', error)
  }
  if (
    marker.sessionId !== session.id ||
    marker.ownerToken !== session.ownerToken ||
    marker.ownerToken !== artifact.ownerToken ||
    marker.skillId !== artifact.name
  ) {
    throw invalidState(`preserved local skill ownership marker does not match: ${artifact.name}`)
  }
  return { identity: after.identity }
}

function isSafeRelativePath(path: string, allowEmpty: boolean): boolean {
  if (!path) return allowEmpty
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:\//.test(path)) return false
  const segments = path.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeSessionError(
  error: unknown,
  message: string,
  status: 422 | 500 = 500,
): SourceUpdateSessionError {
  if (error instanceof SourceUpdateSessionError) return error
  if (error instanceof SourceUpdateWorkspaceError) {
    return new SourceUpdateSessionError(error.code, error.status, error.message, { cause: error })
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return invalidState(message, error)
  }
  return new SourceUpdateSessionError(
    status === 422 ? 'invalid_update_session_state' : 'update_session_unavailable',
    status,
    message,
    { cause: error },
  )
}

function invalidState(message: string, cause?: unknown): SourceUpdateSessionError {
  return new SourceUpdateSessionError('invalid_update_session_state', 422, message, { cause })
}

function unavailable(message: string, cause: unknown): SourceUpdateSessionError {
  return new SourceUpdateSessionError('update_session_unavailable', 500, message, { cause })
}
