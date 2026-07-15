import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { persistedMembers, SourceUpdateSessionStore } from '../../src/skills/update-sessions.js'

describe('SourceUpdateSessionStore', () => {
  const roots: string[] = []
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  )

  it('recovers a prepared session after the store is recreated', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'loom-update-session-'))
    roots.push(repoPath)
    const fs = new NodeFileSystem()
    const stagingDir = join(repoPath, 'temp', 'source-updates', 'staged')
    await fs.mkdir(stagingDir, true)
    const first = new SourceUpdateSessionStore(fs)
    const created = await first.create({
      repoPath,
      source: { url: 'https://example.test/skills.git', ref: 'main' },
      newRef: 'main',
      prepared: {
        pinned_commit: 'abc',
        stagingDir,
        candidateDir: join(repoPath, 'temp', 'source-updates', 'candidate'),
        newMembers: [],
        changes: { added: [], updated: [], removed: [{ name: 'old' }], unchanged: [] },
        resourceBoundaryChanges: [],
        pathMoves: [],
      },
    })

    const recovered = await new SourceUpdateSessionStore(fs).get(created.id, repoPath)
    expect(recovered).toMatchObject({ id: created.id, pinned_commit: 'abc', repoPath })
    expect(await fs.exists(stagingDir)).toBe(true)
    await expect(first.get(created.id, join(repoPath, 'other-repo'))).resolves.toBeUndefined()
  })

  it('restores manifest, cache, and preserved destinations after an interrupted finalize', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'loom-update-recovery-'))
    roots.push(repoPath)
    const fs = new NodeFileSystem()
    const sessionRoot = join(repoPath, 'temp', 'source-updates', 'prepared')
    const stagingDir = join(sessionRoot, 'previous')
    const candidateDir = join(sessionRoot, 'candidate')
    const liveCacheDir = join(repoPath, 'remote-cache', 'skills')
    const backupCacheDir = join(sessionRoot, 'live-backup')
    const manifestPath = join(repoPath, 'skills.yaml')
    const preservedDestination = join(repoPath, 'assets', 'skills', 'old-skill')
    await fs.mkdir(stagingDir, true)
    await fs.mkdir(candidateDir, true)
    await fs.writeFile(join(candidateDir, 'new.txt'), 'new')
    await fs.mkdir(liveCacheDir, true)
    await fs.writeFile(join(liveCacheDir, 'old.txt'), 'old')
    await fs.writeFile(manifestPath, 'sources: []\nskills: []\n')

    const first = new SourceUpdateSessionStore(fs)
    const created = await first.create({
      repoPath,
      source: { url: 'https://example.test/skills.git', ref: 'main' },
      newRef: 'next',
      prepared: {
        pinned_commit: 'next-commit',
        stagingDir,
        candidateDir,
        newMembers: [],
        changes: { added: [], updated: [], removed: [], unchanged: [] },
        resourceBoundaryChanges: [],
        pathMoves: [],
      },
    })
    await first.beginFinalize(created, {
      manifestPath,
      originalManifest: 'sources: []\nskills: []\n',
      liveCacheDir,
      backupCacheDir,
      hadLiveCache: true,
      rollbackProjectionRequired: true,
      preservedDestinations: [preservedDestination],
    })

    await fs.mkdir(preservedDestination, true)
    await fs.writeFile(join(preservedDestination, 'SKILL.md'), '# preserved')
    await fs.move(liveCacheDir, backupCacheDir)
    await fs.move(candidateDir, liveCacheDir)
    await fs.writeFile(manifestPath, 'sources:\n  - ref: next\nskills: []\n')

    const recoveredStore = new SourceUpdateSessionStore(fs)
    const recovered = await recoveredStore.get(created.id, repoPath)
    expect(recovered).toBeDefined()
    await expect(recoveredStore.recoverFinalize(recovered!)).resolves.toEqual({
      projectionRequired: true,
    })
    expect(await fs.readFile(manifestPath)).toBe('sources: []\nskills: []\n')
    expect(await fs.readFile(join(liveCacheDir, 'old.txt'))).toBe('old')
    expect(await fs.readFile(join(candidateDir, 'new.txt'))).toBe('new')
    expect(await fs.exists(preservedDestination)).toBe(false)

    await recoveredStore.completeFinalizeRecovery(recovered!)
    expect(
      (await new SourceUpdateSessionStore(fs).get(created.id, repoPath))?.finalize,
    ).toBeUndefined()
  })

  it('restores the live cache when finalize stops between the two cache moves', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'loom-update-cache-move-recovery-'))
    roots.push(repoPath)
    const fs = new NodeFileSystem()
    const sessionRoot = join(repoPath, 'temp', 'source-updates', 'prepared')
    const stagingDir = join(sessionRoot, 'previous')
    const candidateDir = join(sessionRoot, 'candidate')
    const liveCacheDir = join(repoPath, 'remote-cache', 'skills')
    const backupCacheDir = join(sessionRoot, 'live-backup')
    const manifestPath = join(repoPath, 'skills.yaml')
    await fs.mkdir(stagingDir, true)
    await fs.mkdir(candidateDir, true)
    await fs.writeFile(join(candidateDir, 'new.txt'), 'new')
    await fs.mkdir(liveCacheDir, true)
    await fs.writeFile(join(liveCacheDir, 'old.txt'), 'old')
    await fs.writeFile(manifestPath, 'sources: []\nskills: []\n')

    const store = new SourceUpdateSessionStore(fs)
    const session = await store.create({
      repoPath,
      source: { url: 'https://example.test/skills.git', ref: 'main' },
      newRef: 'next',
      prepared: {
        pinned_commit: 'next-commit',
        stagingDir,
        candidateDir,
        newMembers: [],
        changes: { added: [], updated: [], removed: [], unchanged: [] },
        resourceBoundaryChanges: [],
        pathMoves: [],
      },
    })
    await store.beginFinalize(session, {
      manifestPath,
      originalManifest: 'sources: []\nskills: []\n',
      liveCacheDir,
      backupCacheDir,
      hadLiveCache: true,
      rollbackProjectionRequired: true,
      preservedDestinations: [],
    })
    await fs.move(liveCacheDir, backupCacheDir)

    await expect(store.recoverFinalize(session)).resolves.toEqual({ projectionRequired: true })
    expect(await fs.readFile(join(liveCacheDir, 'old.txt'))).toBe('old')
    expect(await fs.readFile(join(candidateDir, 'new.txt'))).toBe('new')
  })

  it('moves a promoted candidate back when no previous live cache existed', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'loom-update-new-cache-recovery-'))
    roots.push(repoPath)
    const fs = new NodeFileSystem()
    const sessionRoot = join(repoPath, 'temp', 'source-updates', 'prepared')
    const stagingDir = join(sessionRoot, 'previous')
    const candidateDir = join(sessionRoot, 'candidate')
    const liveCacheDir = join(repoPath, 'remote-cache', 'skills')
    const manifestPath = join(repoPath, 'skills.yaml')
    await fs.mkdir(stagingDir, true)
    await fs.mkdir(candidateDir, true)
    await fs.writeFile(join(candidateDir, 'new.txt'), 'new')
    await fs.writeFile(manifestPath, 'sources: []\nskills: []\n')

    const store = new SourceUpdateSessionStore(fs)
    const session = await store.create({
      repoPath,
      source: { url: 'https://example.test/skills.git', ref: 'main' },
      newRef: 'next',
      prepared: {
        pinned_commit: 'next-commit',
        stagingDir,
        candidateDir,
        newMembers: [],
        changes: { added: [], updated: [], removed: [], unchanged: [] },
        resourceBoundaryChanges: [],
        pathMoves: [],
      },
    })
    await store.beginFinalize(session, {
      manifestPath,
      originalManifest: 'sources: []\nskills: []\n',
      liveCacheDir,
      backupCacheDir: join(sessionRoot, 'live-backup'),
      hadLiveCache: false,
      rollbackProjectionRequired: false,
      preservedDestinations: [],
    })
    await fs.move(candidateDir, liveCacheDir)

    await expect(store.recoverFinalize(session)).resolves.toEqual({ projectionRequired: false })
    expect(await fs.exists(liveCacheDir)).toBe(false)
    expect(await fs.readFile(join(candidateDir, 'new.txt'))).toBe('new')
  })
})

describe('persistedMembers', () => {
  it('keeps selected entries and does not auto-select newly discovered bundles', () => {
    expect(
      persistedMembers(
        {
          url: 'https://example.test/skills.git',
          ref: 'main',
          members: [{ name: 'old-name', entry: 'skills/selected/SKILL.md', targets: ['codex'] }],
        },
        [
          {
            name: 'renamed',
            entry: 'skills/selected/SKILL.md',
          },
          {
            name: 'new-bundle',
            entry: 'skills/new-bundle/SKILL.md',
          },
        ],
      ),
    ).toEqual([{ name: 'renamed', entry: 'skills/selected/SKILL.md', targets: ['codex'] }])
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
