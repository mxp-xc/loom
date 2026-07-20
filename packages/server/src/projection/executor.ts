import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { IFileSystem } from '../ports/fs.js'
import type { LoggerPort } from '../ports/logger.js'
import type { IAgentAdapter, McpFragment, UndoAction, ProjectionFailure } from '../ports/adapter.js'
import type {
  ProjectionPlan,
  SourceProjectionPlan,
  McpPlanEntry,
  Manifest,
  AgentId,
  McpServer,
} from '@loom/core'
import {
  resolveVars,
  renderText,
  renderTextWithResolvedVars,
  LocalSkillIdSchema,
  type LayeredVarsResolution,
  type VarsContext,
} from '@loom/core'
import {
  agentSkillsDir,
  agentMemoryFile,
  agentConfigDir,
  contextSupportsAgentCapability,
  agentMcpFile,
  runtimeAgentPathContext,
  type AgentPathContext,
} from '../adapters/paths.js'
import { mergeMcp } from './mcp-merge.js'
import {
  atomicReplaceTextFile,
  assertSafeRelativePath,
  captureAgentDirectoryChain,
  captureSafeDirectoryChain,
  captureSafeDirectoryTree,
  captureStableEntry,
  captureStableRelativeFiles,
  ensureSafeDirectoryChain,
  readStableFile,
  revalidateSafeDirectoryChain,
  revalidateSafeDirectoryTree,
  revalidateStableEntry,
  revalidateStableRelativeFile,
  revalidateStableRelativeFiles,
  type SafeDirectoryChain,
  type StableDirectoryTree,
  type StableEntry,
  type StableRelativeFiles,
} from './fs-boundary.js'

export interface ProjectionDeps {
  fs: IFileSystem
  ownerRepo?: string
  adapters: Partial<Record<AgentId, IAgentAdapter>>
  installedAgents: Set<AgentId>
  pathContext?: AgentPathContext
  resolveSkillSrc: (link: ProjectionPlan['links'][number]) => string | StableEntry | null
  resolveSourceRoot?: (sourcePlan: SourceProjectionPlan) => string | StableEntry | null
  resolveSourceFiles?: (sourcePlan: SourceProjectionPlan) => Promise<string[]>
  logger?: Pick<LoggerPort, 'error' | 'warn'>
  // Per-agent set of mcp ids loom projected last time (persisted by caller).
  // Used to distinguish loom-managed entries (removable) from user-handwritten (preserved).
  // Absent => first run / state lost: mergeMcp degrades to preserving all existing entries.
  getManagedMcpIds?: (agent: AgentId) => Promise<Set<string>>
  setManagedMcpIds?: (agent: AgentId, ids: string[]) => Promise<void>
  getManagedSkillArtifacts?: () => Promise<ManagedSkillArtifacts>
  setManagedSkillArtifacts?: (artifacts: ManagedSkillArtifacts) => Promise<void>
}

export interface ManagedSkillArtifact {
  kind: 'link' | 'copy'
  source: string
}

export type ManagedSkillArtifacts = Partial<Record<AgentId, Record<string, ManagedSkillArtifact>>>

export interface ProjectionWarning {
  code: 'source-unavailable'
  sourceName: string
  sourceUrl: string
  message: string
}

export type ProjectionResult =
  { ok: true; warnings?: ProjectionWarning[] } | { ok: false; failure: ProjectionFailure }

export type ProjectionScope = 'skills' | 'mcp' | 'memory' | 'all'
const COPY_MARKER = '.loom-projection.json'
const SOURCE_MARKER_KIND = 'skill-source'

type StateUndo = {
  kind: 'restoreState'
  path: string
  restore: () => Promise<void>
}

interface ProjectionJournal {
  undos: (UndoAction | StateUndo)[]
}

export interface AgentAwareVarsContext extends VarsContext {
  resolveForAgent?: (agent: AgentId) => Promise<LayeredVarsResolution>
}

export async function executeProjection(
  plan: ProjectionPlan,
  manifest: Manifest,
  varsCtx: AgentAwareVarsContext,
  deps: ProjectionDeps,
  scope: ProjectionScope = 'all',
): Promise<ProjectionResult> {
  if (manifest.errors.length > 0) {
    return {
      ok: false,
      failure: {
        failedStep: 'manifest-invalid',
        originalError: new Error(manifest.errors.join('; ')),
        rollbackReport: { undone: 0, rollbackFailures: [] },
      },
    }
  }
  const journal: ProjectionJournal = { undos: [] }
  const { fs, installedAgents } = deps
  const pathContext = deps.pathContext ?? runtimeAgentPathContext()
  const installedSkillAgents = new Set(
    [...installedAgents].filter((agent) =>
      contextSupportsAgentCapability(agent, 'skills', pathContext),
    ),
  )
  try {
    const preparedSkills =
      scope === 'skills' || scope === 'all'
        ? await prepareSkillProjection(plan, installedSkillAgents, deps)
        : null
    const preparedSources =
      scope === 'skills' || scope === 'all' ? await prepareSourceNamespaces(plan, deps) : null
    const preparedMcp =
      scope === 'mcp' || scope === 'all'
        ? await prepareMcpProjection(plan, manifest, varsCtx, deps)
        : []
    const preparedMemory =
      scope === 'memory' || scope === 'all'
        ? await prepareMemoryProjection(plan, varsCtx, deps)
        : []
    // Phase A: build enabled links
    if (scope === 'skills' || scope === 'all') {
      await applySkillProjection(preparedSkills!, plan.strategy, deps, journal)
      await projectSourceNamespaces(plan, deps, journal, preparedSources!)
    }
    // MCP config
    if (scope === 'mcp' || scope === 'all') {
      for (const {
        agent,
        adapter,
        file,
        snapshot,
        chain,
        merged,
        managedIds,
        previouslyManaged,
      } of preparedMcp) {
        await revalidateSafeDirectoryChain(fs, chain, `${agent} mcp destination`)
        await revalidateFileSnapshot(fs, file, snapshot, `${agent} MCP destination`)
        await ensureSafeDirectoryChain(fs, chain, `${agent} mcp destination`)
        await revalidateFileSnapshot(fs, file, snapshot, `${agent} MCP destination`)
        const undo: Extract<UndoAction, { kind: 'restoreMcp' }> = {
          kind: 'restoreMcp',
          path: file,
          backup: snapshot.content,
        }
        journal.undos.push(undo)
        let installedIdentity: string | undefined
        await adapter.writeMcp(
          snapshotFileSystem(fs, file, snapshot, (content) =>
            atomicReplaceTextFile(fs, file, content, snapshot.entry?.identity ?? null).then(
              (installed) => {
                installedIdentity = installed.identity
              },
            ),
          ),
          merged,
        )
        if (!installedIdentity) throw new Error(`${agent} MCP destination was not installed`)
        undo.installedIdentity = installedIdentity
        if (deps.setManagedMcpIds) {
          journal.undos.push({
            kind: 'restoreState',
            path: `${agent} managed MCP state`,
            restore: () => deps.setManagedMcpIds!(agent, [...previouslyManaged]),
          })
          await deps.setManagedMcpIds(agent, managedIds)
        }
      }
    }
    // Phase D: memory projection
    if (scope === 'memory' || scope === 'all') {
      if (preparedMemory.length === 0) {
        deps.logger?.warn?.('no assigned memory, skip memory phase')
      }
      for (const { agent, path, rendered, snapshot, chain } of preparedMemory) {
        await revalidateSafeDirectoryChain(fs, chain, `${agent} memory destination`)
        await revalidateFileSnapshot(fs, path, snapshot, `${agent} memory destination`)
        await ensureSafeDirectoryChain(fs, chain, `${agent} memory destination`)
        await revalidateFileSnapshot(fs, path, snapshot, `${agent} memory destination`)
        const undo: Extract<UndoAction, { kind: 'restoreMemory' }> = {
          kind: 'restoreMemory',
          path,
          backup: snapshot.content,
        }
        journal.undos.push(undo)
        const installed = await atomicReplaceTextFile(
          fs,
          path,
          rendered,
          snapshot.entry?.identity ?? null,
        )
        undo.installedIdentity = installed.identity
      }
    }
    if (preparedSkills && deps.setManagedSkillArtifacts) {
      journal.undos.push({
        kind: 'restoreState',
        path: 'managed skill state',
        restore: () => deps.setManagedSkillArtifacts!(preparedSkills.currentArtifacts),
      })
      await deps.setManagedSkillArtifacts(preparedSkills.nextArtifacts)
    }
    if (preparedSkills) {
      for (const action of preparedSkills.actions) {
        if (action.operation === 'remove') {
          await removeEmptySkillParents(fs, action.skillsDir, action.destination)
        }
      }
    }
    const cleanupFailures = await discardNamespaceBackups(journal, fs, deps.logger)
    if (cleanupFailures.length > 0) {
      const originalError = new AggregateError(
        cleanupFailures.map(({ err }) => err),
        'projection completed but backup cleanup failed',
      )
      deps.logger?.error('projection backup cleanup failed', {
        err: originalError,
        cleanupFailures,
      })
      return {
        ok: false,
        failure: {
          failedStep: 'cleanup',
          originalError,
          rollbackReport: { undone: 0, rollbackFailures: cleanupFailures },
        },
      }
    }
    const warnings = preparedSkills?.warnings ?? []
    return warnings.length > 0 ? { ok: true, warnings } : { ok: true }
  } catch (originalError) {
    const rollbackFailures: { path: string; err: unknown }[] = []
    let undone = 0
    for (const u of [...journal.undos].reverse()) {
      try {
        if (u.kind === 'restoreState') await u.restore()
        else await applyUndo(u, fs)
        undone++
      } catch (e) {
        rollbackFailures.push({ path: u.path, err: e })
        deps.logger?.error('projection rollback step failed', { err: e, undo: u })
      }
    }
    deps.logger?.error('projection failed, rolled back', {
      err: originalError,
      rollbackReport: { undone, rollbackFailures },
    })
    return {
      ok: false,
      failure: {
        failedStep: 'projection',
        originalError,
        rollbackReport: { undone, rollbackFailures },
      },
    }
  }
}

type AgentMcpConfig = Awaited<ReturnType<IAgentAdapter['readMcp']>>

interface PreparedMcpProjection {
  agent: AgentId
  adapter: IAgentAdapter
  file: string
  snapshot: StableFileSnapshot
  chain: SafeDirectoryChain
  merged: AgentMcpConfig
  managedIds: string[]
  previouslyManaged: Set<string>
}

async function prepareMcpProjection(
  plan: ProjectionPlan,
  manifest: Manifest,
  varsCtx: AgentAwareVarsContext,
  deps: ProjectionDeps,
): Promise<PreparedMcpProjection[]> {
  const prepared: PreparedMcpProjection[] = []
  const pathContext = deps.pathContext ?? runtimeAgentPathContext()
  for (const agent of Object.keys(deps.adapters) as AgentId[]) {
    const adapter = deps.adapters[agent]
    if (!adapter) continue
    const fragments = await resolveMcpFragments(
      plan.mcpEntries,
      manifest.mcp,
      agent,
      varsCtx,
      deps.logger,
    )
    const previouslyManaged = (await deps.getManagedMcpIds?.(agent)) ?? new Set<string>()
    if (fragments.length === 0 && previouslyManaged.size === 0) continue
    const file = normalize(adapter.path)
    if (file !== normalize(agentMcpFile(agent, pathContext))) {
      throw new Error(`MCP adapter path does not match the agent destination: ${file}`)
    }
    const chain = await captureAgentDirectoryChain(
      deps.fs,
      agent,
      'mcp',
      dirname(file),
      pathContext,
    )
    const snapshot = await readOptionalStableFile(deps.fs, file, 'MCP destination')
    const existing = await adapter.readMcp(snapshotFileSystem(deps.fs, file, snapshot))
    prepared.push({
      agent,
      adapter,
      file,
      snapshot,
      chain,
      merged: mergeMcp(existing, fragments, previouslyManaged),
      managedIds: fragments.map((fragment) => fragment.id),
      previouslyManaged,
    })
  }
  return prepared
}

interface PreparedMemoryProjection {
  agent: AgentId
  path: string
  rendered: string
  snapshot: StableFileSnapshot
  chain: SafeDirectoryChain
}

async function prepareMemoryProjection(
  plan: ProjectionPlan,
  varsCtx: AgentAwareVarsContext,
  deps: ProjectionDeps,
): Promise<PreparedMemoryProjection[]> {
  const memoryPlan = plan.memoryPlan
  const entries =
    memoryPlan.entries ??
    (memoryPlan.active && memoryPlan.content !== null
      ? [
          {
            memory: memoryPlan.active,
            content: memoryPlan.content,
            agents: memoryPlan.agents,
          },
        ]
      : [])
  const pathContext = deps.pathContext ?? runtimeAgentPathContext()
  const resolutions = new Map<AgentId, Promise<LayeredVarsResolution>>()
  const destinations = new Set<string>()
  const prepared: PreparedMemoryProjection[] = []
  for (const entry of entries) {
    for (const agent of entry.agents) {
      if (!deps.installedAgents.has(agent)) {
        throw new Error(`Memory projection targets an unavailable agent: ${agent}`)
      }
      const path = agentMemoryFile(agent, pathContext)
      if (destinations.has(path))
        throw new Error(`Duplicate memory projection destination: ${path}`)
      destinations.add(path)
      const chain = await captureAgentDirectoryChain(
        deps.fs,
        agent,
        'memory',
        dirname(path),
        pathContext,
      )
      const ctx: VarsContext = {
        env: {
          ...varsCtx.env,
          LOOM_AGENT: agent,
          LOOM_CONFIG_DIR: agentConfigDir(agent, pathContext),
          LOOM_SKILLS_DIR: contextSupportsAgentCapability(agent, 'skills', pathContext)
            ? agentSkillsDir(agent, pathContext)
            : '',
          LOOM_AGENT_FILE: basename(path),
        },
        activeProfile: varsCtx.activeProfile,
        defaultProfile: varsCtx.defaultProfile,
      }
      let rendered: string
      try {
        if (varsCtx.resolveForAgent) {
          let resolution = resolutions.get(agent)
          if (!resolution) {
            resolution = varsCtx.resolveForAgent(agent)
            resolutions.set(agent, resolution)
          }
          const value = await resolution
          if (!value.ok) throw new Error(value.diagnostics.map((item) => item.message).join('; '))
          const renderResult = renderTextWithResolvedVars(entry.content, value)
          if (!renderResult.ok) {
            throw new Error(renderResult.diagnostics.map((item) => item.message).join('; '))
          }
          rendered = renderResult.text
        } else {
          rendered = renderText(entry.content, ctx)
        }
      } catch (err) {
        deps.logger?.error('memory var resolve failed', { err, agent })
        throw err
      }
      prepared.push({
        agent,
        path,
        rendered,
        snapshot: await readOptionalStableFile(deps.fs, path, 'memory destination'),
        chain,
      })
    }
  }
  return prepared
}

interface StableFileSnapshot {
  content: string | null
  entry: StableEntry | null
}

async function readOptionalStableFile(
  fs: IFileSystem,
  path: string,
  description: string,
): Promise<StableFileSnapshot> {
  const entry = await fs.inspectEntry(path)
  if (!entry) return { content: null, entry: null }
  if (entry.kind !== 'file') throw new Error(`${description} is not a real file: ${path}`)
  const stable = await readStableFile(fs, path, description)
  return { content: stable.content, entry: stable.entry }
}

async function revalidateFileSnapshot(
  fs: IFileSystem,
  path: string,
  expected: StableFileSnapshot,
  description: string,
): Promise<void> {
  if (!expected.entry) {
    if (await fs.inspectEntry(path))
      throw new Error(`${description} appeared after preflight: ${path}`)
    return
  }
  const current = await readStableFile(fs, path, description)
  if (
    current.entry.identity !== expected.entry.identity ||
    current.entry.canonicalPath !== expected.entry.canonicalPath ||
    current.content !== expected.content
  ) {
    throw new Error(`${description} changed after preflight: ${path}`)
  }
}

function snapshotFileSystem(
  fs: IFileSystem,
  targetPath: string,
  snapshot: StableFileSnapshot,
  write?: (content: string) => Promise<void>,
): IFileSystem {
  const normalizedTarget = normalize(targetPath)
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'exists') {
        return async (path: string) =>
          normalize(path) === normalizedTarget ? snapshot.entry !== null : target.exists(path)
      }
      if (property === 'readFile') {
        return async (path: string) => {
          if (normalize(path) !== normalizedTarget) return target.readFile(path)
          if (snapshot.content !== null) return snapshot.content
          throw Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' })
        }
      }
      if (property === 'writeFile') {
        return async (path: string, content: string) => {
          if (normalize(path) !== normalizedTarget) return target.writeFile(path, content)
          if (!write) throw new Error(`Projection snapshot is read-only: ${path}`)
          await write(content)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

type PreparedSkillAction = {
  agent: AgentId
  skillId: string
  skillsDir: string
  destination: string
  source: StableDirectoryTree | null
  operation: 'build' | 'remove'
  destinationChain: SafeDirectoryChain
  transactionChain: SafeDirectoryChain
  ownership: ManagedArtifactInspection
  expectedArtifact?: ManagedSkillArtifact
}

interface PreparedSkillProjection {
  actions: PreparedSkillAction[]
  currentArtifacts: ManagedSkillArtifacts
  nextArtifacts: ManagedSkillArtifacts
  warnings: ProjectionWarning[]
}

async function prepareSkillProjection(
  plan: ProjectionPlan,
  installedAgents: Set<AgentId>,
  deps: ProjectionDeps,
): Promise<PreparedSkillProjection> {
  const currentArtifacts = (await deps.getManagedSkillArtifacts?.()) ?? {}
  const nextArtifacts = cloneManagedSkillArtifacts(currentArtifacts)
  const actions: PreparedSkillAction[] = []
  const warnings: ProjectionWarning[] = []
  const warnedUnavailable = new Set<string>()
  const planSkillIds = new Set<string>()
  const pathContext = deps.pathContext ?? runtimeAgentPathContext()

  for (const link of plan.links) {
    assertSafeSkillDestination(link.skillId, link.source === 'local')
    if (planSkillIds.has(link.skillId)) {
      throw new Error(`Duplicate projection skill destination: ${link.skillId}`)
    }
    planSkillIds.add(link.skillId)
    for (const agent of link.agents) {
      if (!installedAgents.has(agent)) {
        throw new Error(`Projection plan targets an unavailable agent: ${agent}`)
      }
    }

    const resolvedSource = deps.resolveSkillSrc(link)
    let source: StableDirectoryTree | null = null
    if (resolvedSource) {
      const root =
        typeof resolvedSource === 'string'
          ? await captureStableEntry(
              deps.fs,
              resolvedSource,
              'directory',
              `skill source ${link.skillId}`,
            )
          : resolvedSource
      await revalidateStableEntry(deps.fs, root, `skill source ${link.skillId}`)
      source = await captureSafeDirectoryTree(deps.fs, root, `skill source ${link.skillId}`)
    }
    const agents = new Set<AgentId>([...installedAgents, ...link.agents])
    for (const agent of agents) {
      const skillsDir = agentSkillsDir(agent, pathContext)
      const destination = safeSkillDestination(skillsDir, link.skillId)
      const destinationChain = await captureAgentDirectoryChain(
        deps.fs,
        agent,
        'skills',
        dirname(destination),
        pathContext,
      )
      const transactionChain = await captureAgentDirectoryChain(
        deps.fs,
        agent,
        'skills',
        dirname(localSkillTransactionPath(skillsDir, destination, 'staging', 'preflight')),
        pathContext,
      )
      const expectedArtifact = currentArtifacts[agent]?.[link.skillId]
      const ownership = await inspectManagedSkillArtifact(
        deps.fs,
        destination,
        expectedArtifact,
        deps.ownerRepo,
        link.skillId,
        deps.logger,
      )
      const desired = link.agents.includes(agent)
      if (desired) {
        if (ownership.state === 'unowned') {
          throw new Error(`refuse to overwrite user-owned skill destination: ${destination}`)
        }
        if (!source) {
          if (ownership.state === 'absent' && expectedArtifact) {
            deleteManagedSkillArtifact(nextArtifacts, agent, link.skillId)
          }
          if (!warnedUnavailable.has(link.skillId)) {
            warnedUnavailable.add(link.skillId)
            warnings.push({
              code: 'source-unavailable',
              sourceName: link.skillId,
              sourceUrl:
                link.source === 'local' ? (link.localPath ?? link.skillId) : link.source.repoId,
              message: `Skill source unavailable: ${link.skillId}`,
            })
          }
          continue
        }
        actions.push({
          agent,
          skillId: link.skillId,
          skillsDir,
          destination,
          source,
          operation: 'build',
          destinationChain,
          transactionChain,
          ownership,
          ...(expectedArtifact ? { expectedArtifact } : {}),
        })
        continue
      }
      if (ownership.state === 'owned') {
        actions.push({
          agent,
          skillId: link.skillId,
          skillsDir,
          destination,
          source,
          operation: 'remove',
          destinationChain,
          transactionChain,
          ownership,
          expectedArtifact: expectedArtifact!,
        })
      }
      if (ownership.state !== 'owned')
        deleteManagedSkillArtifact(nextArtifacts, agent, link.skillId)
    }
  }

  for (const agent of installedAgents) {
    for (const [skillId, expectedArtifact] of Object.entries(currentArtifacts[agent] ?? {})) {
      if (planSkillIds.has(skillId)) continue
      assertSafeSkillDestination(skillId, true)
      const skillsDir = agentSkillsDir(agent, pathContext)
      const destination = safeSkillDestination(skillsDir, skillId)
      const destinationChain = await captureAgentDirectoryChain(
        deps.fs,
        agent,
        'skills',
        dirname(destination),
        pathContext,
      )
      const transactionChain = await captureAgentDirectoryChain(
        deps.fs,
        agent,
        'skills',
        dirname(localSkillTransactionPath(skillsDir, destination, 'staging', 'preflight')),
        pathContext,
      )
      const ownership = await inspectManagedSkillArtifact(
        deps.fs,
        destination,
        expectedArtifact,
        deps.ownerRepo,
        skillId,
        deps.logger,
      )
      if (ownership.state === 'owned') {
        actions.push({
          agent,
          skillId,
          skillsDir,
          destination,
          source: null,
          operation: 'remove',
          destinationChain,
          transactionChain,
          ownership,
          expectedArtifact,
        })
      } else {
        deleteManagedSkillArtifact(nextArtifacts, agent, skillId)
      }
    }
  }

  return { actions, currentArtifacts, nextArtifacts, warnings }
}

async function applySkillProjection(
  prepared: PreparedSkillProjection,
  strategy: ProjectionPlan['strategy'],
  deps: ProjectionDeps,
  journal: ProjectionJournal,
): Promise<void> {
  for (const action of prepared.actions) {
    await revalidateSafeDirectoryChain(
      deps.fs,
      action.destinationChain,
      `${action.agent} skills destination`,
    )
    await revalidateSafeDirectoryChain(
      deps.fs,
      action.transactionChain,
      `${action.agent} skills transaction directory`,
    )
    await revalidateManagedSkillInspection(
      deps.fs,
      action.ownership,
      action.expectedArtifact,
      deps.ownerRepo,
      action.skillId,
      deps.logger,
    )
    if (action.operation === 'remove') {
      await moveLocalSkillToBackup(action, deps, journal)
      deleteManagedSkillArtifact(prepared.nextArtifacts, action.agent, action.skillId)
      continue
    }

    await revalidateSafeDirectoryTree(deps.fs, action.source!, `skill source ${action.skillId}`)
    await ensureSafeDirectoryChain(
      deps.fs,
      action.destinationChain,
      `${action.agent} skills destination`,
    )
    const artifact = await replaceLocalSkillArtifact(action, strategy, deps, journal)
    setManagedSkillArtifact(prepared.nextArtifacts, action.agent, action.skillId, {
      kind: artifact.kind,
      source: action.source!.root.canonicalPath,
    })
  }
}

function assertSafeSkillDestination(skillId: string, local: boolean): void {
  if (!skillId || isAbsolute(skillId) || skillId.includes('\\')) {
    throw new Error(`Invalid projection skill destination: ${skillId}`)
  }
  const parts = skillId.split('/')
  if (
    parts.some((part) => !part || !LocalSkillIdSchema.safeParse(part).success) ||
    (local && parts.length !== 1)
  ) {
    throw new Error(`Invalid projection skill destination: ${skillId}`)
  }
}

function safeSkillDestination(skillsDir: string, skillId: string): string {
  const destination = join(skillsDir, ...skillId.split('/'))
  const rel = relative(skillsDir, destination)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Projection destination escaped the agent skills directory: ${skillId}`)
  }
  return destination
}

type ManagedArtifactOwnership = 'absent' | 'owned' | 'unowned'

interface EntryObservation {
  path: string
  kind: 'file' | 'directory' | 'link' | 'other'
  identity: string
}

interface ManagedArtifactInspection {
  path: string
  state: ManagedArtifactOwnership
  destination: EntryObservation | null
  marker?: StableFileSnapshot
}

async function inspectManagedSkillArtifact(
  fs: IFileSystem,
  destination: string,
  expected: ManagedSkillArtifact | undefined,
  ownerRepo: string | undefined,
  skillId: string,
  logger?: ProjectionDeps['logger'],
): Promise<ManagedArtifactInspection> {
  const entry = await fs.inspectEntry(destination)
  if (!entry) return { path: destination, state: 'absent', destination: null }
  const observed = { path: destination, kind: entry.kind, identity: entry.identity }
  if (!expected) return { path: destination, state: 'unowned', destination: observed }
  if (entry.kind === 'link') {
    if (expected.kind !== 'link')
      return { path: destination, state: 'unowned', destination: observed }
    const target = normalize(resolve(dirname(destination), await fs.readLink(destination)))
    const confirmed = await fs.inspectEntry(destination)
    if (confirmed?.kind !== 'link' || confirmed.identity !== entry.identity) {
      throw new Error(`Skill destination changed during ownership inspection: ${destination}`)
    }
    return {
      path: destination,
      state: target === normalize(expected.source) ? 'owned' : 'unowned',
      destination: observed,
    }
  }
  if (entry.kind !== 'directory' || expected.kind !== 'copy') {
    return { path: destination, state: 'unowned', destination: observed }
  }
  const directory = await captureStableEntry(fs, destination, 'directory', 'skill destination')
  if (directory.identity !== entry.identity) {
    throw new Error(`Skill destination changed during ownership inspection: ${destination}`)
  }
  const markerPath = join(destination, COPY_MARKER)
  const markerEntry = await fs.inspectEntry(markerPath)
  if (markerEntry?.kind !== 'file') {
    return { path: destination, state: 'unowned', destination: observed }
  }
  let marker: unknown
  let markerSnapshot: StableFileSnapshot
  try {
    markerSnapshot = await readOptionalStableFile(fs, markerPath, 'skill ownership marker')
    marker = JSON.parse(markerSnapshot.content!)
  } catch (err) {
    if (err instanceof SyntaxError) {
      logger?.error('failed to parse managed skill ownership marker', {
        err,
        destination,
        markerPath,
      })
      return { path: destination, state: 'unowned', destination: observed }
    }
    throw err
  }
  if (!marker || typeof marker !== 'object') {
    return { path: destination, state: 'unowned', destination: observed }
  }
  const value = marker as Record<string, unknown>
  const owned =
    value.version === 1 &&
    value.managedBy === 'loom' &&
    value.kind === 'local-skill' &&
    value.ownerRepo === (ownerRepo ?? 'unscoped') &&
    value.skillId === skillId &&
    value.source === expected.source
  if (!owned) {
    logger?.warn?.('managed skill ownership marker identity mismatch', {
      destination,
      markerPath,
      expectedOwnerRepo: ownerRepo ?? 'unscoped',
      expectedSkillId: skillId,
    })
  }
  return {
    path: destination,
    state: owned ? 'owned' : 'unowned',
    destination: observed,
    marker: markerSnapshot,
  }
}

async function revalidateManagedSkillInspection(
  fs: IFileSystem,
  expected: ManagedArtifactInspection,
  artifact: ManagedSkillArtifact | undefined,
  ownerRepo: string | undefined,
  skillId: string,
  logger?: ProjectionDeps['logger'],
): Promise<void> {
  const currentEntry = await fs.inspectEntry(expected.path)
  if (!expected.destination) {
    if (currentEntry) throw new Error(`Skill destination appeared after preflight: ${skillId}`)
    return
  }
  if (
    !currentEntry ||
    currentEntry.kind !== expected.destination.kind ||
    currentEntry.identity !== expected.destination.identity
  ) {
    throw new Error(
      `Skill destination identity changed after preflight: ${expected.destination.path}`,
    )
  }
  if (expected.marker) {
    await revalidateFileSnapshot(
      fs,
      expected.marker.entry!.path,
      expected.marker,
      'skill ownership marker',
    )
  }
  const current = await inspectManagedSkillArtifact(
    fs,
    expected.destination.path,
    artifact,
    ownerRepo,
    skillId,
    logger,
  )
  if (
    current.state !== expected.state ||
    !sameEntryObservation(current.destination, expected.destination)
  ) {
    throw new Error(
      `Skill destination ownership changed after preflight: ${expected.destination.path}`,
    )
  }
}

function sameEntryObservation(
  left: EntryObservation | null,
  right: EntryObservation | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.path === right.path &&
      left.kind === right.kind &&
      left.identity === right.identity)
  )
}

async function replaceLocalSkillArtifact(
  action: PreparedSkillAction,
  strategy: ProjectionPlan['strategy'],
  deps: ProjectionDeps,
  journal: ProjectionJournal,
): Promise<ManagedSkillArtifact> {
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const staging = localSkillTransactionPath(action.skillsDir, action.destination, 'staging', suffix)
  const backup = localSkillTransactionPath(action.skillsDir, action.destination, 'backup', suffix)
  await ensureSafeDirectoryChain(
    deps.fs,
    action.transactionChain,
    `${action.agent} skills transaction directory`,
  )
  if ((await deps.fs.inspectEntry(staging)) || (await deps.fs.inspectEntry(backup))) {
    throw new Error(`Local skill transaction path already exists: ${action.destination}`)
  }

  let restoreUndo: Extract<UndoAction, { kind: 'restoreNamespace' }> | null = null
  try {
    await revalidateSafeDirectoryTree(deps.fs, action.source!, `skill source ${action.skillId}`)
    let kind: ManagedSkillArtifact['kind']
    if (strategy === 'copy') {
      await copyStableDirectoryTree(
        deps.fs,
        action.source!,
        staging,
        `skill source ${action.skillId}`,
      )
      kind = 'copy'
    } else {
      const result = await deps.fs.createLink(action.source!.root.canonicalPath, staging)
      if (result.fallback === 'copy') {
        await deps.fs.removeDir(staging)
        await copyStableDirectoryTree(
          deps.fs,
          action.source!,
          staging,
          `skill source ${action.skillId}`,
        )
        kind = 'copy'
      } else {
        kind = 'link'
      }
    }
    await revalidateSafeDirectoryTree(deps.fs, action.source!, `skill source ${action.skillId}`)
    if (kind === 'copy') {
      await writeCopyMarker(
        deps.fs,
        staging,
        action.skillId,
        deps.ownerRepo ?? 'unscoped',
        action.source!.root.canonicalPath,
      )
    }
    await revalidateManagedSkillInspection(
      deps.fs,
      action.ownership,
      action.expectedArtifact,
      deps.ownerRepo,
      action.skillId,
      deps.logger,
    )

    if (action.ownership.state === 'owned') {
      await deps.fs.moveNoReplace(
        action.destination,
        backup,
        action.ownership.destination!.identity,
      )
      const backupEntry = await requireInstalledNamespace(deps.fs, backup)
      restoreUndo = {
        kind: 'restoreNamespace',
        path: action.destination,
        backupPath: backup,
        backupIdentity: backupEntry.identity,
      }
      journal.undos.push(restoreUndo)
    }
    const stagingEntry = await requireInstalledNamespace(deps.fs, staging)
    try {
      await deps.fs.moveNoReplace(staging, action.destination, stagingEntry.identity)
    } catch (err) {
      if (restoreUndo) {
        try {
          await applyUndo(restoreUndo, deps.fs)
          journal.undos.splice(journal.undos.lastIndexOf(restoreUndo), 1)
        } catch (restoreError) {
          deps.logger?.error('local skill immediate restore failed', {
            err: restoreError,
            destination: action.destination,
            backup,
          })
        }
      }
      throw err
    }
    const installed = await requireInstalledNamespace(deps.fs, action.destination)
    if (!restoreUndo) {
      journal.undos.push({
        kind: 'restoreNamespace',
        path: action.destination,
        backupPath: null,
        installedKind: installed.kind,
        installedIdentity: installed.identity,
      })
    } else {
      restoreUndo.installedKind = installed.kind
      restoreUndo.installedIdentity = installed.identity
    }
    await revalidateSafeDirectoryTree(deps.fs, action.source!, `skill source ${action.skillId}`)
    return { kind, source: action.source!.root.canonicalPath }
  } catch (err) {
    try {
      await deps.fs.removeDir(staging)
    } catch (cleanupError) {
      deps.logger?.error('failed to clean local skill staging artifact', {
        err: cleanupError,
        staging,
      })
      throw new AggregateError([err, cleanupError], 'local skill projection and cleanup failed', {
        cause: err,
      })
    }
    throw err
  }
}

async function moveLocalSkillToBackup(
  action: PreparedSkillAction,
  deps: ProjectionDeps,
  journal: ProjectionJournal,
): Promise<void> {
  const backup = localSkillTransactionPath(
    action.skillsDir,
    action.destination,
    'backup',
    `${process.pid}-${crypto.randomUUID()}`,
  )
  await ensureSafeDirectoryChain(
    deps.fs,
    action.transactionChain,
    `${action.agent} skills transaction directory`,
  )
  await revalidateManagedSkillInspection(
    deps.fs,
    action.ownership,
    action.expectedArtifact,
    deps.ownerRepo,
    action.skillId,
    deps.logger,
  )
  if (await deps.fs.inspectEntry(backup)) {
    throw new Error(`Local skill backup path already exists: ${action.destination}`)
  }
  await deps.fs.moveNoReplace(action.destination, backup, action.ownership.destination!.identity)
  const backupEntry = await requireInstalledNamespace(deps.fs, backup)
  journal.undos.push({
    kind: 'restoreNamespace',
    path: action.destination,
    backupPath: backup,
    backupIdentity: backupEntry.identity,
  })
}

async function copyStableDirectoryTree(
  fs: IFileSystem,
  tree: StableDirectoryTree,
  destination: string,
  description: string,
): Promise<void> {
  await revalidateSafeDirectoryTree(fs, tree, description)
  await fs.mkdir(destination, false)
  for (const entry of tree.entries) {
    const relativePath = relative(tree.root.canonicalPath, entry.canonicalPath)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`${description} entry escaped its root: ${entry.path}`)
    }
    const target = join(destination, relativePath)
    if (entry.kind === 'directory') {
      await fs.mkdir(target, true)
      continue
    }
    await revalidateStableEntry(fs, entry, description)
    await fs.copyFileNoFollow(entry.path, target, entry.identity)
    await revalidateStableEntry(fs, entry, description)
  }
  await revalidateSafeDirectoryTree(fs, tree, description)
}

async function requireInstalledNamespace(
  fs: IFileSystem,
  path: string,
): Promise<{ kind: 'directory' | 'link'; identity: string }> {
  const entry = await fs.inspectEntry(path)
  if (!entry || (entry.kind !== 'directory' && entry.kind !== 'link')) {
    throw new Error(`Installed projection artifact is invalid: ${path}`)
  }
  return { kind: entry.kind, identity: entry.identity }
}

function localSkillTransactionPath(
  skillsDir: string,
  destination: string,
  kind: 'staging' | 'backup',
  suffix: string,
): string {
  const key = sha256(relative(skillsDir, destination)).slice(0, 16)
  return join(dirname(skillsDir), '.loom-projection-transactions', `${key}.loom-${kind}-${suffix}`)
}

function cloneManagedSkillArtifacts(artifacts: ManagedSkillArtifacts): ManagedSkillArtifacts {
  return Object.fromEntries(
    Object.entries(artifacts).map(([agent, entries]) => [
      agent,
      Object.fromEntries(
        Object.entries(entries ?? {}).map(([skillId, artifact]) => [skillId, { ...artifact }]),
      ),
    ]),
  ) as ManagedSkillArtifacts
}

function setManagedSkillArtifact(
  artifacts: ManagedSkillArtifacts,
  agent: AgentId,
  skillId: string,
  artifact: ManagedSkillArtifact,
): void {
  const entries = artifacts[agent] ?? {}
  entries[skillId] = artifact
  artifacts[agent] = entries
}

function deleteManagedSkillArtifact(
  artifacts: ManagedSkillArtifacts,
  agent: AgentId,
  skillId: string,
): void {
  const entries = artifacts[agent]
  if (!entries) return
  delete entries[skillId]
  if (Object.keys(entries).length === 0) delete artifacts[agent]
}

interface PreparedSourceNamespace {
  plan: SourceProjectionPlan
  sourceFiles: StableRelativeFiles
  directoryLinks: Map<string, StableDirectoryTree>
  namespace: string
  destinationChain: SafeDirectoryChain
  transactionChain: SafeDirectoryChain
  ownership: ManagedSourceNamespaceInspection
}

interface PreparedSourceCleanup {
  namespace: string
  destinationChain: SafeDirectoryChain
  transactionChain: SafeDirectoryChain
  ownership: ManagedSourceNamespaceInspection
}

interface PreparedSourceNamespaces {
  namespaces: PreparedSourceNamespace[]
  desired: Set<string>
  preservedSourceKeysByAgent: Map<AgentId, Set<string>>
  cleanups: PreparedSourceCleanup[]
}

async function prepareSourceNamespaces(
  plan: ProjectionPlan,
  deps: ProjectionDeps,
): Promise<PreparedSourceNamespaces> {
  if ((plan.sourcePlans?.length ?? 0) > 0 && !deps.ownerRepo) {
    throw new Error('Source projection ownerRepo is unavailable')
  }
  if ((plan.sourcePlans?.length ?? 0) > 0 && !deps.resolveSourceFiles) {
    throw new Error('Source projection tracked file resolver is unavailable')
  }
  const pathContext = deps.pathContext ?? runtimeAgentPathContext()
  const desired = new Set<string>()
  const preservedSourceKeysByAgent = new Map<AgentId, Set<string>>()
  for (const preserved of plan.preservedSourceNamespaces ?? []) {
    assertSafeNamespaceSegment(preserved.sourceName, 'preserved source namespace')
    if (!deps.installedAgents.has(preserved.agent)) {
      throw new Error(`Preserved source namespace targets an unavailable agent: ${preserved.agent}`)
    }
    const skillsDir = agentSkillsDir(preserved.agent, pathContext)
    await captureAgentDirectoryChain(deps.fs, preserved.agent, 'skills', skillsDir, pathContext)
    const namespace = join(skillsDir, preserved.sourceName)
    const ownership = await inspectManagedSourceNamespace(deps.fs, namespace, {
      ownerRepo: deps.ownerRepo,
      sourceKey: sha256(preserved.sourceUrl),
    })
    if (ownership.state === 'unowned') {
      throw new Error(`Preserved source namespace is not owned: ${namespace}`)
    }
    desired.add(namespace)
    const sourceKeys = preservedSourceKeysByAgent.get(preserved.agent) ?? new Set<string>()
    sourceKeys.add(sha256(preserved.sourceUrl))
    preservedSourceKeysByAgent.set(preserved.agent, sourceKeys)
  }

  const sourceFilesByTree = new Map<string, Promise<string[]>>()
  const namespaces: PreparedSourceNamespace[] = []
  for (const sourcePlan of plan.sourcePlans ?? []) {
    assertSafeNamespaceSegment(sourcePlan.sourceName, 'source namespace')
    if (!deps.installedAgents.has(sourcePlan.agent)) {
      throw new Error(`Source namespace targets an unavailable agent: ${sourcePlan.agent}`)
    }
    const resolvedRoot = deps.resolveSourceRoot?.(sourcePlan)
    if (!resolvedRoot) throw new Error(`Source cache unavailable: ${sourcePlan.sourceUrl}`)
    const sourceRoot =
      typeof resolvedRoot === 'string'
        ? await captureStableEntry(
            deps.fs,
            resolvedRoot,
            'directory',
            `source cache ${sourcePlan.cacheId}`,
          )
        : resolvedRoot
    await revalidateStableEntry(deps.fs, sourceRoot, `source cache ${sourcePlan.cacheId}`)
    const sourceTreeKey = `${sourcePlan.cacheId}\0${sourcePlan.commit}`
    let sourceFilesPromise = sourceFilesByTree.get(sourceTreeKey)
    if (!sourceFilesPromise) {
      sourceFilesPromise = deps.resolveSourceFiles!(sourcePlan)
      sourceFilesByTree.set(sourceTreeKey, sourceFilesPromise)
    }
    const sourceFiles = normalizeTrackedSourceFiles(await sourceFilesPromise)
    const stableSourceFiles = await captureStableRelativeFiles(
      deps.fs,
      sourceRoot,
      sourceFiles,
      `source cache ${sourcePlan.cacheId}`,
    )
    const directoryLinks = await validateSourceMaterialization(
      deps.fs,
      stableSourceFiles,
      sourcePlan,
      plan.strategy,
    )

    const skillsDir = agentSkillsDir(sourcePlan.agent, pathContext)
    const destinationChain = await captureAgentDirectoryChain(
      deps.fs,
      sourcePlan.agent,
      'skills',
      skillsDir,
      pathContext,
    )
    const namespace = join(skillsDir, sourcePlan.sourceName)
    const transactionRoot = dirname(sourceTransactionPath(namespace, 'staging', 'preflight'))
    const transactionChain = await captureAgentDirectoryChain(
      deps.fs,
      sourcePlan.agent,
      'skills',
      transactionRoot,
      pathContext,
    )
    const ownership = await inspectManagedSourceNamespace(deps.fs, namespace, {
      ownerRepo: deps.ownerRepo!,
      sourceKey: sha256(sourcePlan.sourceUrl),
      sourceName: sourcePlan.sourceName,
    })
    if (ownership.state === 'unowned') {
      throw new Error(`refuse to overwrite user-owned source namespace: ${namespace}`)
    }
    if (desired.has(namespace)) {
      throw new Error(`Duplicate source namespace destination: ${sourcePlan.sourceName}`)
    }
    desired.add(namespace)
    namespaces.push({
      plan: sourcePlan,
      sourceFiles: stableSourceFiles,
      directoryLinks,
      namespace,
      destinationChain,
      transactionChain,
      ownership,
    })
  }
  const cleanups = deps.ownerRepo
    ? await prepareOrphanedSourceNamespaces(
        desired,
        deps.ownerRepo,
        deps.installedAgents,
        deps.fs,
        pathContext,
        preservedSourceKeysByAgent,
      )
    : []
  return { namespaces, desired, preservedSourceKeysByAgent, cleanups }
}

async function validateSourceMaterialization(
  fs: IFileSystem,
  sourceFiles: StableRelativeFiles,
  plan: SourceProjectionPlan,
  strategy: ProjectionPlan['strategy'],
): Promise<Map<string, StableDirectoryTree>> {
  const directoryLinks = new Map<string, StableDirectoryTree>()
  const destinations = new Set<string>()
  for (const entry of plan.entries) {
    assertSafeProjectionPath(entry.sourcePath, true, 'source path')
    assertSafeProjectionPath(entry.targetPath, true, 'target path')
    if (isSourceMarkerPath(entry.targetPath)) {
      throw new Error(
        `Projection destination uses reserved ownership marker path: ${entry.targetPath}`,
      )
    }
    const entryFiles = trackedFilesForEntry(entry, sourceFiles.paths)
    if (entryFiles.length === 0) {
      throw new Error(`Tracked source content unavailable: ${entry.sourcePath || '.'}`)
    }
    for (const sourcePath of entryFiles) {
      const relativePath =
        entry.kind === 'resource-file'
          ? ''
          : entry.sourcePath
            ? sourcePath.slice(entry.sourcePath.length + 1)
            : sourcePath
      const targetPath = relativePath
        ? entry.targetPath
          ? `${entry.targetPath}/${relativePath}`
          : relativePath
        : entry.targetPath
      assertSafeProjectionPath(targetPath, false, 'materialized target path')
      if (isSourceMarkerPath(targetPath)) {
        throw new Error(`Projection destination uses reserved ownership marker path: ${targetPath}`)
      }
      const key = targetPath.toLowerCase()
      if (destinations.has(key)) throw new Error(`Projection destination collision: ${targetPath}`)
      destinations.add(key)
    }
    if (
      strategy === 'link' &&
      entry.kind !== 'resource-file' &&
      entry.sourcePath &&
      entry.targetPath &&
      !directoryLinks.has(entry.sourcePath)
    ) {
      const tree = await captureCompleteTrackedDirectory(
        fs,
        sourceFiles,
        entry.sourcePath,
        entryFiles,
      )
      if (tree) directoryLinks.set(entry.sourcePath, tree)
    }
  }
  return directoryLinks
}

async function captureCompleteTrackedDirectory(
  fs: IFileSystem,
  sourceFiles: StableRelativeFiles,
  directory: string,
  trackedFiles: readonly string[],
): Promise<StableDirectoryTree | null> {
  const directoryRoot = await captureStableEntry(
    fs,
    join(sourceFiles.root.path, directory),
    'directory',
    `tracked source directory ${directory}`,
  )
  if (directoryRoot.canonicalPath !== normalize(join(sourceFiles.root.canonicalPath, directory))) {
    throw new Error(`Tracked source directory escaped its root: ${directory}`)
  }
  const tree = await captureSafeDirectoryTree(
    fs,
    directoryRoot,
    `tracked source directory ${directory}`,
  )
  const expectedFiles = new Set(trackedFiles)
  const expectedDirectories = new Set([directory])
  for (const file of trackedFiles) {
    const parts = file.split('/')
    parts.pop()
    while (parts.length > 0) {
      expectedDirectories.add(parts.join('/'))
      parts.pop()
    }
  }
  const actualFiles = new Set<string>()
  for (const entry of tree.entries) {
    const sourcePath = relative(sourceFiles.root.canonicalPath, entry.canonicalPath).replace(
      /\\/g,
      '/',
    )
    if (entry.kind === 'directory') {
      if (!expectedDirectories.has(sourcePath)) return null
    } else {
      if (!expectedFiles.has(sourcePath)) return null
      actualFiles.add(sourcePath)
    }
  }
  return actualFiles.size === expectedFiles.size ? tree : null
}

function assertSafeProjectionPath(path: string, allowEmpty: boolean, description: string): void {
  assertSafeRelativePath(path, description, { allowEmpty })
}

function isSafeNamespaceSegment(value: string): boolean {
  try {
    assertSafeRelativePath(value, 'source namespace')
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..')
  } catch {
    return false
  }
}

function assertSafeNamespaceSegment(value: string, description: string): void {
  if (!isSafeNamespaceSegment(value)) {
    throw new Error(`Invalid ${description}: ${value}`)
  }
}

async function projectSourceNamespaces(
  plan: ProjectionPlan,
  deps: ProjectionDeps,
  journal: ProjectionJournal,
  prepared: PreparedSourceNamespaces,
): Promise<void> {
  for (const namespace of prepared.namespaces) {
    await replaceSourceNamespace(namespace, plan.strategy, deps.ownerRepo!, deps, journal)
  }
  for (const cleanup of prepared.cleanups) {
    await revalidateSafeDirectoryChain(
      deps.fs,
      cleanup.destinationChain,
      'source namespace cleanup destination',
    )
    await revalidateManagedSourceNamespace(deps.fs, cleanup.ownership)
    await revalidateSafeDirectoryChain(
      deps.fs,
      cleanup.transactionChain,
      'source namespace cleanup transaction directory',
    )
    const backupPath = sourceTransactionPath(
      cleanup.namespace,
      'backup',
      `${process.pid}-${crypto.randomUUID()}`,
    )
    try {
      await ensureSafeDirectoryChain(
        deps.fs,
        cleanup.transactionChain,
        'source namespace cleanup transaction directory',
      )
      await revalidateManagedSourceNamespace(deps.fs, cleanup.ownership)
      await deps.fs.moveNoReplace(
        cleanup.namespace,
        backupPath,
        cleanup.ownership.destination!.identity,
      )
      const backup = await requireInstalledNamespace(deps.fs, backupPath)
      journal.undos.push({
        kind: 'restoreNamespace',
        path: cleanup.namespace,
        backupPath,
        backupIdentity: backup.identity,
      })
    } catch (err) {
      deps.logger?.error('failed to clean orphaned source namespace', {
        err,
        namespace: cleanup.namespace,
      })
      throw err
    }
  }
}

async function replaceSourceNamespace(
  prepared: PreparedSourceNamespace,
  strategy: ProjectionPlan['strategy'],
  ownerRepo: string,
  deps: ProjectionDeps,
  journal: ProjectionJournal,
): Promise<void> {
  const { plan, sourceFiles, directoryLinks, namespace } = prepared
  const fs = deps.fs
  const reservedEntry = plan.entries.find(({ targetPath }) => isSourceMarkerPath(targetPath))
  if (reservedEntry) {
    throw new Error(
      `Projection destination uses reserved ownership marker path: ${reservedEntry.targetPath}`,
    )
  }
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const staging = sourceTransactionPath(namespace, 'staging', suffix)
  const backup = sourceTransactionPath(namespace, 'backup', suffix)
  await revalidateSafeDirectoryChain(
    fs,
    prepared.destinationChain,
    `${plan.agent} source namespace destination`,
  )
  await revalidateSafeDirectoryChain(
    fs,
    prepared.transactionChain,
    `${plan.agent} source namespace transaction directory`,
  )
  await revalidateStableRelativeFiles(fs, sourceFiles, `source cache ${plan.cacheId}`)
  await revalidateManagedSourceNamespace(fs, prepared.ownership)
  await ensureSafeDirectoryChain(
    fs,
    prepared.destinationChain,
    `${plan.agent} source namespace destination`,
  )
  try {
    await ensureSafeDirectoryChain(
      fs,
      prepared.transactionChain,
      `${plan.agent} source namespace transaction directory`,
    )
    await fs.mkdir(staging, false)
    const trackedFiles = sourceFiles.paths
    const materializedDestinations = new Set<string>()
    for (const entry of plan.entries) {
      const entryFiles = trackedFilesForEntry(entry, trackedFiles)
      if (entryFiles.length === 0) {
        throw new Error(`Tracked source content unavailable: ${entry.sourcePath || '.'}`)
      }
      const materializedFiles = entryFiles.map((sourcePath) => {
        const relativePath =
          entry.kind === 'resource-file'
            ? ''
            : entry.sourcePath
              ? sourcePath.slice(entry.sourcePath.length + 1)
              : sourcePath
        const targetPath = relativePath
          ? entry.targetPath
            ? `${entry.targetPath}/${relativePath}`
            : relativePath
          : entry.targetPath
        if (isSourceMarkerPath(targetPath)) {
          throw new Error(
            `Projection destination uses reserved ownership marker path: ${targetPath}`,
          )
        }
        const destination = targetPath.toLowerCase()
        if (materializedDestinations.has(destination)) {
          throw new Error(`Projection destination collision: ${targetPath}`)
        }
        materializedDestinations.add(destination)
        return { sourcePath, targetPath }
      })
      const directoryTree = entry.sourcePath ? directoryLinks.get(entry.sourcePath) : undefined
      if (strategy === 'link' && entry.targetPath && directoryTree) {
        await revalidateSafeDirectoryTree(
          fs,
          directoryTree,
          `tracked source directory ${entry.sourcePath}`,
        )
        const target = join(staging, entry.targetPath)
        await fs.mkdir(dirname(target), true)
        await fs.createLink(directoryTree.root.canonicalPath, target)
        await revalidateSafeDirectoryTree(
          fs,
          directoryTree,
          `tracked source directory ${entry.sourcePath}`,
        )
        continue
      }
      for (const { sourcePath, targetPath } of materializedFiles) {
        await revalidateStableRelativeFile(
          fs,
          sourceFiles,
          sourcePath,
          `source cache ${plan.cacheId}`,
        )
        const source = normalize(join(sourceFiles.root.path, ...sourcePath.split('/')))
        const sourceEntry = sourceFiles.entriesByPath.get(source)
        if (!sourceEntry || sourceEntry.kind !== 'file') {
          throw new Error(`Tracked source file was not authorized: ${sourcePath}`)
        }
        const target = join(staging, targetPath)
        if (strategy === 'copy') {
          await fs.copyFileNoFollow(source, target, sourceEntry.identity)
        } else await fs.createFileLink(source, target)
        await revalidateStableRelativeFile(
          fs,
          sourceFiles,
          sourcePath,
          `source cache ${plan.cacheId}`,
        )
      }
    }
    await writeSourceMarker(fs, staging, plan, ownerRepo)

    await revalidateStableRelativeFiles(fs, sourceFiles, `source cache ${plan.cacheId}`)
    await revalidateManagedSourceNamespace(fs, prepared.ownership)
    const existing = prepared.ownership.state === 'owned'
    let backupPath: string | null = null
    let restoreUndo: Extract<UndoAction, { kind: 'restoreNamespace' }> | null = null
    if (existing) {
      await fs.moveNoReplace(namespace, backup, prepared.ownership.destination!.identity)
      const backupEntry = await requireInstalledNamespace(fs, backup)
      backupPath = backup
      restoreUndo = {
        kind: 'restoreNamespace',
        path: namespace,
        backupPath,
        backupIdentity: backupEntry.identity,
      }
      journal.undos.push(restoreUndo)
    }
    const stagingEntry = await requireInstalledNamespace(fs, staging)
    try {
      await fs.moveNoReplace(staging, namespace, stagingEntry.identity)
    } catch (error) {
      if (backupPath && restoreUndo) {
        try {
          await applyUndo(restoreUndo, fs)
          const undoIndex = journal.undos.lastIndexOf(restoreUndo)
          if (undoIndex >= 0) journal.undos.splice(undoIndex, 1)
        } catch (restoreError) {
          deps.logger?.error('source namespace immediate restore failed', {
            err: restoreError,
            namespace,
            backupPath,
          })
          // Keep the undo entry so the outer rollback can retry restoration.
        }
      }
      throw error
    }
    const installed = await requireInstalledNamespace(fs, namespace)
    if (!existing) {
      journal.undos.push({
        kind: 'restoreNamespace',
        path: namespace,
        backupPath: null,
        installedKind: installed.kind,
        installedIdentity: installed.identity,
      })
    } else {
      restoreUndo!.installedKind = installed.kind
      restoreUndo!.installedIdentity = installed.identity
    }
    await revalidateStableRelativeFiles(fs, sourceFiles, `source cache ${plan.cacheId}`)
  } catch (error) {
    try {
      await fs.removeDir(staging)
    } catch (cleanupError) {
      deps.logger?.error('failed to clean source namespace staging directory', {
        err: cleanupError,
        staging,
      })
      throw new AggregateError([error, cleanupError], 'source projection and cleanup failed', {
        cause: error,
      })
    }
    throw error
  }
}

function isSourceMarkerPath(path: string): boolean {
  const normalized = path.toLowerCase()
  return normalized === COPY_MARKER || normalized.startsWith(`${COPY_MARKER}/`)
}

function normalizeTrackedSourceFiles(sourceFiles: readonly string[]): string[] {
  const normalized = new Set<string>()
  const caseFolded = new Map<string, string>()
  for (const sourcePath of sourceFiles) {
    const canonical = sourcePath.replace(/\\/g, '/')
    if (
      !canonical ||
      canonical !== sourcePath ||
      canonical.startsWith('/') ||
      /^[A-Za-z]:\//.test(canonical) ||
      canonical.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`Invalid tracked source path: ${sourcePath}`)
    }
    assertSafeRelativePath(canonical, 'tracked source path')
    const folded = canonical.toLowerCase()
    const existing = caseFolded.get(folded)
    if (existing && existing !== canonical) {
      throw new Error(`Tracked source path collision: ${existing} and ${canonical}`)
    }
    caseFolded.set(folded, canonical)
    normalized.add(canonical)
  }
  return [...normalized].sort((left, right) => left.localeCompare(right, 'en'))
}

function trackedFilesForEntry(
  entry: SourceProjectionPlan['entries'][number],
  sourceFiles: readonly string[],
): string[] {
  if (entry.kind === 'resource-file') {
    return sourceFiles.includes(entry.sourcePath) ? [entry.sourcePath] : []
  }
  if (!entry.sourcePath) return [...sourceFiles]
  const prefix = `${entry.sourcePath}/`
  return sourceFiles.filter((sourcePath) => sourcePath.startsWith(prefix))
}

async function writeSourceMarker(
  fs: IFileSystem,
  namespace: string,
  plan: SourceProjectionPlan,
  ownerRepo: string,
): Promise<void> {
  await fs.writeFileExclusive(
    join(namespace, COPY_MARKER),
    JSON.stringify({
      version: 1,
      managedBy: 'loom',
      kind: SOURCE_MARKER_KIND,
      ownerRepo,
      sourceKey: sha256(plan.sourceUrl),
      sourceName: plan.sourceName,
      namespace: plan.sourceName,
    }) + '\n',
  )
}

interface ManagedSourceNamespaceInspection {
  path: string
  state: ManagedArtifactOwnership
  destination: StableEntry | null
  marker?: StableFileSnapshot
  ownerRepo?: string
  sourceKey?: string
  sourceName?: string
  namespace?: string
}

async function inspectManagedSourceNamespace(
  fs: IFileSystem,
  namespace: string,
  expected: { ownerRepo?: string; sourceKey?: string; sourceName?: string } = {},
): Promise<ManagedSourceNamespaceInspection> {
  const namespaceEntry = await fs.inspectEntry(namespace)
  if (!namespaceEntry) return { path: namespace, state: 'absent', destination: null }
  if (namespaceEntry.kind !== 'directory') {
    return { path: namespace, state: 'unowned', destination: null }
  }
  const destination = await captureStableEntry(
    fs,
    namespace,
    'directory',
    `source namespace ${namespace}`,
  )
  const markerPath = join(namespace, COPY_MARKER)
  const markerEntry = await fs.inspectEntry(markerPath)
  if (markerEntry?.kind !== 'file') {
    return { path: namespace, state: 'unowned', destination }
  }
  const marker = await readOptionalStableFile(fs, markerPath, 'source namespace marker')
  let value: Record<string, unknown>
  try {
    const parsed = JSON.parse(marker.content!) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path: namespace, state: 'unowned', destination, marker }
    }
    value = parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { path: namespace, state: 'unowned', destination, marker }
    }
    throw err
  }
  const ownerRepo = typeof value.ownerRepo === 'string' ? value.ownerRepo : undefined
  const sourceKey = typeof value.sourceKey === 'string' ? value.sourceKey : undefined
  const sourceName = typeof value.sourceName === 'string' ? value.sourceName : undefined
  const actualNamespace = typeof value.namespace === 'string' ? value.namespace : undefined
  const valid =
    value.version === 1 &&
    value.managedBy === 'loom' &&
    value.kind === SOURCE_MARKER_KIND &&
    Boolean(ownerRepo) &&
    /^[a-f0-9]{64}$/.test(sourceKey ?? '') &&
    Boolean(sourceName && isSafeNamespaceSegment(sourceName)) &&
    Boolean(actualNamespace && isSafeNamespaceSegment(actualNamespace)) &&
    actualNamespace === basename(namespace) &&
    (!expected.ownerRepo || ownerRepo === expected.ownerRepo) &&
    (!expected.sourceKey || sourceKey === expected.sourceKey) &&
    (!expected.sourceName || sourceName === expected.sourceName)
  return {
    path: namespace,
    state: valid ? 'owned' : 'unowned',
    destination,
    marker,
    ownerRepo,
    sourceKey,
    sourceName,
    namespace: actualNamespace,
  }
}

async function revalidateManagedSourceNamespace(
  fs: IFileSystem,
  expected: ManagedSourceNamespaceInspection,
): Promise<void> {
  if (expected.state === 'absent') {
    if (await fs.inspectEntry(expected.path)) {
      throw new Error(`Source namespace appeared after preflight: ${expected.path}`)
    }
    return
  }
  if (expected.state !== 'owned' || !expected.destination || !expected.marker) {
    throw new Error(`Source namespace is not owned: ${expected.path}`)
  }
  await revalidateStableEntry(fs, expected.destination, `source namespace ${expected.path}`)
  await revalidateFileSnapshot(
    fs,
    expected.marker.entry!.path,
    expected.marker,
    'source namespace marker',
  )
  const current = await inspectManagedSourceNamespace(fs, expected.path, {
    ownerRepo: expected.ownerRepo,
    sourceKey: expected.sourceKey,
    sourceName: expected.sourceName,
  })
  if (
    current.state !== 'owned' ||
    current.destination?.identity !== expected.destination.identity ||
    current.marker?.entry?.identity !== expected.marker.entry?.identity
  ) {
    throw new Error(`Source namespace identity changed after preflight: ${expected.path}`)
  }
}

async function prepareOrphanedSourceNamespaces(
  desired: Set<string>,
  ownerRepo: string,
  installedAgents: Set<AgentId>,
  fs: IFileSystem,
  pathContext: AgentPathContext,
  preservedSourceKeysByAgent: Map<AgentId, Set<string>> = new Map(),
): Promise<PreparedSourceCleanup[]> {
  const cleanups: PreparedSourceCleanup[] = []
  for (const agent of installedAgents) {
    if (!contextSupportsAgentCapability(agent, 'skills', pathContext)) continue
    const skillsDir = agentSkillsDir(agent, pathContext)
    const destinationChain = await captureAgentDirectoryChain(
      fs,
      agent,
      'skills',
      skillsDir,
      pathContext,
    )
    const skillsEntry = await fs.inspectEntry(skillsDir)
    if (!skillsEntry) continue
    if (skillsEntry.kind !== 'directory') {
      throw new Error(`Agent skills root is not a real directory: ${skillsDir}`)
    }
    const entries = await fs.readDir(skillsDir)
    for (const entry of entries) {
      const namespace = join(skillsDir, entry)
      if (desired.has(namespace)) continue
      const ownership = await inspectManagedSourceNamespace(fs, namespace, { ownerRepo })
      if (ownership.state !== 'owned') continue
      const preservedSourceKeys = preservedSourceKeysByAgent.get(agent)
      if (ownership.sourceKey && preservedSourceKeys?.has(ownership.sourceKey)) continue
      const transactionChain = await captureAgentDirectoryChain(
        fs,
        agent,
        'skills',
        dirname(sourceTransactionPath(namespace, 'backup', 'preflight')),
        pathContext,
      )
      cleanups.push({ namespace, destinationChain, transactionChain, ownership })
    }
    await revalidateSafeDirectoryChain(fs, destinationChain, `${agent} skills destination`)
  }
  return cleanups
}

function sourceTransactionPath(
  namespace: string,
  kind: 'staging' | 'backup',
  suffix: string,
): string {
  return join(
    dirname(dirname(namespace)),
    '.loom-projection-transactions',
    `${basename(namespace)}.loom-${kind}-${suffix}`,
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function discardNamespaceBackups(
  journal: ProjectionJournal,
  fs: IFileSystem,
  logger?: ProjectionDeps['logger'],
): Promise<{ path: string; err: unknown }[]> {
  const failures: { path: string; err: unknown }[] = []
  for (const undo of journal.undos) {
    if (undo.kind !== 'restoreNamespace' || !undo.backupPath) continue
    try {
      if (!undo.backupIdentity) throw new Error(`projection backup identity is missing`)
      await fs.removeEntryIfIdentity(undo.backupPath, undo.backupIdentity)
    } catch (err) {
      failures.push({ path: undo.backupPath, err })
      logger?.error('failed to discard source namespace backup', { err, path: undo.backupPath })
    }
  }
  return failures
}

async function writeCopyMarker(
  fs: IFileSystem,
  dest: string,
  skillId: string,
  ownerRepo: string,
  source: string,
): Promise<void> {
  await fs.writeFileExclusive(
    join(dest, COPY_MARKER),
    JSON.stringify({
      version: 1,
      managedBy: 'loom',
      kind: 'local-skill',
      ownerRepo,
      skillId,
      source,
    }) + '\n',
  )
}

async function removeEmptySkillParents(
  fs: IFileSystem,
  skillsDir: string,
  removedPath: string,
): Promise<void> {
  let current = dirname(removedPath)
  while (true) {
    const parent = dirname(current)
    if (parent === current) return
    const currentEntry = await fs.inspectEntry(current)
    if (!currentEntry || currentEntry.kind !== 'directory') return
    const entries = await fs.readDir(current)
    if (entries.length > 0) return
    await fs.removeDir(current)
    if (current === skillsDir) return
    current = parent
  }
}

async function resolveMcpFragments(
  entries: McpPlanEntry[],
  mcp: McpServer[],
  agent: AgentId,
  ctx: AgentAwareVarsContext,
  logger?: ProjectionDeps['logger'],
): Promise<McpFragment[]> {
  const byId = new Map(mcp.map((s) => [s.id, s]))
  const out: McpFragment[] = []
  let resolution: Extract<LayeredVarsResolution, { ok: true }> | null = null
  if (ctx.resolveForAgent) {
    const resolved = await ctx.resolveForAgent(agent)
    if (!resolved.ok) {
      const error = new Error(resolved.diagnostics.map((item) => item.message).join('; '))
      logger?.error('mcp var resolve failed for agent', {
        err: error,
        diagnostics: resolved.diagnostics,
        agent,
      })
      throw error
    }
    resolution = resolved
  }
  for (const e of entries) {
    if (!e.agents.includes(agent)) continue
    const s = byId.get(e.id)
    if (!s) continue
    try {
      const resolveValue = (value: string) => {
        if (!resolution) return resolveVars(value, ctx)
        const rendered = renderTextWithResolvedVars(value, resolution)
        if (!rendered.ok)
          throw new Error(rendered.diagnostics.map((item) => item.message).join('; '))
        return rendered.text
      }
      const rv = (v: string | undefined) => (v === undefined ? undefined : resolveValue(v))
      const rva = (v: string[] | undefined) => v?.map((a) => resolveValue(a))
      const rvm = (v: Record<string, string> | undefined) =>
        v && Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveValue(x)]))
      out.push({
        id: s.id,
        type: s.type,
        agents: e.agents,
        command: rv(s.command),
        args: rva(s.args),
        env: rvm(s.env),
        url: rv(s.url),
        headers: rvm(s.headers),
      })
    } catch (e) {
      logger?.error('mcp var resolve failed for entry', { err: e, mcpId: s.id, agent })
      throw e
    }
  }
  return out
}

export async function applyUndo(u: UndoAction, fs: IFileSystem): Promise<void> {
  if (u.kind === 'restoreNamespace') {
    const current = await fs.inspectEntry(u.path)
    if (current) {
      if (
        !u.installedIdentity ||
        !u.installedKind ||
        current.identity !== u.installedIdentity ||
        current.kind !== u.installedKind
      ) {
        throw new Error(`cannot rollback replaced projection artifact: ${u.path}`)
      }
      await fs.removeEntryIfIdentity(u.path, u.installedIdentity)
    }
    if (u.backupPath) {
      const backup = await fs.inspectEntry(u.backupPath)
      if (
        !backup ||
        (backup.kind !== 'directory' && backup.kind !== 'link') ||
        !u.backupIdentity ||
        backup.identity !== u.backupIdentity
      ) {
        throw new Error(`cannot rollback replaced projection backup: ${u.backupPath}`)
      }
      if (await fs.inspectEntry(u.path)) {
        throw new Error(`cannot restore projection backup over an existing artifact: ${u.path}`)
      }
      await fs.moveNoReplace(u.backupPath, u.path, u.backupIdentity)
    }
  } else if (u.kind === 'restoreMemory') {
    await restoreProjectedFile(u, fs)
  } else {
    await restoreProjectedFile(u, fs)
  }
}

async function restoreProjectedFile(
  undo: Extract<UndoAction, { kind: 'restoreMcp' | 'restoreMemory' }>,
  fs: IFileSystem,
): Promise<void> {
  if (!undo.installedIdentity) return
  const current = await fs.inspectEntry(undo.path)
  if (current) {
    if (current.kind !== 'file' || current.identity !== undo.installedIdentity) {
      throw new Error(`cannot rollback replaced projection file: ${undo.path}`)
    }
    await fs.removeEntryIfIdentity(undo.path, undo.installedIdentity)
  }
  if (undo.backup === null) return

  const temporary = join(
    dirname(undo.path),
    `.${basename(undo.path)}.loom-restore-${process.pid}-${crypto.randomUUID()}`,
  )
  try {
    const entry = await fs.writeFileExclusive(temporary, undo.backup)
    await fs.moveNoReplace(temporary, undo.path, entry.identity)
  } catch (error) {
    const temporaryEntry = await fs.inspectEntry(temporary)
    if (temporaryEntry) {
      try {
        await fs.removeEntryIfIdentity(temporary, temporaryEntry.identity)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'projection restore and cleanup failed', {
          cause: error,
        })
      }
    }
    throw error
  }
}
