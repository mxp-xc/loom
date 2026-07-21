import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import {
  SOURCE_UPDATE_PRESERVED_MARKER,
  persistedMembers,
  serializeSourceUpdatePreservedMarker,
  SourceUpdateSessionError,
  SourceUpdateSessionStore,
  type SourceUpdateSession,
} from '../../src/skills/update-sessions.js'

const sessionLog = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: vi.fn(() => sessionLog) },
}))

const ORIGINAL_MANIFEST = 'sources: []\nskills: []\n'
const NEXT_MANIFEST = 'sources:\n  - ref: next\nskills: []\n'

describe('SourceUpdateSessionStore', () => {
  const roots: string[] = []
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  )

  async function createRepo(prefix: string): Promise<string> {
    const repoPath = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    roots.push(repoPath)
    return repoPath
  }

  async function createSession(
    store: SourceUpdateSessionStore,
    fs: NodeFileSystem,
    repoPath: string,
    options: { withLiveCache?: boolean } = {},
  ): Promise<SourceUpdateSession> {
    const source = {
      url: 'https://example.test/skills.git',
      ref: 'main',
      pinned_commit: 'old-commit',
    }
    const workspace = await store.createWorkspace(repoPath, source.url)
    await fs.mkdir(join(workspace.candidateDir, '.git'), false)
    await fs.writeFile(join(workspace.candidateDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await fs.writeFile(join(workspace.candidateDir, 'new.txt'), 'new')
    await fs.writeFile(workspace.manifestPath, ORIGINAL_MANIFEST)
    if (options.withLiveCache) {
      await fs.mkdir(workspace.liveCacheDir, true)
      await fs.mkdir(join(workspace.liveCacheDir, '.git'), false)
      await fs.writeFile(join(workspace.liveCacheDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      await fs.writeFile(join(workspace.liveCacheDir, 'old.txt'), 'old')
    }
    return store.create({
      workspace,
      source,
      newRef: 'next',
      prepared: {
        pinned_commit: 'next-commit',
        newMembers: [],
        changes: { added: [], updated: [], removed: [{ name: 'old-skill' }], unchanged: [] },
        resourceBoundaryChanges: [],
        pathMoves: [],
      },
    })
  }

  it('recovers a versioned session without persisting authority paths', async () => {
    const repoPath = await createRepo('loom-update-session-')
    const fs = new NodeFileSystem()
    const first = new SourceUpdateSessionStore(fs)
    const created = await createSession(first, fs, repoPath)

    const persisted = JSON.parse(await fs.readFile(created.stateFile)) as Record<string, unknown>
    expect(persisted).toMatchObject({
      version: 1,
      id: created.id,
      pinned_commit: 'next-commit',
      rootIdentity: created.rootIdentity,
    })
    expect(persisted).not.toHaveProperty('repoPath')
    expect(persisted).not.toHaveProperty('stagingDir')
    expect(persisted).not.toHaveProperty('candidateDir')

    const recovered = await new SourceUpdateSessionStore(fs).get(created.id, repoPath)
    expect(recovered).toMatchObject({
      id: created.id,
      pinned_commit: 'next-commit',
      repoPath,
      stagingDir: created.stagingDir,
      candidateDir: created.candidateDir,
    })
    await expect(first.get(created.id, join(repoPath, 'other-repo'))).resolves.toBeUndefined()
  })

  it('restores only identity-bound manifest, cache, and preserved destinations', async () => {
    const repoPath = await createRepo('loom-update-recovery-')
    const fs = new NodeFileSystem()
    const first = new SourceUpdateSessionStore(fs)
    const created = await createSession(first, fs, repoPath, { withLiveCache: true })

    const preservedDestination = join(repoPath, 'assets', 'skills', 'old-skill')
    const preservedCandidate = join(repoPath, 'assets', 'skills', '.old-skill-candidate')
    await fs.mkdir(preservedCandidate, true)
    await fs.writeFile(join(preservedCandidate, 'SKILL.md'), '# preserved')
    await fs.writeFile(
      join(preservedCandidate, SOURCE_UPDATE_PRESERVED_MARKER),
      serializeSourceUpdatePreservedMarker(created, 'old-skill'),
    )
    const preservedEntry = await fs.inspectEntry(
      join(preservedCandidate, SOURCE_UPDATE_PRESERVED_MARKER),
    )
    expect(preservedEntry?.kind).toBe('file')
    await first.beginFinalize(created, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: true,
      rollbackProjectionRequired: true,
      preservedDestinations: [
        {
          name: 'old-skill',
          ownerToken: created.ownerToken,
          identity: preservedEntry!.identity,
        },
      ],
    })
    await fs.moveNoReplace(preservedCandidate, preservedDestination)
    await fs.moveDirectoryAtomic(
      created.liveCacheDir,
      created.backupCacheDir,
      created.finalize!.liveCacheDirectoryIdentity!,
    )
    await fs.moveDirectoryAtomic(
      created.candidateDir,
      created.liveCacheDir,
      created.finalize!.candidateDirectoryIdentity!,
    )
    await first.applyManifest(created)

    const recoveredStore = new SourceUpdateSessionStore(fs)
    const recovered = await recoveredStore.get(created.id, repoPath)
    expect(recovered).toBeDefined()
    await expect(recoveredStore.recoverFinalize(recovered!)).resolves.toEqual({
      projectionRequired: true,
    })
    expect(await fs.readFile(created.manifestPath)).toBe(ORIGINAL_MANIFEST)
    expect(await fs.readFile(join(created.liveCacheDir, 'old.txt'))).toBe('old')
    expect(await fs.readFile(join(created.candidateDir, 'new.txt'))).toBe('new')
    expect(await fs.inspectEntry(preservedDestination)).toBeNull()

    await recoveredStore.completeFinalizeRecovery(recovered!)
    expect(
      (await new SourceUpdateSessionStore(fs).get(created.id, repoPath))?.finalize,
    ).toBeUndefined()
  })

  it('restores the live cache when finalize stops between cache moves', async () => {
    const repoPath = await createRepo('loom-update-cache-move-recovery-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath, { withLiveCache: true })
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: true,
      rollbackProjectionRequired: true,
      preservedDestinations: [],
    })
    await fs.moveDirectoryAtomic(
      session.liveCacheDir,
      session.backupCacheDir,
      session.finalize!.liveCacheDirectoryIdentity!,
    )

    await expect(store.recoverFinalize(session)).resolves.toEqual({ projectionRequired: true })
    expect(await fs.readFile(join(session.liveCacheDir, 'old.txt'))).toBe('old')
    expect(await fs.readFile(join(session.candidateDir, 'new.txt'))).toBe('new')
  })

  it('recovers a legacy finalize journal by deriving directory identity from cache anchors', async () => {
    const repoPath = await createRepo('loom-update-legacy-finalize-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath, { withLiveCache: true })
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: true,
      rollbackProjectionRequired: true,
      preservedDestinations: [],
    })
    const persisted = JSON.parse(await fs.readFile(session.stateFile)) as {
      finalize: Record<string, unknown>
    }
    delete persisted.finalize.candidateDirectoryIdentity
    delete persisted.finalize.liveCacheDirectoryIdentity
    await fs.writeFile(session.stateFile, JSON.stringify(persisted))

    const restarted = new SourceUpdateSessionStore(fs)
    const recovered = await restarted.get(session.id, repoPath)

    await expect(restarted.recoverFinalize(recovered!)).resolves.toEqual({
      projectionRequired: true,
    })
    expect(await fs.readFile(join(session.liveCacheDir, 'old.txt'))).toBe('old')
    expect(await fs.readFile(join(session.candidateDir, 'new.txt'))).toBe('new')
  })

  it('journals and restores an existing corrupt cache instead of deleting it', async () => {
    const repoPath = await createRepo('loom-update-corrupt-cache-recovery-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    await fs.mkdir(session.liveCacheDir, true)
    await fs.writeFile(join(session.liveCacheDir, 'corrupt.txt'), 'keep')

    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: true,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    await fs.moveDirectoryAtomic(
      session.liveCacheDir,
      session.backupCacheDir,
      session.finalize!.liveCacheDirectoryIdentity!,
    )
    await fs.moveDirectoryAtomic(
      session.candidateDir,
      session.liveCacheDir,
      session.finalize!.candidateDirectoryIdentity!,
    )

    await expect(store.recoverFinalize(session)).resolves.toEqual({ projectionRequired: false })
    expect(await fs.readFile(join(session.liveCacheDir, 'corrupt.txt'))).toBe('keep')
    expect(await fs.readFile(join(session.candidateDir, 'new.txt'))).toBe('new')
  })

  it('does not move a live cache replacement that appears after the journal is saved', async () => {
    const repoPath = await createRepo('loom-update-cache-replacement-race-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath, { withLiveCache: true })
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: true,
      rollbackProjectionRequired: true,
      preservedDestinations: [],
    })
    await fs.removeDir(session.liveCacheDir)
    await fs.mkdir(session.liveCacheDir, true)
    await fs.writeFile(join(session.liveCacheDir, 'replacement.txt'), 'keep')

    await expect(
      fs.moveDirectoryAtomic(
        session.liveCacheDir,
        session.backupCacheDir,
        session.finalize!.liveCacheDirectoryIdentity!,
      ),
    ).rejects.toThrow('identity changed')

    expect(await fs.readFile(join(session.liveCacheDir, 'replacement.txt'))).toBe('keep')
    expect(await fs.inspectEntry(session.backupCacheDir)).toBeNull()
    await store.discard(session.id)
    expect(await fs.readFile(join(session.liveCacheDir, 'replacement.txt'))).toBe('keep')
  })

  it('resumes manifest recovery after rollback stops between its two moves', async () => {
    const repoPath = await createRepo('loom-update-manifest-recovery-restart-')
    const base = new NodeFileSystem()
    let failManifestRestore = false
    const fs = Object.assign(Object.create(base), base, {
      moveNoReplace: async (source: string, destination: string, identity?: string) => {
        if (
          failManifestRestore &&
          basename(source) === 'manifest.previous.yaml' &&
          basename(destination) === 'skills.yaml'
        ) {
          throw new Error('manifest restore interrupted')
        }
        return base.moveNoReplace(source, destination, identity)
      },
    }) as NodeFileSystem
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    await store.applyManifest(session)
    failManifestRestore = true

    await expect(store.recoverFinalize(session)).rejects.toThrow('manifest restore interrupted')
    expect(await base.inspectEntry(session.manifestPath)).toBeNull()
    expect(await base.readFile(session.manifestCandidatePath)).toBe(NEXT_MANIFEST)
    expect(await base.readFile(session.manifestBackupPath)).toBe(ORIGINAL_MANIFEST)

    const restarted = new SourceUpdateSessionStore(base)
    const recovered = await restarted.get(session.id, repoPath)
    await expect(restarted.recoverFinalize(recovered!)).resolves.toEqual({
      projectionRequired: false,
    })
    expect(await base.readFile(session.manifestPath)).toBe(ORIGINAL_MANIFEST)
    expect((await restarted.get(session.id, repoPath))?.finalize).toBeDefined()
  })

  it('moves a promoted candidate back when no previous live cache existed', async () => {
    const repoPath = await createRepo('loom-update-new-cache-recovery-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    await fs.move(session.candidateDir, session.liveCacheDir)

    await expect(store.recoverFinalize(session)).resolves.toEqual({ projectionRequired: false })
    expect(await fs.inspectEntry(session.liveCacheDir)).toBeNull()
    expect(await fs.readFile(join(session.candidateDir, 'new.txt'))).toBe('new')
  })

  it('rejects persisted path fields before they can authorize filesystem access', async () => {
    const repoPath = await createRepo('loom-update-malformed-')
    const sentinel = await createRepo('loom-update-sentinel-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    const persisted = JSON.parse(await fs.readFile(session.stateFile)) as Record<string, unknown>
    persisted.stagingDir = sentinel
    await fs.writeFile(session.stateFile, JSON.stringify(persisted))

    await expect(new SourceUpdateSessionStore(fs).get(session.id, repoPath)).rejects.toMatchObject({
      code: 'invalid_update_session_state',
      status: 422,
    })
    expect(await fs.inspectEntry(sentinel)).toMatchObject({ kind: 'directory' })
  })

  it('rejects a linked repository temp root without touching its target', async () => {
    const repoPath = await createRepo('loom-update-linked-temp-')
    const external = await createRepo('loom-update-linked-temp-target-')
    const sentinel = join(external, 'sentinel.txt')
    await writeFile(sentinel, 'keep')
    await symlink(
      external,
      join(repoPath, 'temp'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const store = new SourceUpdateSessionStore(new NodeFileSystem())

    await expect(
      store.createWorkspace(repoPath, 'https://example.test/skills.git'),
    ).rejects.toMatchObject({ code: 'invalid_update_session_state' })
    expect(await readFile(sentinel, 'utf8')).toBe('keep')
  })

  it('rejects a session root replaced by a link before reading persisted state', async () => {
    const repoPath = await createRepo('loom-update-linked-session-')
    const external = await createRepo('loom-update-linked-session-target-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    const relocated = join(external, 'relocated-session')
    await rename(session.sessionRoot, relocated)
    await symlink(relocated, session.sessionRoot, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(new SourceUpdateSessionStore(fs).get(session.id, repoPath)).rejects.toMatchObject({
      code: 'invalid_update_session_state',
    })
    expect(await readFile(join(relocated, 'session.json'), 'utf8')).toContain(session.id)
  })

  it('does not delete a user replacement at a recorded preserved destination', async () => {
    const repoPath = await createRepo('loom-update-preserved-replacement-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    const destination = join(repoPath, 'assets', 'skills', 'old-skill')
    const candidate = join(repoPath, 'assets', 'skills', '.old-skill-candidate')
    await fs.mkdir(candidate, true)
    await fs.writeFile(join(candidate, 'SKILL.md'), '# preserved')
    await fs.writeFile(
      join(candidate, SOURCE_UPDATE_PRESERVED_MARKER),
      serializeSourceUpdatePreservedMarker(session, 'old-skill'),
    )
    const installed = await fs.inspectEntry(join(candidate, SOURCE_UPDATE_PRESERVED_MARKER))
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [
        {
          name: 'old-skill',
          ownerToken: session.ownerToken,
          identity: installed!.identity,
        },
      ],
    })
    await fs.moveNoReplace(candidate, destination)
    await fs.removeDir(destination)
    await fs.mkdir(destination, true)
    await fs.writeFile(join(destination, 'SKILL.md'), '# user replacement')

    await expect(store.recoverFinalize(session)).rejects.toMatchObject({
      code: 'invalid_update_session_state',
    })
    expect(await fs.readFile(join(destination, 'SKILL.md'))).toBe('# user replacement')
  })

  it('preserves an identity-matching directory when its ownership marker is replaced', async () => {
    const repoPath = await createRepo('loom-update-preserved-marker-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    const destination = join(repoPath, 'assets', 'skills', 'old-skill')
    const candidate = join(repoPath, 'assets', 'skills', '.old-skill-candidate')
    await fs.mkdir(candidate, true)
    await fs.writeFile(join(candidate, 'SKILL.md'), '# preserved')
    await fs.writeFile(
      join(candidate, SOURCE_UPDATE_PRESERVED_MARKER),
      serializeSourceUpdatePreservedMarker(session, 'old-skill'),
    )
    const installed = await fs.inspectEntry(join(candidate, SOURCE_UPDATE_PRESERVED_MARKER))
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [
        {
          name: 'old-skill',
          ownerToken: session.ownerToken,
          identity: installed!.identity,
        },
      ],
    })
    await fs.moveNoReplace(candidate, destination)
    await fs.writeFile(
      join(destination, SOURCE_UPDATE_PRESERVED_MARKER),
      JSON.stringify({
        version: 1,
        sessionId: session.id,
        ownerToken: '00000000-0000-4000-8000-000000000000',
        skillId: 'old-skill',
      }),
    )

    await expect(store.recoverFinalize(session)).rejects.toMatchObject({
      code: 'invalid_update_session_state',
    })
    expect(await fs.readFile(join(destination, 'SKILL.md'))).toBe('# preserved')
  })

  it('keeps in-memory state unchanged when a transition cannot be persisted', async () => {
    const repoPath = await createRepo('loom-update-cow-')
    const base = new NodeFileSystem()
    let failStateReplace = false
    const fs = Object.assign(Object.create(base), base, {
      replaceFile: async (temporary: string, target: string) => {
        if (failStateReplace && basename(target) === 'session.json') throw new Error('save failed')
        return base.replaceFile(temporary, target)
      },
    }) as NodeFileSystem
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    failStateReplace = true

    await expect(
      store.beginFinalize(session, {
        originalManifest: ORIGINAL_MANIFEST,
        nextManifest: NEXT_MANIFEST,
        hadLiveCache: false,
        rollbackProjectionRequired: false,
        preservedDestinations: [],
      }),
    ).rejects.toThrow('save failed')
    expect(session.finalize).toBeUndefined()
  })

  it('keeps the finalize journal in memory and on disk when completion cannot be persisted', async () => {
    const repoPath = await createRepo('loom-update-completion-cow-')
    const base = new NodeFileSystem()
    let failStateReplace = false
    const fs = Object.assign(Object.create(base), base, {
      replaceFile: async (temporary: string, target: string) => {
        if (failStateReplace && basename(target) === 'session.json') throw new Error('save failed')
        return base.replaceFile(temporary, target)
      },
    }) as NodeFileSystem
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    failStateReplace = true

    await expect(store.markCompleted(session, { preserved: [], deleted: [] })).rejects.toThrow(
      'save failed',
    )
    expect(session.finalize).toBeDefined()
    expect(session.completed).toBeUndefined()
    const persisted = await new SourceUpdateSessionStore(base).get(session.id, repoPath)
    expect(persisted?.finalize).toBeDefined()
    expect(persisted?.completed).toBeUndefined()
  })

  it('prunes expired and completed sessions after restart but protects finalize recovery', async () => {
    const repoPath = await createRepo('loom-update-prune-restart-')
    const fs = new NodeFileSystem()
    let now = Date.parse('2026-07-19T00:00:00.000Z')
    const options = { now: () => new Date(now), ttlMs: 100 }
    const store = new SourceUpdateSessionStore(fs, options)
    const expired = await createSession(store, fs, repoPath)
    const completed = await createSession(store, fs, repoPath)
    await store.markCompleted(completed, { preserved: [], deleted: [] })
    const recovering = await createSession(store, fs, repoPath)
    await store.beginFinalize(recovering, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    now += 100

    const restarted = new SourceUpdateSessionStore(fs, options)
    await restarted.prune(repoPath)

    expect(await fs.inspectEntry(expired.sessionRoot)).toBeNull()
    expect(await fs.inspectEntry(completed.sessionRoot)).toBeNull()
    expect(await restarted.get(recovering.id, repoPath)).toMatchObject({
      id: recovering.id,
      finalize: expect.any(Object),
    })
  })

  it('prunes the oldest prepared sessions to the per-repository capacity', async () => {
    const repoPath = await createRepo('loom-update-prune-capacity-')
    const fs = new NodeFileSystem()
    let now = Date.parse('2026-07-19T00:00:00.000Z')
    const options = { now: () => new Date(now), ttlMs: Number.POSITIVE_INFINITY }
    const store = new SourceUpdateSessionStore(fs, options)
    const oldest = await createSession(store, fs, repoPath)
    now += 1
    const middle = await createSession(store, fs, repoPath)
    now += 1
    const newest = await createSession(store, fs, repoPath)

    await new SourceUpdateSessionStore(fs, { ...options, maxSessionsPerRepo: 2 }).prune(repoPath)

    expect(await fs.inspectEntry(oldest.sessionRoot)).toBeNull()
    expect(await fs.inspectEntry(middle.sessionRoot)).toMatchObject({ kind: 'directory' })
    expect(await fs.inspectEntry(newest.sessionRoot)).toMatchObject({ kind: 'directory' })
  })

  it('does not overwrite a same-content manifest replacement during recovery', async () => {
    const repoPath = await createRepo('loom-update-manifest-replacement-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    await store.beginFinalize(session, {
      originalManifest: ORIGINAL_MANIFEST,
      nextManifest: NEXT_MANIFEST,
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    await store.applyManifest(session)
    const replacement = join(repoPath, 'replacement.yaml')
    await writeFile(replacement, NEXT_MANIFEST)
    await rename(replacement, session.manifestPath)

    await expect(store.recoverFinalize(session)).rejects.toMatchObject({
      code: 'invalid_update_session_state',
    })
    expect(await fs.readFile(session.manifestPath)).toBe(NEXT_MANIFEST)
  })

  it('reports a missing state file in an owned session as invalid persisted state', async () => {
    const repoPath = await createRepo('loom-update-missing-state-')
    const fs = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(fs)
    const session = await createSession(store, fs, repoPath)
    await fs.removeFile(session.stateFile)

    await expect(new SourceUpdateSessionStore(fs).get(session.id, repoPath)).rejects.toMatchObject({
      code: 'invalid_update_session_state',
      status: 422,
    })
  })

  it('reports an unreadable workspace owner as an operational failure', async () => {
    const repoPath = await createRepo('loom-update-unreadable-owner-')
    const base = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(base)
    const session = await createSession(store, base, repoPath)
    const fs = Object.assign(Object.create(base), base, {
      readFile: async (path: string) => {
        if (path === session.ownerFile) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        return base.readFile(path)
      },
    }) as NodeFileSystem

    await expect(new SourceUpdateSessionStore(fs).get(session.id, repoPath)).rejects.toMatchObject({
      code: 'update_session_unavailable',
      status: 500,
    })
  })

  it('reports an unreadable persisted state as operational failure, not not-found', async () => {
    const repoPath = await createRepo('loom-update-unreadable-')
    const base = new NodeFileSystem()
    const store = new SourceUpdateSessionStore(base)
    const session = await createSession(store, base, repoPath)
    const fs = Object.assign(Object.create(base), base, {
      readFile: async (path: string) => {
        if (path === session.stateFile) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        return readFile(path, 'utf8')
      },
      writeFile: async (path: string, content: string) => writeFile(path, content, 'utf8'),
    }) as NodeFileSystem

    await expect(new SourceUpdateSessionStore(fs).get(session.id, repoPath)).rejects.toEqual(
      expect.objectContaining<Partial<SourceUpdateSessionError>>({
        code: 'update_session_unavailable',
        status: 500,
      }),
    )
  })
})

describe('persistedMembers', () => {
  it('keeps selected entries and does not auto-select newly discovered bundles', () => {
    expect(
      persistedMembers(
        {
          url: 'https://example.test/skills.git',
          ref: 'main',
          members: [{ name: 'old-name', entry: 'skills/selected/SKILL.md', agents: ['codex'] }],
        },
        [
          { name: 'renamed', entry: 'skills/selected/SKILL.md' },
          { name: 'new-bundle', entry: 'skills/new-bundle/SKILL.md' },
        ],
      ),
    ).toEqual([{ name: 'renamed', entry: 'skills/selected/SKILL.md', agents: ['codex'] }])
  })

  it('adds only newly discovered bundles explicitly enabled during boundary reconciliation', () => {
    expect(
      persistedMembers(
        { url: 'https://example.test/skills.git', ref: 'main', members: [] },
        [
          { name: 'enabled', entry: 'shared/enabled/SKILL.md' },
          { name: 'excluded', entry: 'shared/excluded/SKILL.md' },
        ],
        new Set(['shared/enabled/SKILL.md']),
      ),
    ).toEqual([{ name: 'enabled', entry: 'shared/enabled/SKILL.md' }])
  })
})
