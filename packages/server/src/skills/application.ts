import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
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
  SOURCE_NAME_REGEX,
  setLocalSkillTargets as setLocalSkillTargetsMutation,
  setSkillTargets as setSkillTargetsMutation,
  setSourceMembers as setSourceMembersMutation,
  setSourceMemberTargets as setSourceMemberTargetsMutation,
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
import { readYaml, writeYaml } from '../api/repo-config.js'
import { classifySkillMemberChanges } from './reconciliation.js'
import { cacheDirFor } from '../remote/cache.js'
import { scanSourceTree } from '../remote/source-tree.js'

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

export interface SetSkillTargetsCommand {
  sourceUrl: string
  memberEntry: string
  targets: AgentId[]
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
    if (!(await this.fs.exists(resolvedDir))) return []
    return scanLocalSkillDirs(resolvedDir, { dot: true, ignore: LOCAL_SKILL_SCAN_IGNORE })
  }

  async addLocalSkill(repoPath: string, skill: LocalSkill): Promise<{ skill: LocalSkill }> {
    await this.updateManifest(repoPath, (manifest) => addLocalSkillMutation(manifest, skill))
    return { skill }
  }

  async importLocalSkills(
    repoPath: string,
    command: { skills: LocalSkillImport[]; mode: 'move' | 'ref' },
  ): Promise<{ count: number }> {
    const assetsDir = this.assetsSkillsDir(repoPath)
    const assetsPrefix = normalizedPath(assetsDir)
    const manifest = await this.readManifest(repoPath)
    for (const skill of command.skills) {
      const skillPath = normalizedPath(String(skill.path ?? ''))
      const isRepoAssetSkill =
        skillPath === assetsPrefix + '/' + skill.name ||
        skillPath.startsWith(assetsPrefix + '/' + skill.name + '/')
      if (command.mode === 'move') {
        const dest = join(assetsDir, skill.name)
        if (await this.fs.exists(dest)) throw alreadyExists(skill.name)
        await this.fs.mkdir(assetsDir, true)
        await this.fs.move(skill.path, dest)
        Object.assign(manifest, addLocalSkillMutation(manifest, { id: skill.name }).data)
      } else {
        const localSkill = isRepoAssetSkill
          ? { id: skill.name }
          : { id: skill.name, path: skill.path }
        Object.assign(manifest, addLocalSkillMutation(manifest, localSkill).data)
      }
    }

    await this.writeManifest(repoPath, manifest)
    return { count: command.skills.length }
  }

  async writeLocalSkills(
    repoPath: string,
    command: { skills: LocalSkillWrite[] },
  ): Promise<{ count: number }> {
    const assetsDir = this.assetsSkillsDir(repoPath)
    const manifest = await this.readManifest(repoPath)

    for (const skill of command.skills) {
      const dest = join(assetsDir, skill.name)
      if (await this.fs.exists(dest)) throw alreadyExists(skill.name)
      await this.fs.mkdir(dest, true)
      for (const file of Array.isArray(skill.files) ? skill.files : []) {
        const rel = String(file.path).replace(/^[/\\]+/, '')
        if (!rel || rel.includes('..')) continue
        const target = join(dest, rel)
        await this.fs.mkdir(dirname(target), true)
        await this.fs.writeFile(target, String(file.content ?? ''))
      }
      Object.assign(manifest, addLocalSkillMutation(manifest, { id: skill.name }).data)
    }

    await this.writeManifest(repoPath, manifest)
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
      if (cacheSwapped) {
        try {
          await this.fs.removeDir(cacheDir)
        } catch (cleanupError) {
          retainCandidateRoot = true
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
          this.log.error('failed to restore source cache after add failure', {
            err: restoreError,
            url: command.url,
            cacheDir,
          })
        }
      }
      throw err
    } finally {
      if (!retainCandidateRoot) await this.removeCandidateRoot(candidate.rootDir, command.url)
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
    const copied: string[] = []
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
          targets: member.targets,
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
      if (preserve.some((name) => !changes.removed.some((member) => member.name === name))) {
        throw new SkillsApplicationError(400, 'invalid_preserve_members', '保留列表包含无效 skill')
      }
      const currentManifest = await this.readManifest(repoPath)
      const currentSource = currentManifest.sources.find((item) => item.url === command.url)
      if (!currentSource) throw sourceNotFound(command.url)
      originalManifest = structuredClone(currentManifest)
      for (const name of preserve) {
        const dest = join(this.assetsSkillsDir(repoPath), name)
        if (
          currentManifest.skills.some((skill) => skill.id === name) ||
          (await this.fs.exists(dest))
        ) {
          throw alreadyExists(name)
        }
      }
      for (const name of preserve) {
        const previous = currentSource.members?.find((member) => member.name === name)
        const skillFile = previous?.entry
        if (!skillFile) throw new SkillsApplicationError(400, 'invalid_member_entry', name)
        const normalized = skillFile.replace(/\\/g, '/')
        if (isAbsolute(skillFile) || normalized.split('/').includes('..')) {
          throw new SkillsApplicationError(
            400,
            'invalid_member_path',
            `Invalid skill path: ${skillFile}`,
          )
        }
        const sourceDir = join(
          repoPath,
          'remote-cache',
          deriveRepoId(source.url),
          dirname(normalized),
        )
        const dest = join(this.assetsSkillsDir(repoPath), name)
        if (dirname(normalized) === '.') await this.copyRootBundle(sourceDir, dest)
        else await this.fs.copyDir(sourceDir, dest)
        copied.push(dest)
        currentManifest.skills.push({
          id: name,
          ...(previous?.targets ? { targets: previous.targets } : {}),
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
      return { finalized: true, changes, preserved: preserve }
    } catch (err) {
      this.log.error('source reconciliation failed', { err, url: command.url })
      for (const path of copied) {
        try {
          await this.fs.removeDir(path)
        } catch (cleanupError) {
          this.log.error('source reconciliation cleanup failed', { err: cleanupError, path })
        }
      }
      if (cacheSwapped) {
        try {
          await this.fs.removeDir(cacheDir)
        } catch (cleanupError) {
          retainCandidateRoot = true
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
          this.log.error('source reconciliation manifest rollback failed', {
            err: rollbackError,
            url: command.url,
          })
        }
        try {
          await this.projectSkills?.(repoPath)
        } catch (rollbackError) {
          this.log.error('source reconciliation projection rollback failed', {
            err: rollbackError,
            url: command.url,
          })
        }
      }
      throw err
    } finally {
      if (candidate.rootDir && !retainCandidateRoot) {
        await this.removeCandidateRoot(candidate.rootDir, command.url)
      }
    }
  }

  async removeLocalSkill(repoPath: string, id: string): Promise<void> {
    const manifest = await this.readManifest(repoPath)
    const existing = manifest.skills.find((skill) => skill.id === id)
    const result = removeLocalSkillMutation(manifest, id)
    if (result.changed) await this.writeManifest(repoPath, result.data)
    if (!existing?.path) {
      const dir = join(this.assetsSkillsDir(repoPath), id)
      if (await this.fs.exists(dir)) await this.fs.removeDir(dir)
    }
  }

  async setSkillTargets(repoPath: string, command: SetSkillTargetsCommand): Promise<void> {
    const result = await this.updateManifest(repoPath, (manifest) =>
      setSkillTargetsMutation(manifest, command.sourceUrl, command.memberEntry, command.targets),
    )
    if (!result.changed) throw sourceNotFound(command.sourceUrl)
  }

  async setSourceMemberTargets(
    repoPath: string,
    sourceUrl: string,
    updates: Array<{ memberEntry: string; targets: AgentId[] }>,
  ): Promise<void> {
    const memberUpdates = updates.map((update) => ({
      memberEntry: String(update?.memberEntry ?? ''),
      targets: Array.isArray(update?.targets) ? update.targets : [],
    }))
    const result = await this.updateManifest(repoPath, (manifest) =>
      setSourceMemberTargetsMutation(manifest, sourceUrl, memberUpdates),
    )
    if (!result.changed) throw sourceNotFound(sourceUrl)
  }

  async setLocalSkillTargets(repoPath: string, id: string, targets: AgentId[]): Promise<void> {
    await this.updateManifest(repoPath, (manifest) =>
      setLocalSkillTargetsMutation(manifest, id, targets),
    )
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
    return (await readYaml(this.fs, this.skillsYamlPath(repoPath))) ?? { sources: [], skills: [] }
  }

  private async copyRootBundle(source: string, destination: string): Promise<void> {
    await this.fs.mkdir(destination, true)
    for (const name of await this.fs.readDir(source)) {
      if (name === '.git') continue
      const childSource = join(source, name)
      const childDestination = join(destination, name)
      if (await this.fs.isDirectory(childSource))
        await this.fs.copyDir(childSource, childDestination)
      else await this.fs.copyFile(childSource, childDestination)
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
      await this.removeCandidateRoot(rootDir, url)
      throw err
    }
  }

  private async removeCandidateRoot(rootDir: string, url: string): Promise<void> {
    try {
      await this.fs.removeDir(rootDir)
    } catch (err) {
      this.log.error('failed to clean source candidate', { err, url, rootDir })
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

  private assetsSkillsDir(repoPath: string): string {
    return join(repoPath, 'assets', 'skills')
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

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
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
