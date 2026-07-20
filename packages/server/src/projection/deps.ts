import { join, dirname, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createAgentMcpAdapter } from '../adapters/mcp.js'
import type { ManagedSkillArtifacts, ProjectionDeps } from './executor.js'
import { AGENT_IDS, LocalSkillIdSchema, agentsSupporting, type AgentId } from '@loom/core'
import { logger } from '../lib/logger.js'
import { cacheDirFor } from '../remote/cache.js'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { IProcess } from '../ports/process.js'
import { runtimeAgentPathContext } from '../adapters/paths.js'
import type { ResolvedLocalSkill } from '../skills/local-paths.js'
import {
  atomicReplaceTextFile,
  assertSafePathSegment,
  assertSafeRelativePath,
  captureRepoCacheRoot,
  revalidateStableEntry,
  type StableEntry,
} from './fs-boundary.js'

const projectionLogger = logger.child('projection')

export interface AuthorizedSourceCache {
  sourceUrl: string
  sourceName: string
  root: StableEntry
}

export function createProjectionDeps(
  platform: { fs: IFileSystem; git: IGit; proc: IProcess },
  repoPath: string,
  installedAgents: Set<AgentId>,
  home: string,
  localSkills: ReadonlyMap<string, ResolvedLocalSkill> = new Map(),
  localSourceEntries: ReadonlyMap<string, StableEntry> = new Map(),
  sourceCaches?: ReadonlyMap<string, AuthorizedSourceCache>,
): ProjectionDeps {
  const ownerRepo = sha256(resolve(repoPath))
  const stateFile = join(home, '.loom', 'state', ownerRepo, 'projected-mcp.json')
  const legacyStateFile = join(home, '.loom', 'state', basenameRepo(repoPath), 'projected-mcp.json')
  const canMigrateLegacyState =
    dirname(resolve(repoPath)) === resolve(home, '.loom', 'repos') && legacyStateFile !== stateFile
  const skillStateFile = join(home, '.loom', 'state', ownerRepo, 'projected-skills.json')
  const fs = platform.fs
  const authorizedSourceCaches = sourceCaches ?? new Map<string, AuthorizedSourceCache>()
  const enforceSourceAuthorization = sourceCaches !== undefined
  const pathContext = runtimeAgentPathContext(home)
  const writeState = async (
    agents: Record<string, string[]>,
    expectedIdentity: string | null,
  ): Promise<string> => {
    await fs.mkdir(dirname(stateFile), true)
    const installed = await atomicReplaceTextFile(
      fs,
      stateFile,
      JSON.stringify({ version: 1, ownerRepo, agents }, null, 2) + '\n',
      expectedIdentity,
    )
    return installed.identity
  }
  const readState = async (): Promise<{
    agents: Record<string, string[]>
    identity: string | null
  }> => {
    try {
      const current = await readStableJsonFile(fs, stateFile)
      if (current) {
        const agents = parseManagedMcpState(current.value, ownerRepo)
        if (canMigrateLegacyState) await removeLegacyState(fs, legacyStateFile)
        return { agents, identity: current.identity }
      }
      if (!canMigrateLegacyState) return { agents: {}, identity: null }
      const legacy = await readStableJsonFile(fs, legacyStateFile)
      if (!legacy) return { agents: {}, identity: null }
      const agents = parseLegacyManagedMcpState(legacy.value)
      const identity = await writeState(agents, null)
      await fs.removeEntryIfIdentity(legacyStateFile, legacy.identity)
      return { agents, identity }
    } catch (err) {
      projectionLogger.error('failed to read managed MCP projection state', {
        err,
        stateFile,
        legacyStateFile,
      })
      throw err
    }
  }
  const readSkillState = async (): Promise<ManagedSkillArtifacts> => {
    try {
      const value = JSON.parse(await fs.readFile(skillStateFile)) as unknown
      return parseManagedSkillState(value, ownerRepo)
    } catch (err) {
      if (isMissing(err)) return {}
      projectionLogger.error('failed to read managed skill projection state', {
        err,
        skillStateFile,
      })
      throw err
    }
  }
  const writeSkillState = async (artifacts: ManagedSkillArtifacts): Promise<void> => {
    await fs.mkdir(dirname(skillStateFile), true)
    await fs.writeFile(
      skillStateFile,
      JSON.stringify({ version: 1, ownerRepo, agents: artifacts }, null, 2) + '\n',
    )
  }
  return {
    fs,
    ownerRepo,
    adapters: Object.fromEntries(
      agentsSupporting('mcp').map((agent) => [agent, createAgentMcpAdapter(agent, pathContext)]),
    ),
    pathContext,
    installedAgents,
    resolveSkillSrc: (link) => {
      if (link.source === 'local') {
        const skill = localSkills.get(link.skillId)
        if (!skill) throw new Error(`Local skill is not authorized: ${link.skillId}`)
        if (link.localPath !== skill.entry?.path) {
          throw new Error(
            `Local skill path does not match its authorized manifest entry: ${link.skillId}`,
          )
        }
        if (!skill.available) return null
        return localSourceEntries.get(link.skillId) ?? skill.directory
      }
      return resolveSourceSkillDir(
        repoPath,
        link.source,
        authorizedSourceCaches,
        enforceSourceAuthorization,
      )
    },
    resolveSourceRoot: (sourcePlan) => {
      assertSafePathSegment(sourcePlan.cacheId, 'source cache id')
      const authorized = authorizedSourceCaches.get(sourcePlan.cacheId)
      if (authorized) {
        if (
          authorized.sourceUrl !== sourcePlan.sourceUrl ||
          authorized.sourceName !== sourcePlan.sourceName
        ) {
          throw new Error(
            `Source cache identity does not match its authorized source: ${sourcePlan.cacheId}`,
          )
        }
        return authorized.root
      }
      return enforceSourceAuthorization ? null : cacheDirFor(repoPath, sourcePlan.cacheId)
    },
    resolveSourceFiles: async (sourcePlan) => {
      assertSafePathSegment(sourcePlan.cacheId, 'source cache id')
      const authorized = authorizedSourceCaches.get(sourcePlan.cacheId)
      if (
        authorized &&
        (authorized.sourceUrl !== sourcePlan.sourceUrl ||
          authorized.sourceName !== sourcePlan.sourceName)
      ) {
        throw new Error(
          `Source cache identity does not match its authorized source: ${sourcePlan.cacheId}`,
        )
      }
      if (enforceSourceAuthorization && !authorized) {
        throw new Error(`Source cache unavailable: ${sourcePlan.sourceUrl}`)
      }
      const cache =
        authorized?.root ?? (await captureRepoCacheRoot(fs, repoPath, sourcePlan.cacheId))
      if (!cache) throw new Error(`Source cache unavailable: ${sourcePlan.sourceUrl}`)
      await revalidateStableEntry(fs, cache, `source cache ${sourcePlan.cacheId}`)
      const cacheDir = cache.canonicalPath
      const checkedOutCommit = await platform.git.revParseHead(cacheDir)
      await revalidateStableEntry(fs, cache, `source cache ${sourcePlan.cacheId}`)
      if (checkedOutCommit !== sourcePlan.commit) {
        throw new Error(
          `Source cache checkout does not match planned commit: ${sourcePlan.cacheId}`,
        )
      }
      const entries = await platform.git.readTree(cacheDir, sourcePlan.commit)
      await revalidateStableEntry(fs, cache, `source cache ${sourcePlan.cacheId}`)
      return entries
        .filter((entry) => entry.type === 'blob' && entry.mode !== '120000')
        .map((entry) => entry.path)
    },
    logger: projectionLogger,
    getManagedMcpIds: async (agent) => new Set((await readState()).agents[agent] ?? []),
    setManagedMcpIds: async (agent, ids) => {
      const current = await readState()
      current.agents[agent] = ids
      await writeState(current.agents, current.identity)
    },
    getManagedSkillArtifacts: readSkillState,
    setManagedSkillArtifacts: writeSkillState,
  }
}

async function readStableJsonFile(
  fs: IFileSystem,
  path: string,
): Promise<{ value: unknown; identity: string } | null> {
  const entry = await fs.inspectEntry(path)
  if (!entry) return null
  if (entry.kind !== 'file') throw new Error(`Projection state is not a real file: ${path}`)
  const content = await fs.readFile(path)
  const confirmed = await fs.inspectEntry(path)
  if (!confirmed || confirmed.kind !== 'file' || confirmed.identity !== entry.identity) {
    throw new Error(`Projection state changed while reading: ${path}`)
  }
  return { value: JSON.parse(content) as unknown, identity: entry.identity }
}

async function removeLegacyState(fs: IFileSystem, path: string): Promise<void> {
  const entry = await fs.inspectEntry(path)
  if (!entry) return
  if (entry.kind !== 'file') throw new Error(`Legacy projection state is not a real file: ${path}`)
  await fs.removeEntryIfIdentity(path, entry.identity)
}

function parseManagedMcpState(value: unknown, ownerRepo: string): Record<string, string[]> {
  if (!isRecord(value) || value.version !== 1 || value.ownerRepo !== ownerRepo) {
    throw new Error('Managed MCP projection state identity is invalid')
  }
  return parseManagedMcpAgents(value.agents)
}

function parseLegacyManagedMcpState(value: unknown): Record<string, string[]> {
  return parseManagedMcpAgents(value)
}

function parseManagedMcpAgents(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) throw new Error('Managed MCP projection state agents are invalid')
  const agents: Record<string, string[]> = {}
  for (const [agent, ids] of Object.entries(value)) {
    if (
      !AGENT_IDS.includes(agent as AgentId) ||
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      throw new Error(`Managed MCP projection state agent is invalid: ${agent}`)
    }
    agents[agent] = [...new Set(ids)]
  }
  return agents
}

function parseManagedSkillState(value: unknown, ownerRepo: string): ManagedSkillArtifacts {
  if (!isRecord(value) || value.version !== 1 || value.ownerRepo !== ownerRepo) {
    throw new Error('Managed skill projection state identity is invalid')
  }
  if (!isRecord(value.agents)) throw new Error('Managed skill projection state agents are invalid')
  const artifacts: ManagedSkillArtifacts = {}
  for (const [agent, entries] of Object.entries(value.agents)) {
    if (!AGENT_IDS.includes(agent as AgentId) || !isRecord(entries)) {
      throw new Error(`Managed skill projection state agent is invalid: ${agent}`)
    }
    const parsedEntries: Record<string, { kind: 'link' | 'copy'; source: string }> = {}
    for (const [skillId, artifact] of Object.entries(entries)) {
      if (
        !isSafeManagedSkillId(skillId) ||
        !isRecord(artifact) ||
        (artifact.kind !== 'link' && artifact.kind !== 'copy') ||
        typeof artifact.source !== 'string' ||
        !isAbsolute(artifact.source)
      ) {
        throw new Error(`Managed skill projection state entry is invalid: ${agent}/${skillId}`)
      }
      parsedEntries[skillId] = { kind: artifact.kind, source: artifact.source }
    }
    artifacts[agent as AgentId] = parsedEntries
  }
  return artifacts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function resolveSourceSkillDir(
  repoPath: string,
  source: { repoId: string; cacheId?: string; memberName: string; path?: string },
  sourceCaches: ReadonlyMap<string, AuthorizedSourceCache>,
  enforceSourceAuthorization: boolean,
): string | StableEntry {
  assertSafePathSegment(source.repoId, 'source repository id')
  assertSafePathSegment(source.memberName, 'source member name')
  const cacheId = source.cacheId ?? source.repoId
  assertSafePathSegment(cacheId, 'source cache id')
  const authorized = sourceCaches.get(cacheId)
  if (enforceSourceAuthorization && !authorized) {
    throw new Error(`Source cache is not authorized: ${cacheId}`)
  }
  const root = authorized?.root.canonicalPath ?? cacheDirFor(repoPath, cacheId)
  if (!source.path) return join(root, 'skills', source.memberName)
  assertSafeRelativePath(source.path, 'source member path')
  const normalized = source.path
  const sourceDir =
    normalized === 'SKILL.md' || normalized.endsWith('/SKILL.md')
      ? dirname(normalized)
      : normalized.replace(/\/+$/, '')
  return join(root, sourceDir === '.' ? '' : sourceDir)
}

function isSafeManagedSkillId(value: string): boolean {
  return (
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value.split('/').every((segment) => LocalSkillIdSchema.safeParse(segment).success)
  )
}

function basenameRepo(repoPath: string): string {
  const seg =
    repoPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? 'default'
  return seg || 'default'
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
