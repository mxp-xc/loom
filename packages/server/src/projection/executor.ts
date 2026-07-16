import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { IFileSystem } from '../ports/fs.js'
import type { LoggerPort } from '../ports/logger.js'
import type {
  IAgentAdapter,
  McpFragment,
  ProjectionJournal,
  UndoAction,
  ProjectionFailure,
} from '../ports/adapter.js'
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
  type LayeredVarsResolution,
  type VarsContext,
} from '@loom/core'
import { agentMcpFile, agentSkillsDir, agentMemoryFile, agentConfigDir } from '../adapters/paths.js'
import { mergeMcp } from './mcp-merge.js'

export interface ProjectionDeps {
  fs: IFileSystem
  ownerRepo?: string
  adapters: Partial<Record<AgentId, IAgentAdapter>>
  installedAgents: Set<AgentId>
  resolveSkillSrc: (link: ProjectionPlan['links'][number]) => string | null
  resolveSourceRoot?: (sourcePlan: SourceProjectionPlan) => string | null
  resolveSourceFiles?: (sourcePlan: SourceProjectionPlan) => Promise<string[]>
  logger?: Pick<LoggerPort, 'error' | 'warn'>
  // Per-agent set of mcp ids loom projected last time (persisted by caller).
  // Used to distinguish loom-managed entries (removable) from user-handwritten (preserved).
  // Absent => first run / state lost: mergeMcp degrades to preserving all existing entries.
  getManagedMcpIds?: (agent: AgentId) => Promise<Set<string>>
  setManagedMcpIds?: (agent: AgentId, ids: string[]) => Promise<void>
}

export type ProjectionResult = { ok: true } | { ok: false; failure: ProjectionFailure }

export type ProjectionScope = 'skills' | 'mcp' | 'memory' | 'all'
const COPY_MARKER = '.loom-projection.json'
const SOURCE_MARKER_KIND = 'skill-source'

type AgentAwareVarsContext = VarsContext & {
  resolveForAgent?: (agent: AgentId) => Promise<LayeredVarsResolution>
}

export async function executeProjection(
  plan: ProjectionPlan,
  manifest: Manifest,
  varsCtx: VarsContext,
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
  const { fs, adapters, installedAgents } = deps
  const agentAwareVars = varsCtx as AgentAwareVarsContext
  try {
    // Phase A: build enabled links
    if (scope === 'skills' || scope === 'all') {
      const builtDests = new Set<string>()
      for (const link of plan.links) {
        const src = deps.resolveSkillSrc(link)
        if (!src || link.targets.length === 0) continue
        for (const agent of link.targets) {
          const skillsDir = agentSkillsDir(agent)
          await fs.mkdir(skillsDir, true)
          const dest = join(skillsDir, link.skillId)
          await fs.mkdir(join(dest, '..'), true)
          if (await fs.isLink(dest)) {
            await fs.removeLink(dest)
          } else if (await fs.exists(dest)) {
            if (await shouldRemoveRealSkillDir(fs, dest, link)) {
              await fs.removeDir(dest)
            } else {
              deps.logger?.warn?.('skip cleanup: target is real file/dir', {
                dest,
                skillId: link.skillId,
              })
              continue
            }
          }
          if (plan.strategy === 'copy') {
            await fs.copyDir(src, dest)
            await writeCopyMarker(fs, dest, link.skillId)
          } else {
            await fs.createLink(src, dest)
          }
          journal.undos.push({ kind: 'unlink', path: dest })
          builtDests.add(dest)
        }
      }
      // Phase B: clean stale links for skills still in manifest but no longer projected.
      for (const link of plan.links) {
        for (const agent of installedAgents) {
          const dest = join(agentSkillsDir(agent), link.skillId)
          if (builtDests.has(dest)) continue
          if (await fs.isLink(dest)) {
            await fs.removeLink(dest)
            await removeEmptySkillParents(fs, agentSkillsDir(agent), dest)
          } else if (await fs.exists(dest)) {
            if (await shouldRemoveRealSkillDir(fs, dest, link)) {
              await fs.removeDir(dest)
              await removeEmptySkillParents(fs, agentSkillsDir(agent), dest)
            } else {
              deps.logger?.warn?.('skip cleanup: target is real file/dir', {
                dest,
                skillId: link.skillId,
              })
            }
          }
        }
      }
      // Phase C: clean orphaned links — skills deleted from manifest entirely.
      // Scan each installed agent's skills dir; any loom-projected link whose id is
      // not in the current plan's link set is removed. Non-link real dirs are skipped.
      await cleanOrphanedLinks(plan, installedAgents, fs, deps.logger)
      await projectSourceNamespaces(plan, deps, journal)
    }
    // MCP config
    if (scope === 'mcp' || scope === 'all') {
      for (const agent of Object.keys(adapters) as AgentId[]) {
        const adapter = adapters[agent]
        if (!adapter) continue
        const file = agentMcpFile(agent)
        const fragments = await resolveMcpFragments(
          plan.mcpEntries,
          manifest.mcp,
          agent,
          agentAwareVars,
          deps.logger,
        )
        // Even with no fragments we must still remove managed entries the manifest deleted.
        const managedIds = (await deps.getManagedMcpIds?.(agent)) ?? new Set<string>()
        if (fragments.length === 0 && managedIds.size === 0) continue
        const backup = (await fs.exists(file)) ? await fs.readFile(file) : null
        journal.undos.push({ kind: 'restoreMcp', path: file, backup })
        const existing = await adapter.readMcp(fs)
        const merged = mergeMcp(existing, fragments, managedIds)
        await adapter.writeMcp(fs, merged)
        await deps.setManagedMcpIds?.(
          agent,
          fragments.map((f) => f.id),
        )
      }
    }
    // Phase D: memory projection
    if (scope === 'memory' || scope === 'all') {
      const mp = plan.memoryPlan
      const entries =
        mp.entries ??
        (mp.active && mp.content !== null
          ? [{ memory: mp.active, content: mp.content, targets: mp.targets }]
          : [])
      if (entries.length > 0) {
        const renderedTargets: Array<{ agent: AgentId; path: string; rendered: string }> = []
        for (const entry of entries) {
          for (const agent of entry.targets) {
            const ctx: VarsContext = {
              env: {
                ...varsCtx.env,
                LOOM_AGENT: agent,
                LOOM_CONFIG_DIR: agentConfigDir(agent),
                LOOM_SKILLS_DIR: agentSkillsDir(agent),
                LOOM_AGENT_FILE: agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
              },
              activeProfile: varsCtx.activeProfile,
              defaultProfile: varsCtx.defaultProfile,
            }
            let rendered: string
            try {
              if (agentAwareVars.resolveForAgent) {
                const resolution = await agentAwareVars.resolveForAgent(agent)
                if (!resolution.ok)
                  throw new Error(resolution.diagnostics.map((item) => item.message).join('; '))
                const renderResult = renderTextWithResolvedVars(entry.content, resolution)
                if (!renderResult.ok)
                  throw new Error(renderResult.diagnostics.map((item) => item.message).join('; '))
                rendered = renderResult.text
              } else {
                rendered = renderText(entry.content, ctx)
              }
            } catch (e) {
              deps.logger?.error('memory var resolve failed', { err: e, agent })
              throw e
            }
            renderedTargets.push({ agent, path: agentMemoryFile(agent), rendered })
          }
        }
        for (const { path, rendered } of renderedTargets) {
          await fs.mkdir(join(path, '..'), true).catch(() => {})
          const backup = (await fs.exists(path)) ? await fs.readFile(path) : null
          journal.undos.push({ kind: 'restoreMemory', path, backup })
          await fs.writeFile(path, rendered)
        }
      } else {
        deps.logger?.warn?.('no assigned memory, skip memory phase')
      }
    }
    await discardNamespaceBackups(journal, fs, deps.logger)
    return { ok: true }
  } catch (originalError) {
    const rollbackFailures: { path: string; err: unknown }[] = []
    let undone = 0
    for (const u of [...journal.undos].reverse()) {
      try {
        await applyUndo(u, fs)
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

async function projectSourceNamespaces(
  plan: ProjectionPlan,
  deps: ProjectionDeps,
  journal: ProjectionJournal,
): Promise<void> {
  if ((plan.sourcePlans?.length ?? 0) > 0 && !deps.ownerRepo) {
    throw new Error('Source projection ownerRepo is unavailable')
  }
  if ((plan.sourcePlans?.length ?? 0) > 0 && !deps.resolveSourceFiles) {
    throw new Error('Source projection tracked file resolver is unavailable')
  }
  const desired = new Set<string>()
  const sourceFilesByTree = new Map<string, Promise<string[]>>()
  for (const sourcePlan of plan.sourcePlans ?? []) {
    const sourceRoot = deps.resolveSourceRoot?.(sourcePlan)
    if (!sourceRoot) throw new Error(`Source cache unavailable: ${sourcePlan.sourceUrl}`)
    const sourceTreeKey = `${sourcePlan.cacheId}\0${sourcePlan.commit}`
    let sourceFilesPromise = sourceFilesByTree.get(sourceTreeKey)
    if (!sourceFilesPromise) {
      sourceFilesPromise = deps.resolveSourceFiles!(sourcePlan)
      sourceFilesByTree.set(sourceTreeKey, sourceFilesPromise)
    }
    const sourceFiles = await sourceFilesPromise
    const namespace = join(agentSkillsDir(sourcePlan.target), sourcePlan.sourceName)
    desired.add(namespace)
    await replaceSourceNamespace(
      sourcePlan,
      sourceRoot,
      sourceFiles,
      namespace,
      plan.strategy,
      deps.ownerRepo!,
      deps.fs,
      journal,
      deps.logger,
    )
  }
  if (deps.ownerRepo) {
    await cleanOrphanedSourceNamespaces(
      desired,
      deps.ownerRepo,
      deps.installedAgents,
      deps.fs,
      journal,
      deps.logger,
    )
  }
}

async function replaceSourceNamespace(
  plan: SourceProjectionPlan,
  sourceRoot: string,
  sourceFiles: readonly string[],
  namespace: string,
  strategy: ProjectionPlan['strategy'],
  ownerRepo: string,
  fs: IFileSystem,
  journal: ProjectionJournal,
  logger?: ProjectionDeps['logger'],
): Promise<void> {
  const reservedEntry = plan.entries.find(({ targetPath }) => isSourceMarkerPath(targetPath))
  if (reservedEntry) {
    throw new Error(
      `Projection destination uses reserved ownership marker path: ${reservedEntry.targetPath}`,
    )
  }
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const staging = sourceTransactionPath(namespace, 'staging', suffix)
  const backup = sourceTransactionPath(namespace, 'backup', suffix)
  await fs.mkdir(dirname(namespace), true)
  try {
    await fs.mkdir(staging, true)
    const trackedFiles = normalizeTrackedSourceFiles(sourceFiles)
    const materializedTargets = new Set<string>()
    for (const entry of plan.entries) {
      const entryFiles = trackedFilesForEntry(entry, trackedFiles)
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
        if (isSourceMarkerPath(targetPath)) {
          throw new Error(
            `Projection destination uses reserved ownership marker path: ${targetPath}`,
          )
        }
        const destination = targetPath.toLowerCase()
        if (materializedTargets.has(destination)) {
          throw new Error(`Projection destination collision: ${targetPath}`)
        }
        materializedTargets.add(destination)
        const source = join(sourceRoot, sourcePath)
        const target = join(staging, targetPath)
        if (strategy === 'copy') await fs.copyFile(source, target)
        else await fs.createFileLink(source, target)
      }
    }
    await writeSourceMarker(fs, staging, plan, ownerRepo)

    const existing = (await fs.isLink(namespace)) || (await fs.exists(namespace))
    if (
      existing &&
      !(await isManagedSourceNamespace(fs, namespace, {
        ownerRepo,
        sourceKey: sha256(plan.sourceUrl),
      }))
    ) {
      throw new Error(`refuse to overwrite user-owned source namespace: ${namespace}`)
    }
    let backupPath: string | null = null
    let restoreUndo: Extract<UndoAction, { kind: 'restoreNamespace' }> | null = null
    if (existing) {
      await fs.move(namespace, backup)
      backupPath = backup
      restoreUndo = { kind: 'restoreNamespace', path: namespace, backupPath }
      journal.undos.push(restoreUndo)
    }
    try {
      await fs.move(staging, namespace)
    } catch (error) {
      if (backupPath && restoreUndo) {
        try {
          await fs.move(backupPath, namespace)
          const undoIndex = journal.undos.lastIndexOf(restoreUndo)
          if (undoIndex >= 0) journal.undos.splice(undoIndex, 1)
        } catch (restoreError) {
          logger?.error('source namespace immediate restore failed', {
            err: restoreError,
            namespace,
            backupPath,
          })
          // Keep the undo entry so the outer rollback can retry restoration.
        }
      }
      throw error
    }
    if (!existing)
      journal.undos.push({ kind: 'restoreNamespace', path: namespace, backupPath: null })
  } catch (error) {
    try {
      await fs.removeDir(staging)
    } catch (cleanupError) {
      logger?.warn?.('failed to clean source namespace staging directory', {
        err: cleanupError,
        staging,
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
  await fs.writeFile(
    join(namespace, COPY_MARKER),
    JSON.stringify({
      version: 1,
      managedBy: 'loom',
      kind: SOURCE_MARKER_KIND,
      ownerRepo,
      sourceKey: sha256(plan.sourceUrl),
      sourceName: plan.sourceName,
    }) + '\n',
  )
}

async function isManagedSourceNamespace(
  fs: IFileSystem,
  namespace: string,
  expected?: { ownerRepo?: string; sourceKey?: string },
): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(join(namespace, COPY_MARKER))) as {
      version?: unknown
      managedBy?: unknown
      kind?: unknown
      ownerRepo?: unknown
      sourceKey?: unknown
    }
    return (
      marker.version === 1 &&
      marker.managedBy === 'loom' &&
      marker.kind === SOURCE_MARKER_KIND &&
      (!expected?.ownerRepo || marker.ownerRepo === expected.ownerRepo) &&
      (!expected?.sourceKey || marker.sourceKey === expected.sourceKey)
    )
  } catch {
    return false
  }
}

async function cleanOrphanedSourceNamespaces(
  desired: Set<string>,
  ownerRepo: string,
  installedAgents: Set<AgentId>,
  fs: IFileSystem,
  journal: ProjectionJournal,
  logger?: ProjectionDeps['logger'],
): Promise<void> {
  for (const agent of installedAgents) {
    const skillsDir = agentSkillsDir(agent)
    let entries: string[]
    try {
      entries = await fs.readDir(skillsDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.includes('.loom-backup-') || entry.includes('.loom-staging-')) continue
      const namespace = join(skillsDir, entry)
      if (desired.has(namespace) || !(await isManagedSourceNamespace(fs, namespace, { ownerRepo })))
        continue
      try {
        const backupPath = sourceTransactionPath(
          namespace,
          'backup',
          `${process.pid}-${crypto.randomUUID()}`,
        )
        await fs.move(namespace, backupPath)
        journal.undos.push({ kind: 'restoreNamespace', path: namespace, backupPath })
      } catch (err) {
        logger?.error('failed to clean orphaned source namespace', { err, namespace })
        throw err
      }
    }
  }
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
): Promise<void> {
  for (const undo of journal.undos) {
    if (undo.kind !== 'restoreNamespace' || !undo.backupPath) continue
    try {
      await fs.removeDir(undo.backupPath)
    } catch (err) {
      logger?.warn?.('failed to discard source namespace backup', { err, path: undo.backupPath })
    }
  }
}

async function writeCopyMarker(fs: IFileSystem, dest: string, skillId: string): Promise<void> {
  await fs.writeFile(join(dest, COPY_MARKER), JSON.stringify({ skillId, managedBy: 'loom' }) + '\n')
}

async function isManagedCopy(fs: IFileSystem, dest: string): Promise<boolean> {
  return fs.exists(join(dest, COPY_MARKER))
}

async function shouldRemoveRealSkillDir(
  fs: IFileSystem,
  dest: string,
  _link: ProjectionPlan['links'][number],
): Promise<boolean> {
  return isManagedCopy(fs, dest)
}

async function collectProjectedSkillIds(
  fs: IFileSystem,
  base: string,
  prefix = '',
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readDir(prefix ? join(base, prefix) : base)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry === COPY_MARKER) continue
    const rel = prefix ? prefix + '/' + entry : entry
    const full = join(base, rel)
    if (await isManagedSourceNamespace(fs, full)) continue
    if (await fs.exists(join(full, 'SKILL.md'))) out.push(rel)
    out.push(...(await collectProjectedSkillIds(fs, base, rel)))
  }
  return out
}

async function cleanOrphanedLinks(
  plan: ProjectionPlan,
  installedAgents: Set<AgentId>,
  fs: IFileSystem,
  logger?: ProjectionDeps['logger'],
): Promise<void> {
  // Collect skill ids that the current plan references (projected or not).
  const planSkillIds = new Set(plan.links.map((l) => l.skillId))
  for (const agent of installedAgents) {
    const skillsDir = agentSkillsDir(agent)
    const skillIds = await collectProjectedSkillIds(fs, skillsDir)
    for (const skillId of skillIds) {
      if (planSkillIds.has(skillId)) continue
      const dest = join(skillsDir, skillId)
      if (await fs.isLink(dest)) {
        await fs.removeLink(dest)
        await removeEmptySkillParents(fs, skillsDir, dest)
      } else if (await fs.exists(dest)) {
        if (await isManagedCopy(fs, dest)) {
          await fs.removeDir(dest)
          await removeEmptySkillParents(fs, skillsDir, dest)
        } else {
          logger?.warn?.('skip orphan cleanup: target is real file/dir', { dest })
        }
      }
    }
  }
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
    let entries: string[]
    try {
      entries = await fs.readDir(current)
    } catch {
      return
    }
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
    if (!e.targets.includes(agent)) continue
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
        targets: e.targets,
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
  if (u.kind === 'unlink') {
    if (await fs.isLink(u.path)) {
      await fs.removeLink(u.path)
    } else if (await isManagedCopy(fs, u.path)) {
      await fs.removeDir(u.path)
    } else {
      throw new Error(`cannot rollback copy artifact (not a link): ${u.path}`)
    }
  } else if (u.kind === 'restoreNamespace') {
    if ((await fs.isLink(u.path)) || (await fs.exists(u.path))) await fs.removeDir(u.path)
    if (u.backupPath) await fs.move(u.backupPath, u.path)
  } else if (u.kind === 'restoreMemory') {
    if (u.backup === null) {
      await fs.removeFile(u.path)
    } else {
      await fs.writeFile(u.path, u.backup)
    }
  } else {
    if (u.backup === null) {
      throw new Error(`cannot rollback newly created MCP file: ${u.path}`)
    } else {
      await fs.writeFile(u.path, u.backup)
    }
  }
}
