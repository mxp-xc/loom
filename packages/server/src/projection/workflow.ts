import { dirname, isAbsolute, join, relative } from 'node:path'
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
  type SourceTreeNode,
  type VarsContext,
  AGENT_IDS,
  getAgent,
} from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { IProcess } from '../ports/process.js'
import { logger } from '../lib/logger.js'
import { cacheDirFor } from '../remote/cache.js'
import { readLocalConfig, readRepoFiles } from '../api/repo-config.js'
import {
  executeProjection,
  type ProjectionResult,
  type ProjectionScope,
  type ProjectionWarning,
} from './executor.js'
import { resolveAgentAwareVars } from '../vars/agent-aware.js'
import { createProjectionDeps, type AuthorizedSourceCache } from './deps.js'
import { mergeLocalSkills } from './scan.js'
import { parseSkillMeta } from '../remote/frontmatter.js'
import { scanSourceTree } from '../remote/source-tree.js'
import { resolveRegisteredLocalSkills, type ResolvedLocalSkill } from '../skills/local-paths.js'
import {
  captureRepoCacheRoot,
  captureStableEntry,
  revalidateStableEntry,
  type StableEntry,
} from './fs-boundary.js'

const workflowLogger = logger.child('projection.workflow')
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
  const scope = input.scope ?? 'all'
  const manifest = input.manifest ?? (await loadProjectionManifest(deps, repoPath, scope))
  if (manifest.errors.length > 0) return invalidManifestResult(manifest)
  const sourceCaches =
    scope === 'skills' || scope === 'all'
      ? await captureAvailableSourceCaches(deps.fs, repoPath, manifest.skills.sources ?? [])
      : new Map<string, AuthorizedSourceCache>()
  const installed = await resolveInstalledAgents(deps.proc, input.installedAgents)
  const planningManifest =
    scope === 'mcp' || scope === 'memory'
      ? { ...manifest, skills: { ...manifest.skills, sources: [] } }
      : manifest
  const plan = input.plan ?? planProjection(planningManifest, manifest.config, installed)
  const localSkills =
    scope === 'skills' || scope === 'all'
      ? await resolveRegisteredLocalSkills(deps.fs, repoPath, manifest.skills)
      : new Map<string, ResolvedLocalSkill>()
  const localSourceEntries = await captureAvailableLocalSources(deps.fs, localSkills)
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
    localSkills,
    localSourceEntries,
    sourceCaches,
  )
  const result = await executeProjection(plan, manifest, varsCtx, projectionDeps, scope)
  if (!result.ok || (scope !== 'skills' && scope !== 'all')) return result
  const warnings = unavailableSourceWarnings(manifest.skills.sources ?? [])
  const combinedWarnings = [...(result.warnings ?? []), ...warnings]
  return combinedWarnings.length > 0 ? { ...result, warnings: combinedWarnings } : result
}

export async function loadProjectionManifest(
  deps: ProjectionWorkflowDeps,
  repoPath: string,
  scope: ProjectionScope = 'all',
): Promise<Manifest> {
  const manifest = await loadBaseManifest(deps, repoPath)
  if (manifest.errors.length > 0) return manifest
  if (scope === 'skills' || scope === 'all') {
    await ensureSourceTrees(deps, repoPath, manifest.skills.sources ?? [])
  }
  await annotateLocalSkillAvailability(deps.fs, repoPath, manifest.skills.skills)
  return manifest
}

export async function loadDisplayManifest(
  deps: ProjectionWorkflowDeps,
  repoPath: string,
): Promise<Manifest> {
  const manifest = await loadBaseManifest(deps, repoPath)
  if (manifest.errors.length > 0) return manifest
  await Promise.all([
    annotateSourceMemberMetadata(deps, repoPath, manifest.skills.sources ?? []),
    annotateLocalSkillAvailability(deps.fs, repoPath, manifest.skills.skills),
  ])
  return manifest
}

async function loadBaseManifest(deps: ProjectionWorkflowDeps, repoPath: string): Promise<Manifest> {
  const files = await readRepoFiles(deps.fs, repoPath)
  const repoManifest = loadRepoManifest(files)
  const localConfig = await readLocalConfig(deps.fs, deps.home)
  const baseManifest = buildManifest(repoManifest, localConfig as Config)
  if (baseManifest.errors.length > 0) return baseManifest
  repoManifest.skills.skills = await mergeLocalSkills(
    deps.fs,
    repoPath,
    repoManifest.skills.skills ?? [],
  )
  return buildManifest(repoManifest, localConfig as Config)
}

function invalidManifestResult(manifest: Manifest): ProjectionResult {
  return {
    ok: false,
    failure: {
      failedStep: 'manifest-invalid',
      originalError: new Error(manifest.errors.join('; ')),
      rollbackReport: { undone: 0, rollbackFailures: [] },
    },
  }
}

async function annotateSourceMemberMetadata(
  deps: Pick<ProjectionWorkflowDeps, 'fs' | 'git'>,
  repoPath: string,
  sources: SkillSource[],
): Promise<void> {
  await Promise.all(
    sources.map(async (source) => {
      const cacheId = deriveRepoId(source.url)
      const cacheDir = cacheDirFor(repoPath, cacheId)
      const cacheAvailable = await deps.fs.exists(cacheDir)
      if (!cacheAvailable) {
        source.availability = {
          available: false,
          reason: 'cache-unavailable',
          message: `Source cache unavailable: ${source.url}`,
        }
      } else {
        try {
          const ref = source.pinned_commit ?? 'HEAD'
          await Promise.all([
            deps.git.revParse(cacheDir, `${ref}^{commit}`),
            deps.git.revParse(cacheDir, `${ref}^{tree}`),
          ])
          source.availability = { available: true }
        } catch (err) {
          workflowLogger.error('source cache validation failed for display', {
            err,
            source: source.url,
            cacheId,
          })
          source.availability = {
            available: false,
            reason: 'cache-invalid',
            message: err instanceof Error ? err.message : String(err),
          }
        }
      }
      source.members = await Promise.all(
        (source.members ?? []).map(async (member) => {
          const enriched = { ...member, path: member.entry }
          if (source.availability?.available === false || !isSafeSkillEntry(member.entry)) {
            return enriched
          }
          const skillFile = join(cacheDir, member.entry)
          if (!(await deps.fs.exists(skillFile))) return enriched
          try {
            const content = await deps.fs.readFile(skillFile)
            const metadata = parseSkillMeta(content, member.name, dirname(skillFile))
            return metadata?.description
              ? { ...enriched, description: metadata.description }
              : enriched
          } catch (err) {
            workflowLogger.error('source member metadata read failed', {
              err,
              source: source.url,
              entry: member.entry,
              path: skillFile,
            })
            return enriched
          }
        }),
      )
    }),
  )
}

function isSafeSkillEntry(entry: string): boolean {
  if (!entry || isAbsolute(entry) || /^[A-Za-z]:[/\\]/.test(entry)) return false
  const normalized = entry.replace(/\\/g, '/').replace(/^\/+/, '')
  return (
    normalized === entry.replace(/\\/g, '/') &&
    !normalized.split('/').includes('..') &&
    (normalized === 'SKILL.md' || normalized.endsWith('/SKILL.md'))
  )
}

export async function annotateLocalSkillAvailability(
  fs: IFileSystem,
  repoPath: string,
  skills: LocalSkill[],
): Promise<void> {
  const resolved = await resolveRegisteredLocalSkills(fs, repoPath, {
    sources: [],
    skills,
  })
  await Promise.all(
    skills.map(async (skill) => {
      const authorized = resolved.get(skill.id)
      if (!authorized) return
      if (skill.path) skill.available = authorized.available
      if (!authorized.available) return
      skill.skillFilePath = localSkillFilePath(skill, repoPath, authorized.skillFile)
      try {
        const content = await fs.readFile(authorized.skillFile)
        const description = parseSkillMeta(content, skill.id, authorized.directory)?.description
        if (description) skill.description = description
      } catch (err) {
        workflowLogger.error('local skill metadata read failed', {
          err,
          skillId: skill.id,
          path: authorized.skillFile,
        })
      }
    }),
  )
}

async function resolveInstalledAgents(
  proc: IProcess,
  requestedAgents: AgentId[] = AGENT_IDS,
): Promise<Set<AgentId>> {
  const installed = new Set<AgentId>()
  for (const agent of requestedAgents) {
    try {
      if (await proc.isCommandInstalled(getAgent(agent).command)) {
        installed.add(agent)
      }
    } catch (err) {
      workflowLogger.warn('agent install check failed; assuming installed', { err, agent })
      installed.add(agent)
    }
  }
  return installed
}

async function ensureSourceTrees(
  deps: ProjectionWorkflowDeps,
  repoPath: string,
  sources: SkillSource[],
): Promise<void> {
  for (const source of sources) {
    const { repoId } = sourceIdentity(source)
    const cacheId = deriveRepoId(source.url)
    const cache = await captureRepoCacheRoot(deps.fs, repoPath, cacheId)
    if (!cache) {
      const err = new Error(`Source cache unavailable: ${source.url}`)
      workflowLogger.error('source cache unavailable during projection', {
        err,
        url: source.url,
        repoId,
        cacheId,
      })
      source.availability = {
        available: false,
        reason: 'cache-unavailable',
        message: err.message,
      }
      continue
    }
    try {
      const tree = await runSourceGitOperation(deps.fs, cache, `source cache ${cacheId}`, () =>
        scanSourceTree(deps.git, cache.canonicalPath, source.pinned_commit ?? 'HEAD', source),
      )
      const checkedOutCommit = await runSourceGitOperation(
        deps.fs,
        cache,
        `source cache ${cacheId}`,
        () => deps.git.revParseHead(cache.canonicalPath),
      )
      if (checkedOutCommit !== tree.commit) {
        workflowLogger.warn('source cache checkout differs from pinned commit; realigning', {
          url: source.url,
          repoId,
          cacheId,
          checkedOutCommit,
          pinnedCommit: tree.commit,
        })
        await runSourceGitOperation(deps.fs, cache, `source cache ${cacheId}`, () =>
          deps.git.checkout(cache.canonicalPath, tree.commit),
        )
      }
      source.sourceTree = tree
      source.availability = { available: true }
      const metadataByEntry = new Map<string, { path: string; description?: string }>(
        flattenSourceTree(tree.nodes)
          .filter((node) => node.kind === 'bundle')
          .map((node) => [node.entry, { path: node.entry, description: node.description }]),
      )
      source.members = (source.members ?? []).map((member) => {
        const metadata = metadataByEntry.get(member.entry)
        return metadata ? { ...member, ...metadata } : member
      })
    } catch (err) {
      if (!(err instanceof SourceGitOperationError)) throw err
      workflowLogger.error('source tree scan failed', { err, url: source.url, repoId, cacheId })
      source.availability = {
        available: false,
        reason: 'cache-invalid',
        message: err.cause instanceof Error ? err.cause.message : String(err.cause),
      }
    }
  }
}

async function captureAvailableSourceCaches(
  fs: IFileSystem,
  repoPath: string,
  sources: readonly SkillSource[],
): Promise<Map<string, AuthorizedSourceCache>> {
  const caches = new Map<string, AuthorizedSourceCache>()
  for (const source of sources) {
    if (source.availability?.available === false) continue
    const cacheId = deriveRepoId(source.url)
    const root = await captureRepoCacheRoot(fs, repoPath, cacheId)
    if (!root) {
      const err = new Error(`Source cache unavailable: ${source.url}`)
      workflowLogger.error('source cache unavailable before projection planning', {
        err,
        url: source.url,
        cacheId,
      })
      source.availability = {
        available: false,
        reason: 'cache-unavailable',
        message: err.message,
      }
      continue
    }
    const existing = caches.get(cacheId)
    const sourceName = sourceIdentity(source).repoId
    if (existing && (existing.sourceUrl !== source.url || existing.sourceName !== sourceName)) {
      throw new Error(`Source cache id collision: ${cacheId}`)
    }
    caches.set(cacheId, { sourceUrl: source.url, sourceName, root })
  }
  return caches
}

async function captureAvailableLocalSources(
  fs: IFileSystem,
  skills: ReadonlyMap<string, ResolvedLocalSkill>,
): Promise<Map<string, StableEntry>> {
  const entries = new Map<string, StableEntry>()
  for (const [skillId, skill] of skills) {
    if (!skill.available) continue
    entries.set(
      skillId,
      await captureStableEntry(fs, skill.directory, 'directory', `local skill source ${skillId}`),
    )
  }
  return entries
}

class SourceGitOperationError extends Error {
  constructor(cause: unknown) {
    super('source cache Git operation failed', { cause })
    this.name = 'SourceGitOperationError'
  }
}

async function runSourceGitOperation<T>(
  fs: IFileSystem,
  cache: StableEntry,
  description: string,
  operation: () => Promise<T>,
): Promise<T> {
  await revalidateStableEntry(fs, cache, description)
  let result: T
  try {
    result = await operation()
  } catch (err) {
    await revalidateStableEntry(fs, cache, description)
    throw new SourceGitOperationError(err)
  }
  await revalidateStableEntry(fs, cache, description)
  return result
}

function unavailableSourceWarnings(sources: SkillSource[]): ProjectionWarning[] {
  return sources.flatMap((source) =>
    source.availability?.available === false
      ? [
          {
            code: 'source-unavailable' as const,
            sourceName: sourceIdentity(source).repoId,
            sourceUrl: source.url,
            message:
              source.availability.message ?? `Source unavailable on this machine: ${source.url}`,
          },
        ]
      : [],
  )
}

function flattenSourceTree(nodes: SourceTreeNode[]): SourceTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.kind === 'container' ? flattenSourceTree(node.children) : []),
  ])
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

function appendPath(base: string, segment: string): string {
  if (base.includes('/') && !base.includes('\\')) {
    return base.replace(/\/+$/, '') + '/' + segment.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  }
  return join(base, segment)
}
