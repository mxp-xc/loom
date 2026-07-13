import { dirname, isAbsolute, join } from 'node:path'
import {
  addLocalSkill as addLocalSkillMutation,
  addSource as addSourceMutation,
  deriveRepoId,
  pinSourceCommit,
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
import { installSkill } from '../remote/install.js'
import { readYaml, writeYaml } from '../api/repo-config.js'

const skillsLogger = logger.child('skills-application')

export class SkillsApplicationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
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
  scan?: string
}

export interface UpdateSourceMetaCommand {
  url: string
  name?: string
  ref?: string
  type?: 'branch' | 'tag'
  scan?: string
}

export interface SetSkillTargetsCommand {
  sourceUrl: string
  memberName: string
  targets: AgentId[]
}

export class SkillsApplication {
  constructor(
    private readonly fs: IFileSystem,
    private readonly git: IGit,
    private readonly home: string,
    private readonly log: LoggerPort = skillsLogger,
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
    const sourceInput = {
      name: sourceName,
      url: command.url,
      ref: command.ref,
      ...(command.type === 'branch' || command.type === 'tag' ? { type: command.type } : {}),
      ...(typeof command.scan === 'string' && command.scan.trim()
        ? { scan: command.scan.trim() }
        : {}),
    }
    const result = addSourceMutation(manifest, sourceInput)
    if (result.changed) await this.writeManifest(repoPath, result.data)
    let source = result.data.sources[result.data.sources.length - 1]!

    try {
      const installed = await installSkill(
        this.git,
        this.fs,
        command.url,
        command.ref,
        repoPath,
        deriveRepoId(command.url),
      )
      const pinned = pinSourceCommit(result.data, command.url, installed.pinned_commit)
      if (pinned.changed) {
        await this.writeManifest(repoPath, pinned.data)
        source = pinned.data.sources.find((item) => item.url === command.url)!
      }
    } catch (err) {
      this.log.error('auto-install failed for source', { err, url: command.url })
    }

    return { source }
  }

  async setSourceMembers(repoPath: string, url: string, members: unknown): Promise<void> {
    const result = await this.updateManifest(repoPath, (manifest) =>
      setSourceMembersMutation(manifest, url, Array.isArray(members) ? members : []),
    )
    if (!result.changed) throw sourceNotFound(url)
  }

  async removeSource(repoPath: string, url: string): Promise<void> {
    await this.updateManifest(repoPath, (manifest) => removeSourceMutation(manifest, url))
  }

  async updateSourceMeta(repoPath: string, command: UpdateSourceMetaCommand): Promise<void> {
    const manifest = await this.readManifest(repoPath)
    const existing = manifest.sources.find((source) => source.url === command.url)
    if (!existing) throw sourceNotFound(command.url)
    const updates: { name?: string; ref?: string; type?: 'branch' | 'tag'; scan?: string | null } =
      {}
    if (typeof command.name === 'string') {
      updates.name = command.name.trim()
      assertValidSourceName(updates.name)
      assertUniqueSource(manifest, {
        url: command.url,
        name: updates.name,
        existingUrl: command.url,
      })
    }
    if (typeof command.ref === 'string') updates.ref = command.ref
    if (command.type === 'branch' || command.type === 'tag') updates.type = command.type
    if (typeof command.scan === 'string') updates.scan = command.scan
    const result = updateSourceMetaMutation(manifest, command.url, updates)
    if (result.changed) await this.writeManifest(repoPath, result.data)
    if (!result.changed) throw sourceNotFound(command.url)
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
      setSkillTargetsMutation(manifest, command.sourceUrl, command.memberName, command.targets),
    )
    if (!result.changed) throw sourceNotFound(command.sourceUrl)
  }

  async setSourceMemberTargets(
    repoPath: string,
    sourceUrl: string,
    updates: Array<{ memberName: string; targets: AgentId[] }>,
  ): Promise<void> {
    const memberUpdates = updates.map((update) => ({
      memberName: String(update?.memberName ?? ''),
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

  private async readManifest(repoPath: string): Promise<SkillsManifest> {
    return (await readYaml(this.fs, this.skillsYamlPath(repoPath))) ?? { sources: [], skills: [] }
  }

  private async writeManifest(repoPath: string, manifest: SkillsManifest): Promise<void> {
    await writeYaml(this.fs, this.skillsYamlPath(repoPath), manifest)
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
