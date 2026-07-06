import { isAbsolute, join } from 'node:path'
import {
  buildManifest,
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
import { createProjectionDeps } from './deps.js'
import { mergeLocalSkills, scanSourceMembers } from './scan.js'

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
    } satisfies VarsContext)
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
  fs: Pick<IFileSystem, 'exists'>,
  repoPath: string,
  skills: LocalSkill[],
): Promise<void> {
  await Promise.all(
    skills.map(async (skill) => {
      if (!skill.path) return
      skill.available = await fs.exists(
        appendPath(resolveSkillDir(skill.path, repoPath), 'SKILL.md'),
      )
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
    const cacheDir = cacheDirFor(repoPath, repoId)
    if (!(await deps.fs.exists(cacheDir))) {
      try {
        await installSkill(deps.git, deps.fs, source.url, source.ref, repoPath, repoId)
      } catch (err) {
        workflowLogger.error('auto-install failed for source', { err, url: source.url, repoId })
        continue
      }
    }
    if (hasConfiguredMembers) continue
    if (!(await deps.fs.exists(cacheDir))) continue
    try {
      const scanned = await scanSourceMembers(cacheDir, source)
      if (scanned.length > 0) {
        const targets = (source as SkillSource & { targets?: AgentId[] }).targets ?? []
        source.members = scanned.map((member) => ({ name: member.name, targets }))
      }
    } catch (err) {
      workflowLogger.error('source member scan failed', { err, url: source.url, repoId })
    }
  }
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
