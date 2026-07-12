import { isAbsolute, join, relative } from 'node:path'
import {
  buildManifest,
  deriveRepoId,
  loadRepoManifest,
  planProjection,
  sourceIdentity,
  type AgentId,
  type Config,
  type LocalSkill,
  type Manifest,
  type ProjectionPlan,
  type SkillSource,
  type VarsContext,
} from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { IProcess } from '../ports/process.js'
import { logger } from '../lib/logger.js'
import { cacheDirFor } from '../remote/cache.js'
import { installSkill } from '../remote/install.js'
import { readLocalConfig, readRepoFiles } from '../api/repo-config.js'
import { executeProjection, type ProjectionResult, type ProjectionScope } from './executor.js'
import { resolveAgentAwareVars } from '../vars/agent-aware.js'
import { createProjectionDeps } from './deps.js'
import { mergeLocalSkills, scanSourceMembers, type ScannedMember } from './scan.js'
import { parseSkillMeta } from '../remote/frontmatter.js'

const workflowLogger = logger.child('projection.workflow')
const DEFAULT_AGENTS: AgentId[] = ['claude-code', 'codex', 'opencode']

export interface ProjectionWorkflowDeps {
  fs: IFileSystem
  git: IGit
  proc: IProcess
  home: string
}

export interface ProjectRepositoryInput {
  manifest?: Manifest
  plan?: ProjectionPlan
  varsCtx?: VarsContext
  installedAgents?: AgentId[]
  scope?: ProjectionScope
}

export async function projectRepository(
  deps: ProjectionWorkflowDeps,
  repoPath: string,
  input: ProjectRepositoryInput,
): Promise<ProjectionResult> {
  const installed = await resolveInstalledAgents(deps.proc, input.installedAgents)
  const manifest = input.manifest ?? (await loadProjectionManifest(deps, repoPath))
  const plan = input.plan ?? planProjection(manifest, manifest.config, installed)
  const varsCtx =
    input.varsCtx ??
    ({
      env: {},
      activeProfile: manifest.vars.active,
      defaultProfile: manifest.vars.default,
      resolveForAgent: (agent: AgentId) =>
        resolveAgentAwareVars(deps.fs, deps.home, repoPath, agent),
    } satisfies VarsContext & {
      resolveForAgent: (agent: AgentId) => ReturnType<typeof resolveAgentAwareVars>
    })
  const projectionDeps = createProjectionDeps(
    { fs: deps.fs, git: deps.git, proc: deps.proc },
    repoPath,
    installed,
    deps.home,
  )
  return executeProjection(plan, manifest, varsCtx, projectionDeps, input.scope ?? 'all')
}

export async function loadProjectionManifest(
  deps: ProjectionWorkflowDeps,
  repoPath: string,
): Promise<Manifest> {
  const files = await readRepoFiles(deps.fs, repoPath)
  const repoManifest = loadRepoManifest(files)
  await ensureSourceMembers(deps, repoPath, repoManifest.skills.sources ?? [])
  repoManifest.skills.skills = await mergeLocalSkills(
    deps.fs,
    repoPath,
    repoManifest.skills.skills ?? [],
  )
  await annotateLocalSkillAvailability(deps.fs, repoPath, repoManifest.skills.skills)
  const localConfig = await readLocalConfig(deps.fs, deps.home)
  return buildManifest(repoManifest, localConfig as Config)
}

export async function annotateLocalSkillAvailability(
  fs: Pick<IFileSystem, 'exists' | 'readFile'>,
  repoPath: string,
  skills: LocalSkill[],
): Promise<void> {
  await Promise.all(
    skills.map(async (skill) => {
      const skillDir = resolveLocalSkillDir(skill, repoPath)
      const skillFile = appendPath(skillDir, 'SKILL.md')
      const available = await fs.exists(skillFile)
      if (skill.path) skill.available = available
      if (!available) return
      skill.skillFilePath = localSkillFilePath(skill, repoPath, skillFile)
      try {
        const content = await fs.readFile(skillFile)
        const description = parseSkillMeta(content, skill.id, skillDir)?.description
        if (description) skill.description = description
      } catch (err) {
        workflowLogger.error('local skill metadata read failed', {
          err,
          skillId: skill.id,
          path: skillFile,
        })
      }
    }),
  )
}

async function resolveInstalledAgents(
  proc: IProcess,
  requestedAgents: AgentId[] = DEFAULT_AGENTS,
): Promise<Set<AgentId>> {
  const installed = new Set<AgentId>()
  for (const agent of requestedAgents) {
    try {
      if (await proc.isInstalled(agent)) installed.add(agent)
    } catch (err) {
      workflowLogger.warn('agent install check failed; assuming installed', { err, agent })
      installed.add(agent)
    }
  }
  return installed
}

async function ensureSourceMembers(
  deps: ProjectionWorkflowDeps,
  repoPath: string,
  sources: SkillSource[],
): Promise<void> {
  for (const source of sources) {
    const hasConfiguredMembers = (source.members?.length ?? 0) > 0
    const { repoId } = sourceIdentity(source)
    const cacheId = deriveRepoId(source.url)
    const cacheDir = cacheDirFor(repoPath, cacheId)
    if (!(await deps.fs.exists(cacheDir))) {
      try {
        await installSkill(deps.git, deps.fs, source.url, source.ref, repoPath, cacheId)
      } catch (err) {
        workflowLogger.error('auto-install failed for source', {
          err,
          url: source.url,
          repoId,
          cacheId,
        })
        continue
      }
    }
    if (!(await deps.fs.exists(cacheDir))) continue
    try {
      const scanned = await scanSourceMembers(cacheDir, source)
      if (hasConfiguredMembers) {
        const metadataByName = new Map(scanned.map((member) => [member.name, member]))
        source.members = (source.members ?? []).map((member) => ({
          ...member,
          ...sourceMemberMetadata(metadataByName.get(member.name)),
        }))
        continue
      }
      if (scanned.length > 0) {
        const targets = (source as SkillSource & { targets?: AgentId[] }).targets ?? []
        source.members = scanned.map((member) => ({
          name: member.name,
          targets,
          ...sourceMemberMetadata(member),
        }))
      }
    } catch (err) {
      workflowLogger.error('source member scan failed', { err, url: source.url, repoId, cacheId })
    }
  }
}

function sourceMemberMetadata(
  member: ScannedMember | undefined,
): Partial<NonNullable<SkillSource['members']>[number]> {
  if (!member) return {}
  return {
    ...(member.relativePath ? { path: member.relativePath } : {}),
    ...(member.description ? { description: member.description } : {}),
  }
}

function resolveLocalSkillDir(skill: LocalSkill, repoPath: string): string {
  return skill.path
    ? resolveSkillDir(skill.path, repoPath)
    : appendPath(repoPath, appendPath('assets/skills', skill.id))
}

function localSkillFilePath(skill: LocalSkill, repoPath: string, skillFile: string): string {
  if (!skill.path) return appendPath(appendPath('assets/skills', skill.id), 'SKILL.md')
  if (isAbsolute(skill.path)) {
    const rel = relative(repoPath, skillFile).replace(/\\/g, '/')
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
    return skillFile.replace(/\\/g, '/')
  }
  return appendPath(skill.path.replace(/^\.([/\\])/, ''), 'SKILL.md').replace(/\\/g, '/')
}

function resolveSkillDir(localPath: string, repoPath: string): string {
  if (isAbsolute(localPath)) return localPath
  return appendPath(repoPath, localPath.replace(/^\.([/\\])/, ''))
}

function appendPath(base: string, segment: string): string {
  if (base.includes('/') && !base.includes('\\')) {
    return base.replace(/\/+$/, '') + '/' + segment.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  }
  return join(base, segment)
}
