import { randomUUID } from 'node:crypto'
import type { SkillSource } from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import type { ScannedMember } from '../projection/scan.js'
import type { PreparedSourceUpdate } from '../remote/update.js'
import { logger } from '../lib/logger.js'
import { join } from 'node:path'

const sessionLogger = logger.child('source-update-session')

export interface SourceUpdateSession extends PreparedSourceUpdate {
  id: string
  repoPath: string
  source: SkillSource
  newRef: string
}

export class SourceUpdateSessionStore {
  private readonly sessions = new Map<string, SourceUpdateSession>()

  constructor(
    private readonly fs: Pick<IFileSystem, 'readFile' | 'writeFile' | 'removeDir' | 'removeFile'>,
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
    await this.fs.writeFile(this.sessionFile(session.repoPath, session.id), JSON.stringify(session))
    return session
  }

  async get(id: string, repoPath: string): Promise<SourceUpdateSession | undefined> {
    const current = this.sessions.get(id)
    if (current) return current
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
      await this.fs.removeDir(session.stagingDir)
      await this.fs.removeFile(this.sessionFile(session.repoPath, id))
    }
  }

  async prune(): Promise<void> {
    // Prepared content is retained until finalize; deleting it would lose the
    // only recoverable copy of members removed from the updated cache.
  }

  private sessionFile(repoPath: string, id: string): string {
    return join(repoPath, 'temp', 'source-updates', `${id}.json`)
  }
}

export function persistedMembers(
  source: SkillSource,
  scanned: ScannedMember[],
): NonNullable<SkillSource['members']> {
  const previous = new Map((source.members ?? []).map((member) => [member.name, member]))
  return scanned.map(({ name }) => {
    const member = previous.get(name)
    return {
      name,
      ...(member?.enabled !== undefined ? { enabled: member.enabled } : {}),
      ...(member?.targets ? { targets: member.targets } : {}),
    }
  })
}
