import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import {
  addLocalSkill as addLocalSkillMutation,
  addSource as addSourceMutation,
  deriveRepoId,
  normalizeOrder,
  normalizeSourceResources,
  normalizeSkillGroupOrder,
  sameOrder,
  removeLocalSkill as removeLocalSkillMutation,
  removeSource as removeSourceMutation,
  LocalSkillIdSchema,
  LocalSkillSchema,
  SOURCE_NAME_REGEX,
  setLocalSkillAgents as setLocalSkillAgentsMutation,
  setSkillAgents as setSkillAgentsMutation,
  setSourceMembers as setSourceMembersMutation,
  setSourceMemberAgents as setSourceMemberAgentsMutation,
  updateSourceMeta as updateSourceMetaMutation,
  type AgentId,
  type LocalSkill,
  type SourceResources,
  type SourceTree,
  type SourceTreeNode,
  type SkillSource,
  type SkillsManifest,
} from '@loom/core'
import { logger } from '../lib/logger.js'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { LoggerPort } from '../ports/logger.js'
import {
  LOCAL_SKILL_SCAN_IGNORE,
  scanLocalSkills as scanLocalSkillDirs,
} from '../projection/scan.js'
import type { ScannedLocalSkill } from '../projection/scan.js'
import { readSkillsManifest, RepoManifestError, writeYaml } from '../api/repo-config.js'
import { classifySkillMemberChanges } from './reconciliation.js'
import { cacheDirFor } from '../remote/cache.js'
import { scanSourceTree } from '../remote/source-tree.js'
import {
  assertLocalSkillIdentifier,
  discoverBuiltInLocalSkills,
  indexRegisteredLocalSkills,
  LocalSkillBoundaryError,
  preflightBuiltInLocalSkill,
  prepareBuiltInLocalSkill,
  requireAvailableLocalSkill,
  resolveEffectiveLocalSkill,
  resolveLocalSkillRepositoryRoot,
  resolveRegisteredLocalSkill,
} from './local-paths.js'
import {
  combineLocalTransactionFailure,
  inspectLocalDirectorySnapshot,
  LocalDirectoryTransaction,
  normalizeLocalArchiveFiles,
  readPinnedLocalArchive,
  type LocalArchiveFile,
} from './local-directory-transaction.js'

const skillsLogger = logger.child('skills-application')

export class SkillsApplicationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SkillsApplicationError'
  }
}

export interface LocalSkillImport {
  name: string
  path: string
}

export interface LocalSkillWrite {
  name: string
  files: Array<{ path: string; content: string }>
}

export interface AddSourceCommand {
  name?: string
  url: string
  ref: string
  type?: 'branch' | 'tag'
  members?: Array<{ name: string; entry: string }>
  resources?: SourceResources
}

interface SourceMetaFields {
  url: string
  name?: string
  ref?: string
  type?: 'branch' | 'tag'
}

export interface ReconcileSourceCommand extends SourceMetaFields {
  expected_commit?: string
  members: Array<{ name: string; entry: string }>
  resources?: SourceResources
  preserve?: string[]
}

export interface SetSkillAgentsCommand {
  sourceUrl: string
  memberEntry: string
  agents: AgentId[]
}

export class SkillsApplication {
  constructor(
    private readonly fs: IFileSystem,
    private readonly git: IGit,
    private readonly home: string,
    private readonly log: LoggerPort = skillsLogger,
    private readonly projectSkills?: (repoPath: string) => Promise<void>,
  ) {}

  async scanLocalSkills(command: { dir: string; repoPath?: string }): Promise<ScannedLocalSkill[]> {
    let resolvedDir = command.dir.replace(/^~/, this.home)
    if (!isAbsolute(resolvedDir) && command.repoPath)
      resolvedDir = join(command.repoPath, resolvedDir)
    if (command.repoPath) {
      const canonicalRepo = await this.fs.realPath(command.repoPath)
      const builtInRoot = join(canonicalRepo, 'assets', 'skills')
      const requested = normalize(resolve(resolvedDir))
      const lexicalBuiltInRoot = normalize(resolve(command.repoPath, 'assets', 'skills'))
      if (requested === builtInRoot || requested === lexicalBuiltInRoot) {
        return (await discoverBuiltInLocalSkills(this.fs, command.repoPath)).map((skill) => ({
          name: skill.id,
          path: skill.directory,
        }))
      }
    }
    if (!(await this.fs.exists(resolvedDir))) return []
    return (
      await scanLocalSkillDirs(resolvedDir, { dot: true, ignore: LOCAL_SKILL_SCAN_IGNORE })
    ).filter((skill) => LocalSkillIdSchema.safeParse(skill.name).success)
  }

  async addLocalSkill(repoPath: string, skill: LocalSkill): Promise<{ skill: LocalSkill }> {
    const parsed = LocalSkillSchema.safeParse(skill)
    if (!parsed.success) {
      throw new LocalSkillBoundaryError(400, 'invalid_skill', 'Invalid local skill', {
        cause: parsed.error,
      })
    }
    const manifest = await this.readManifest(repoPath)
    if (indexRegisteredLocalSkills(manifest).has(parsed.data.id))
      throw alreadyExists(parsed.data.id)
    let candidate = parsed.data
    const resolved = await resolveRegisteredLocalSkill(
      this.fs,
      repoPath,
      { ...manifest, skills: [...manifest.skills, candidate] },
      candidate.id,
    )
    const available = requireAvailableLocalSkill(resolved, candidate.id)
    if (candidate.path) {
      const discovered = await resolveEffectiveLocalSkill(this.fs, repoPath, manifest, candidate.id)
      if (
        discovered?.provenance === 'discovered-built-in' &&
        discovered.available &&
        discovered.directory === available.directory
      ) {
        candidate = {
          id: candidate.id,
          ...(candidate.agents ? { agents: candidate.agents } : {}),
        }
      }
    }
    await this.writeManifest(repoPath, addLocalSkillMutation(manifest, candidate).data)
    return { skill: candidate }
  }

  async importLocalSkills(
    repoPath: string,
    command: { skills: LocalSkillImport[]; mode: 'move' | 'ref' },
  ): Promise<{ count: number }> {
    const manifest = await this.readManifest(repoPath)
    const registered = indexRegisteredLocalSkills(manifest)
    const names = command.skills.map((skill) => skill.name)
    assertUniqueLocalSkillNames(names)
    const resolved = [] as Array<{
      name: string
      source: ReturnType<typeof requireAvailableLocalSkill>
      manifestEntry: LocalSkill
    }>
    for (const skill of command.skills) {
      if (registered.has(skill.name)) throw alreadyExists(skill.name)
      const externalEntry = { id: skill.name, path: skill.path }
      const source = requireAvailableLocalSkill(
        await resolveRegisteredLocalSkill(
          this.fs,
          repoPath,
          { ...manifest, skills: [...manifest.skills, externalEntry] },
          skill.name,
        ),
        skill.name,
      )
      let manifestEntry: LocalSkill = { id: skill.name }
      if (command.mode === 'ref') {
        const discovered = await resolveEffectiveLocalSkill(this.fs, repoPath, manifest, skill.name)
        const isBuiltIn =
          discovered?.provenance === 'discovered-built-in' &&
          discovered.available &&
          discovered.directory === source.directory
        manifestEntry = isBuiltIn ? { id: skill.name } : { id: skill.name, path: source.directory }
      }
      resolved.push({ name: skill.name, source, manifestEntry })
    }

    const nextManifest = resolved.reduce(
      (current, skill) => addLocalSkillMutation(current, skill.manifestEntry).data,
      manifest,
    )
    if (command.mode === 'ref' || resolved.length === 0) {
      if (resolved.length > 0) await this.writeManifest(repoPath, nextManifest)
      return { count: command.skills.length }
    }

    const sources = [] as Array<{
      skill: (typeof resolved)[number]
      snapshot: Awaited<ReturnType<typeof inspectLocalDirectorySnapshot>>
    }>
    const sourceIdentities = new Set<string>()
    for (const skill of resolved) {
      if (!skill.source.directoryIdentity) {
        throw new LocalSkillBoundaryError(
          422,
          'invalid_local_skill_source',
          'Local skill source identity is unavailable',
        )
      }
      const sourceKey = `${skill.source.directoryIdentity}\0${skill.source.directory}`
      if (sourceIdentities.has(sourceKey)) {
        throw new LocalSkillBoundaryError(
          409,
          'local_skill_source_collision',
          'Local skill import contains the same source more than once',
        )
      }
      sourceIdentities.add(sourceKey)
      sources.push({
        skill,
        snapshot: await inspectLocalDirectorySnapshot(this.fs, {
          path: skill.source.directory,
          identity: skill.source.directoryIdentity,
        }),
      })
      await preflightBuiltInLocalSkill(this.fs, repoPath, skill.name)
    }
    const destinations = new Map(
      await Promise.all(
        resolved.map(
          async (skill) =>
            [skill.name, await prepareBuiltInLocalSkill(this.fs, repoPath, skill.name)] as const,
        ),
      ),
    )
    const root = destinations.values().next().value!.root
    const transaction = await LocalDirectoryTransaction.open(this.fs, root, this.log)
    let manifestAttempted = false
    try {
      for (const { skill, snapshot } of sources) {
        await transaction.stageMovedDirectory(destinations.get(skill.name)!, snapshot)
      }
      await transaction.apply()
      manifestAttempted = true
      await this.writeManifest(repoPath, nextManifest)
      await transaction.complete()
    } catch (err) {
      await this.failLocalTransaction(
        transaction,
        err,
        manifestAttempted ? () => this.writeManifest(repoPath, manifest) : undefined,
      )
    }
    return { count: command.skills.length }
  }

  async writeLocalSkills(
    repoPath: string,
    command: { skills: LocalSkillWrite[] },
  ): Promise<{ count: number }> {
    const manifest = await this.readManifest(repoPath)
    const registered = indexRegisteredLocalSkills(manifest)
    const names = command.skills.map((skill) => skill.name)
    assertUniqueLocalSkillNames(names)
    const archives = [] as Array<{
      name: string
      files: LocalArchiveFile[]
    }>
    for (const skill of command.skills) {
      if (registered.has(skill.name)) throw alreadyExists(skill.name)
      archives.push({
        name: skill.name,
        files: normalizeLocalArchiveFiles(Array.isArray(skill.files) ? skill.files : []),
      })
      await preflightBuiltInLocalSkill(this.fs, repoPath, skill.name)
    }
    if (archives.length === 0) return { count: 0 }
    const nextManifest = archives.reduce(
      (current, skill) => addLocalSkillMutation(current, { id: skill.name }).data,
      manifest,
    )
    const destinations = new Map(
      await Promise.all(
        archives.map(
          async (skill) =>
            [skill.name, await prepareBuiltInLocalSkill(this.fs, repoPath, skill.name)] as const,
        ),
      ),
    )
    const root = destinations.values().next().value!.root
    const transaction = await LocalDirectoryTransaction.open(this.fs, root, this.log)
    let manifestAttempted = false
    try {
      for (const skill of archives) {
        await transaction.stageArchive(destinations.get(skill.name)!, skill.files)
      }
      await transaction.apply()
      manifestAttempted = true
      await this.writeManifest(repoPath, nextManifest)
      await transaction.complete()
    } catch (err) {
      await this.failLocalTransaction(
        transaction,
        err,
        manifestAttempted ? () => this.writeManifest(repoPath, manifest) : undefined,
      )
    }
    return { count: command.skills.length }
  }

  async addSource(repoPath: string, command: AddSourceCommand): Promise<{ source: SkillSource }> {
    const manifest = await this.readManifest(repoPath)
    const sourceName = normalizeSourceName(command.name) || deriveRepoId(command.url)
    assertValidSourceName(sourceName)
    assertUniqueSource(manifest, { url: command.url, name: sourceName })
    const cacheId = deriveRepoId(command.url)
    assertUniqueCacheId(manifest, cacheId)
    const cacheDir = cacheDirFor(repoPath, cacheId)
    assertNoResourceActionConflicts(command.resources)
    const resources = normalizeSourceResources(command.resources)
    const candidate = await this.prepareSourceCandidate(
      repoPath,
      command.url,
      command.ref,
      sourceName,
    )
    const backupDir = join(candidate.rootDir, 'previous-cache')
    let cacheBackedUp = false
    let cacheSwapped = false
    let retainCandidateRoot = false
    let candidateCleanupHandled = false
    try {
      validateSourceSelection(candidate.sourceTree, command.members ?? [], resources)
      if (await this.fs.exists(cacheDir)) {
        await this.fs.move(cacheDir, backupDir)
        cacheBackedUp = true
      }
      await this.fs.move(candidate.candidateDir, cacheDir)
      cacheSwapped = true
      const currentManifest = await this.readManifest(repoPath)
      assertUniqueSource(currentManifest, { url: command.url, name: sourceName })
      assertUniqueCacheId(currentManifest, cacheId)
      const result = addSourceMutation(currentManifest, {
        name: sourceName,
        url: command.url,
        ref: command.ref,
        pinned_commit: candidate.sourceTree.commit,
        ...(command.type === 'branch' || command.type === 'tag' ? { type: command.type } : {}),
        ...(command.members ? { members: command.members } : {}),
        ...(command.resources ? { resources } : {}),
      })
      await this.writeManifest(repoPath, result.data)
      return { source: result.data.sources[result.data.sources.length - 1]! }
    } catch (err) {
      this.log.error('source installation or manifest write failed', { err, url: command.url })
      const rollbackFailures: unknown[] = []
      if (cacheSwapped) {
        try {
          await this.fs.removeDir(cacheDir)
        } catch (cleanupError) {
          retainCandidateRoot = true
          rollbackFailures.push(cleanupError)
          this.log.error('failed to remove candidate cache after add failure', {
            err: cleanupError,
            url: command.url,
            cacheDir,
          })
        }
      }
      if (cacheBackedUp) {
        try {
          await this.fs.move(backupDir, cacheDir)
        } catch (restoreError) {
          retainCandidateRoot = true
          rollbackFailures.push(restoreError)
          this.log.error('failed to restore source cache after add failure', {
            err: restoreError,
            url: command.url,
            cacheDir,
          })
        }
      }
      if (!retainCandidateRoot) {
        const cleanupError = await this.removeCandidateRoot(candidate.rootDir, command.url)
        candidateCleanupHandled = true
        if (cleanupError) rollbackFailures.push(cleanupError)
      }
      throw combineLocalTransactionFailure(err, rollbackFailures)
    } finally {
      if (!retainCandidateRoot && !candidateCleanupHandled) {
        await this.removeCandidateRoot(candidate.rootDir, command.url)
      }
    }
  }

  async removeSource(repoPath: string, url: string): Promise<void> {
    await this.updateManifest(repoPath, (manifest) => removeSourceMutation(manifest, url))
  }

  async reconcileSource(repoPath: string, command: ReconcileSourceCommand) {
    const manifest = await this.readManifest(repoPath)
    let originalManifest = structuredClone(manifest)
    const source = manifest.sources.find((item) => item.url === command.url)
    if (!source) throw sourceNotFound(command.url)
    const desiredSourceName = normalizeSourceName(command.name) || effectiveSourceName(source)
    if (command.name !== undefined) {
      assertValidSourceName(desiredSourceName)
      assertUniqueSource(manifest, {
        url: command.url,
        name: desiredSourceName,
        existingUrl: command.url,
      })
    }
    assertNoResourceActionConflicts(command.resources)
    const requestedResources = normalizeSourceResources(command.resources ?? source.resources)
    const cacheDir = cacheDirFor(repoPath, deriveRepoId(source.url))
    const cacheExists = await this.fs.exists(cacheDir)
    const refUnchanged =
      (command.ref ?? source.ref) === source.ref &&
      (command.type ?? source.type ?? 'branch') === (source.type ?? 'branch')
    const expectedCommit = command.expected_commit?.trim()
    let candidate: { rootDir?: string; candidateDir: string; sourceTree: SourceTree }
    if (refUnchanged) {
      if (!cacheExists) throw sourceCacheUnavailable(source.url)
      try {
        const liveCandidate = {
          candidateDir: cacheDir,
          sourceTree: await scanSourceTree(
            this.git,
            cacheDir,
            source.pinned_commit?.trim() || source.ref,
            { ...source, name: desiredSourceName },
          ),
        }
        candidate =
          expectedCommit && liveCandidate.sourceTree.commit !== expectedCommit
            ? await this.prepareSourceCandidate(
                repoPath,
                source.url,
                command.ref ?? source.ref,
                desiredSourceName,
              )
            : liveCandidate
      } catch (err) {
        this.log.error('pinned source cache scan failed', {
          err,
          url: source.url,
          commit: source.pinned_commit,
        })
        throw sourceCacheUnavailable(source.url)
      }
    } else {
      candidate = await this.prepareSourceCandidate(
        repoPath,
        source.url,
        command.ref ?? source.ref,
        desiredSourceName,
      )
    }
    const backupDir = candidate.rootDir ? join(candidate.rootDir, 'previous-cache') : ''
    let localTransaction: LocalDirectoryTransaction | undefined
    let manifestWritten = false
    let cacheBackedUp = false
    let cacheSwapped = false
    let retainCandidateRoot = false
    try {
      if (expectedCommit && candidate.sourceTree.commit !== expectedCommit) {
        throw sourceCommitChanged(expectedCommit, candidate.sourceTree.commit)
      }
      const resources = requestedResources
      validateSourceSelection(candidate.sourceTree, command.members, resources, source.resources)
      const changes = await classifySkillMemberChanges(
        this.fs,
        cacheDir,
        candidate.candidateDir,
        (source.members ?? []).map((member) => ({
          name: member.name,
          path: member.entry,
          entry: member.entry,
          agents: member.agents,
        })),
        command.members.map((member) => ({
          name: member.name,
          path: member.entry,
          entry: member.entry,
        })),
      )
      if (changes.removed.length > 0 && command.preserve === undefined) {
        return { finalized: false, changes }
      }
      const preserve = command.preserve ?? []
      assertUniqueLocalSkillNames(preserve)
      if (preserve.some((name) => !changes.removed.some((member) => member.name === name))) {
        throw new SkillsApplicationError(400, 'invalid_preserve_members', '保留列表包含无效 skill')
      }
      const currentManifest = await this.readManifest(repoPath)
      const currentSource = currentManifest.sources.find((item) => item.url === command.url)
      if (!currentSource) throw sourceNotFound(command.url)
      originalManifest = structuredClone(currentManifest)
      const preservedArchives: Array<{
        name: string
        agents?: AgentId[]
        files: LocalArchiveFile[]
      }> = []
      const repository = await resolveLocalSkillRepositoryRoot(this.fs, repoPath)
      for (const name of preserve) {
        if (currentManifest.skills.some((skill) => skill.id === name)) throw alreadyExists(name)
        const previous = currentSource.members?.find((member) => member.name === name)
        const skillFile = previous?.entry
        if (!skillFile) throw new SkillsApplicationError(400, 'invalid_member_entry', name)
        await preflightBuiltInLocalSkill(this.fs, repoPath, name)
        preservedArchives.push({
          name,
          ...(previous.agents ? { agents: previous.agents } : {}),
          files: await readPinnedLocalArchive(
            this.fs,
            this.git,
            repository,
            currentSource,
            skillFile,
          ),
        })
      }
      if (preservedArchives.length > 0) {
        const destinations = new Map(
          await Promise.all(
            preservedArchives.map(
              async (skill) =>
                [
                  skill.name,
                  await prepareBuiltInLocalSkill(this.fs, repoPath, skill.name),
                ] as const,
            ),
          ),
        )
        localTransaction = await LocalDirectoryTransaction.open(
          this.fs,
          destinations.values().next().value!.root,
          this.log,
        )
        for (const skill of preservedArchives) {
          await localTransaction.stageArchive(destinations.get(skill.name)!, skill.files)
        }
        await localTransaction.apply()
      }
      for (const skill of preservedArchives) {
        currentManifest.skills.push({
          id: skill.name,
          ...(skill.agents ? { agents: skill.agents } : {}),
        })
      }
      const liveCacheMatchesCandidate =
        candidate.candidateDir === cacheDir ||
        (cacheExists && source.pinned_commit === candidate.sourceTree.commit)
      if (!liveCacheMatchesCandidate) {
        if (cacheExists) {
          await this.fs.move(cacheDir, backupDir)
          cacheBackedUp = true
        }
        await this.fs.move(candidate.candidateDir, cacheDir)
        cacheSwapped = true
      }
      const metaUpdates = updateSourceMetaMutation(currentManifest, command.url, {
        ...(command.name !== undefined ? { name: command.name } : {}),
        ...(command.ref !== undefined ? { ref: command.ref } : {}),
        ...(command.type !== undefined ? { type: command.type } : {}),
      }).data
      const next = setSourceMembersMutation(metaUpdates, command.url, command.members).data
      const sourceIndex = next.sources.findIndex((item) => item.url === command.url)
      next.sources[sourceIndex] = {
        ...next.sources[sourceIndex],
        pinned_commit: candidate.sourceTree.commit,
        resources,
      }
      await this.writeManifest(repoPath, next)
      manifestWritten = true
      await this.projectSkills?.(repoPath)
      await localTransaction?.complete()
      return { finalized: true, changes, preserved: preserve }
    } catch (err) {
      this.log.error('source reconciliation failed', { err, url: command.url })
      const rollbackFailures: unknown[] = []
      if (cacheSwapped) {
        try {
          await this.fs.removeDir(cacheDir)
        } catch (cleanupError) {
          retainCandidateRoot = true
          rollbackFailures.push(cleanupError)
          this.log.error('source reconciliation candidate cleanup failed', {
            err: cleanupError,
            url: command.url,
            cacheDir,
          })
        }
      }
      if (cacheBackedUp) {
        try {
          await this.fs.move(backupDir, cacheDir)
        } catch (restoreError) {
          retainCandidateRoot = true
          rollbackFailures.push(restoreError)
          this.log.error('source reconciliation cache rollback failed', {
            err: restoreError,
            url: command.url,
            cacheDir,
          })
        }
      }
      if (manifestWritten) {
        try {
          await this.writeManifest(repoPath, originalManifest)
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
          this.log.error('source reconciliation manifest rollback failed', {
            err: rollbackError,
            url: command.url,
          })
        }
        try {
          await this.projectSkills?.(repoPath)
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
          this.log.error('source reconciliation projection rollback failed', {
            err: rollbackError,
            url: command.url,
          })
        }
      }
      if (localTransaction) rollbackFailures.push(...(await localTransaction.rollback()))
      throw combineLocalTransactionFailure(err, rollbackFailures)
    } finally {
      if (candidate.rootDir && !retainCandidateRoot) {
        await this.removeCandidateRoot(candidate.rootDir, command.url)
      }
    }
  }

  async removeLocalSkill(repoPath: string, id: string): Promise<void> {
    assertLocalSkillIdentifier(id)
    const manifest = await this.readManifest(repoPath)
    const existing = indexRegisteredLocalSkills(manifest).get(id)
    if (!existing) throw localSkillNotFound(id)
    const result = removeLocalSkillMutation(manifest, id)
    if (existing.path) {
      await this.writeManifest(repoPath, result.data)
      return
    }
    const resolved = await resolveRegisteredLocalSkill(this.fs, repoPath, manifest, id)
    if (!resolved?.available) {
      await this.writeManifest(repoPath, result.data)
      return
    }
    if (!resolved.builtInRoot) {
      throw new LocalSkillBoundaryError(
        422,
        'invalid_local_skill_path',
        'Built-in local skill ownership is unavailable',
      )
    }
    const transaction = await LocalDirectoryTransaction.open(
      this.fs,
      resolved.builtInRoot,
      this.log,
    )
    let manifestAttempted = false
    try {
      await transaction.stageRemoval(resolved)
      await transaction.apply()
      manifestAttempted = true
      await this.writeManifest(repoPath, result.data)
      await transaction.complete()
    } catch (err) {
      await this.failLocalTransaction(
        transaction,
        err,
        manifestAttempted ? () => this.writeManifest(repoPath, manifest) : undefined,
      )
    }
  }

  async setSkillAgents(repoPath: string, command: SetSkillAgentsCommand): Promise<void> {
    const result = await this.updateManifest(repoPath, (manifest) =>
      setSkillAgentsMutation(manifest, command.sourceUrl, command.memberEntry, command.agents),
    )
    if (!result.changed) throw sourceNotFound(command.sourceUrl)
  }

  async setSourceMemberAgents(
    repoPath: string,
    sourceUrl: string,
    updates: Array<{ memberEntry: string; agents: AgentId[] }>,
  ): Promise<void> {
    const memberUpdates = updates.map((update) => ({
      memberEntry: String(update?.memberEntry ?? ''),
      agents: Array.isArray(update?.agents) ? update.agents : [],
    }))
    const result = await this.updateManifest(repoPath, (manifest) =>
      setSourceMemberAgentsMutation(manifest, sourceUrl, memberUpdates),
    )
    if (!result.changed) throw sourceNotFound(sourceUrl)
  }

  async setLocalSkillAgents(repoPath: string, id: string, agents: AgentId[]): Promise<void> {
    assertLocalSkillIdentifier(id)
    const manifest = await this.readManifest(repoPath)
    const registered = indexRegisteredLocalSkills(manifest).get(id)
    const result = registered
      ? setLocalSkillAgentsMutation(manifest, id, agents)
      : addLocalSkillMutation(manifest, {
          id: requireAvailableLocalSkill(
            await resolveEffectiveLocalSkill(this.fs, repoPath, manifest, id),
            id,
          ).id,
          agents,
        })
    if (!result.changed) throw localSkillNotFound(id)
    await this.writeManifest(repoPath, result.data)
  }

  async reorderGroups(repoPath: string, ids: string[]): Promise<{ ids: string[] }> {
    const manifest = await this.readManifest(repoPath)
    assertUniqueSourceUrls(manifest)
    const current = normalizeSkillGroupOrder(manifest)
    const next = normalizeOrder(ids, current)
    if (!sameOrder(current, next)) {
      await this.writeManifest(repoPath, { ...manifest, group_order: next })
    }
    return { ids: next }
  }

  private async readManifest(repoPath: string): Promise<SkillsManifest> {
    try {
      const manifest = await readSkillsManifest(this.fs, repoPath)
      indexRegisteredLocalSkills(manifest)
      return manifest
    } catch (error) {
      if (error instanceof RepoManifestError)
        throw new SkillsApplicationError(422, 'invalid_skills_manifest', error.message)
      throw error
    }
  }

  private async prepareSourceCandidate(
    repoPath: string,
    url: string,
    ref: string,
    sourceName: string,
  ): Promise<{ rootDir: string; candidateDir: string; sourceTree: SourceTree }> {
    const rootDir = join(repoPath, 'temp', 'source-edits', randomUUID())
    const candidateDir = join(rootDir, 'candidate')
    try {
      await this.git.clone(url, candidateDir, false)
      await this.git.checkout(candidateDir, ref)
      const sourceTree = await scanSourceTree(this.git, candidateDir, 'HEAD', {
        name: sourceName,
        url,
      })
      return { rootDir, candidateDir, sourceTree }
    } catch (err) {
      this.log.error('source candidate preparation failed', { err, url, ref })
      const cleanupError = await this.removeCandidateRoot(rootDir, url)
      throw combineLocalTransactionFailure(err, cleanupError ? [cleanupError] : [])
    }
  }

  private async removeCandidateRoot(rootDir: string, url: string): Promise<unknown | undefined> {
    try {
      await this.fs.removeDir(rootDir)
      return undefined
    } catch (err) {
      this.log.error('failed to clean source candidate', { err, url, rootDir })
      return err
    }
  }

  private async writeManifest(repoPath: string, manifest: SkillsManifest): Promise<void> {
    await writeYaml(this.fs, this.skillsYamlPath(repoPath), {
      ...manifest,
      group_order: normalizeSkillGroupOrder(manifest),
    })
  }

  private async updateManifest(
    repoPath: string,
    mutate: (manifest: SkillsManifest) => { changed: boolean; data: SkillsManifest },
  ): Promise<{ changed: boolean; data: SkillsManifest }> {
    const result = mutate(await this.readManifest(repoPath))
    if (result.changed) await this.writeManifest(repoPath, result.data)
    return result
  }

  private skillsYamlPath(repoPath: string): string {
    return join(repoPath, 'skills.yaml')
  }

  private async failLocalTransaction(
    transaction: LocalDirectoryTransaction,
    primary: unknown,
    rollbackState?: () => Promise<void>,
  ): Promise<never> {
    this.log.error('local skill transaction failed', { err: primary })
    const rollbackFailures: unknown[] = []
    if (rollbackState) {
      try {
        await rollbackState()
      } catch (err) {
        rollbackFailures.push(err)
        this.log.error('failed to roll back local skill manifest', { err })
      }
    }
    rollbackFailures.push(...(await transaction.rollback()))
    throw combineLocalTransactionFailure(primary, rollbackFailures)
  }
}

function validateSourceSelection(
  sourceTree: SourceTree,
  members: readonly { name: string; entry: string }[],
  resources: SourceResources,
  previousResources?: SourceResources,
): void {
  if (sourceTree.diagnostics.length > 0) {
    throw new SkillsApplicationError(
      422,
      'invalid_source_tree',
      sourceTree.diagnostics.map(({ message }) => message).join('; '),
    )
  }
  const bundles = new Map<string, string>()
  const selectableResources = new Map<string, 'file' | 'directory'>()
  for (const node of sourceTree.nodes) collectSelectableNodes(node, bundles, selectableResources)
  const memberNames = new Set<string>()
  const memberEntries = new Set<string>()
  for (const member of members) {
    if (
      !SOURCE_NAME_REGEX.test(member.name) ||
      memberNames.has(member.name) ||
      memberEntries.has(member.entry) ||
      bundles.get(member.entry) !== member.name
    ) {
      throw new SkillsApplicationError(
        400,
        'invalid_member_selection',
        `Selected skill bundle does not exist: ${member.entry}`,
      )
    }
    memberNames.add(member.name)
    memberEntries.add(member.entry)
  }
  for (const action of ['include', 'exclude'] as const) {
    const previousRules = new Set(
      (previousResources?.[action] ?? []).map((rule) => `${rule.path}\0${rule.kind}`),
    )
    for (const rule of resources[action]) {
      if (
        selectableResources.get(rule.path) !== rule.kind &&
        !previousRules.has(`${rule.path}\0${rule.kind}`)
      ) {
        throw new SkillsApplicationError(
          400,
          'invalid_resource_selection',
          `Selected ${rule.kind} resource does not exist: ${rule.path}`,
        )
      }
    }
  }
}

function assertNoResourceActionConflicts(resources?: SourceResources): void {
  if (!resources) return
  const included = new Set(resources.include.map((rule) => rule.path))
  const conflict = resources.exclude.find((rule) => included.has(rule.path))
  if (conflict) {
    throw new SkillsApplicationError(
      400,
      'invalid_resource_selection',
      `Resource path cannot be both included and excluded: ${conflict.path}`,
    )
  }
}

function collectSelectableNodes(
  node: SourceTreeNode,
  bundles: Map<string, string>,
  resources: Map<string, 'file' | 'directory'>,
): { hasResource: boolean; unsafeDirectory: boolean } {
  if (node.kind === 'bundle') {
    bundles.set(node.entry, node.name)
    return { hasResource: false, unsafeDirectory: false }
  }
  if (node.kind === 'resource') {
    resources.set(node.path, 'file')
    return { hasResource: true, unsafeDirectory: false }
  }
  if (node.kind === 'symlink' || node.kind === 'submodule') {
    return { hasResource: false, unsafeDirectory: true }
  }
  const children = node.children.map((child) => collectSelectableNodes(child, bundles, resources))
  const hasResource = children.some((child) => child.hasResource)
  const unsafeDirectory = children.some((child) => child.unsafeDirectory)
  if (hasResource && !unsafeDirectory) resources.set(node.path, 'directory')
  return { hasResource, unsafeDirectory }
}

function assertUniqueLocalSkillNames(names: string[]): void {
  const seen = new Set<string>()
  for (const name of names) {
    assertLocalSkillIdentifier(name)
    if (seen.has(name)) throw alreadyExists(name)
    seen.add(name)
  }
}

function alreadyExists(skillName: string): SkillsApplicationError {
  return new SkillsApplicationError(
    409,
    'already_exists',
    `Skill \`${skillName}\` already exists in assets/skills`,
  )
}

function sourceNotFound(url: string): SkillsApplicationError {
  return new SkillsApplicationError(404, 'not_found', `Source ${url} not found`)
}

function localSkillNotFound(id: string): SkillsApplicationError {
  return new SkillsApplicationError(404, 'local_skill_not_found', `Local skill ${id} not found`)
}

function sourceCommitChanged(expectedCommit: string, actualCommit: string): SkillsApplicationError {
  return new SkillsApplicationError(
    409,
    'source_commit_changed',
    `Source changed from ${expectedCommit} to ${actualCommit}; refresh and retry`,
  )
}

function sourceCacheUnavailable(url: string): SkillsApplicationError {
  return new SkillsApplicationError(
    409,
    'source_cache_unavailable',
    `Source cache unavailable: ${url}. Refresh or update the source before saving.`,
  )
}

function normalizeSourceName(name: string | undefined): string {
  return name?.trim() ?? ''
}

function effectiveSourceName(source: SkillSource): string {
  return normalizeSourceName(source.name) || deriveRepoId(source.url)
}

function assertValidSourceName(name: string): void {
  if (SOURCE_NAME_REGEX.test(name)) return
  throw new SkillsApplicationError(
    400,
    'invalid_source_name',
    'Source name must match ^[a-z0-9]+(-[a-z0-9]+)*$',
  )
}

function assertUniqueSource(
  manifest: SkillsManifest,
  candidate: { url: string; name: string; existingUrl?: string },
): void {
  for (const source of manifest.sources) {
    const isCurrent = candidate.existingUrl !== undefined && source.url === candidate.existingUrl
    if (!isCurrent && source.url === candidate.url) {
      throw new SkillsApplicationError(
        409,
        'source_url_exists',
        `Source URL already exists: ${candidate.url}`,
      )
    }
    if (!isCurrent && effectiveSourceName(source) === candidate.name) {
      throw new SkillsApplicationError(
        409,
        'source_name_exists',
        `Source name already exists: ${candidate.name}`,
      )
    }
  }
}

function assertUniqueCacheId(manifest: SkillsManifest, cacheId: string): void {
  if (!manifest.sources.some((source) => deriveRepoId(source.url) === cacheId)) return
  throw new SkillsApplicationError(
    409,
    'source_cache_exists',
    `Source cache id already exists: ${cacheId}`,
  )
}

function assertUniqueSourceUrls(manifest: SkillsManifest): void {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.some(
      (skill) => !skill || typeof skill !== 'object' || typeof skill.id !== 'string' || !skill.id,
    )
  ) {
    throw new SkillsApplicationError(422, 'invalid_skills_manifest', 'Skills manifest is malformed')
  }
  const seen = new Set<string>()
  for (const source of manifest.sources) {
    if (typeof source?.url !== 'string' || !source.url) {
      throw new SkillsApplicationError(
        422,
        'invalid_skills_manifest',
        'Skills manifest is malformed',
      )
    }
    if (seen.has(source.url)) {
      throw new SkillsApplicationError(
        409,
        'duplicate_source_url',
        `Duplicate source URL: ${source.url}`,
      )
    }
    seen.add(source.url)
  }
}
