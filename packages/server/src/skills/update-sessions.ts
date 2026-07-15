import { randomUUID } from 'node:crypto'
import type { SkillSource } from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import type { PreparedSourceUpdate, ScannedSourceBundle } from '../remote/update.js'
import { logger } from '../lib/logger.js'
import { dirname, join } from 'node:path'

const sessionLogger = logger.child('source-update-session')

export interface SourceUpdateSession extends PreparedSourceUpdate {
  id: string
  repoPath: string
  source: SkillSource
  newRef: string
  finalize?: SourceFinalizeJournal
  completed?: { preserved: string[]; deleted: string[] }
}

export interface SourceFinalizeJournal {
  manifestPath: string
  originalManifest: string
  liveCacheDir: string
  backupCacheDir: string
  hadLiveCache: boolean
  rollbackProjectionRequired: boolean
  preservedDestinations: string[]
}

export class SourceUpdateSessionStore {
  private readonly sessions = new Map<string, SourceUpdateSession>()

  constructor(
    private readonly fs: Pick<
      IFileSystem,
      'readFile' | 'writeFile' | 'replaceFile' | 'exists' | 'move' | 'removeDir' | 'removeFile'
    >,
  ) {}

  async create(input: {
    repoPath: string
    source: SkillSource
    newRef: string
    prepared: PreparedSourceUpdate
  }): Promise<SourceUpdateSession> {
    const session = {
      ...input.prepared,
      id: randomUUID(),
      repoPath: input.repoPath,
      source: input.source,
      newRef: input.newRef,
    }
    this.sessions.set(session.id, session)
    await this.save(session)
    return session
  }

  async beginFinalize(session: SourceUpdateSession, journal: SourceFinalizeJournal): Promise<void> {
    session.finalize = journal
    await this.save(session)
  }

  async recoverFinalize(session: SourceUpdateSession): Promise<{ projectionRequired: boolean }> {
    const journal = session.finalize
    if (!journal) return { projectionRequired: false }

    try {
      for (const path of journal.preservedDestinations) await this.fs.removeDir(path)

      const candidateExists = await this.fs.exists(session.candidateDir)
      const liveExists = await this.fs.exists(journal.liveCacheDir)
      const backupExists = await this.fs.exists(journal.backupCacheDir)
      if (!candidateExists && liveExists) {
        await this.fs.move(journal.liveCacheDir, session.candidateDir)
      } else if (candidateExists && liveExists && backupExists) {
        await this.fs.removeDir(journal.liveCacheDir)
      }
      if (await this.fs.exists(journal.backupCacheDir)) {
        if (await this.fs.exists(journal.liveCacheDir))
          await this.fs.removeDir(journal.liveCacheDir)
        await this.fs.move(journal.backupCacheDir, journal.liveCacheDir)
      }

      const recoveryPath = `${journal.manifestPath}.source-update-recovery-${session.id}`
      await this.fs.writeFile(recoveryPath, journal.originalManifest)
      await this.fs.replaceFile(recoveryPath, journal.manifestPath)
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
    delete session.finalize
    await this.save(session)
  }

  async markCompleted(
    session: SourceUpdateSession,
    result: NonNullable<SourceUpdateSession['completed']>,
  ): Promise<void> {
    delete session.finalize
    session.completed = result
    await this.save(session)
  }

  async get(id: string, repoPath: string): Promise<SourceUpdateSession | undefined> {
    const current = this.sessions.get(id)
    if (current) return current.repoPath === repoPath ? current : undefined
    try {
      const session = JSON.parse(
        await this.fs.readFile(this.sessionFile(repoPath, id)),
      ) as SourceUpdateSession
      if (session.id !== id || session.repoPath !== repoPath) return undefined
      this.sessions.set(id, session)
      return session
    } catch (err) {
      sessionLogger.warn('source update session recovery failed', { err, sessionId: id, repoPath })
      return undefined
    }
  }

  delete(id: string): void {
    this.sessions.delete(id)
  }

  async discard(id: string): Promise<void> {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    if (session) {
      await this.fs.removeDir(dirname(session.stagingDir))
      await this.fs.removeFile(this.sessionFile(session.repoPath, id))
    }
  }

  async prune(): Promise<void> {
    // Prepared content is retained until finalize; deleting it would lose the
    // only recoverable copy of members removed from the updated cache.
  }

  private async save(session: SourceUpdateSession): Promise<void> {
    const target = this.sessionFile(session.repoPath, session.id)
    const temporary = `${target}.tmp`
    await this.fs.writeFile(temporary, JSON.stringify(session))
    await this.fs.replaceFile(temporary, target)
  }

  private sessionFile(repoPath: string, id: string): string {
    return join(repoPath, 'temp', 'source-updates', `${id}.json`)
  }
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
    return [{ name, entry, ...(member.targets ? { targets: member.targets } : {}) }]
  })
}
