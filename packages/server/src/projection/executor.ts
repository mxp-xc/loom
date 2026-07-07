import { dirname, join } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import type {
  IAgentAdapter,
  McpFragment,
  ProjectionJournal,
  UndoAction,
  ProjectionFailure,
} from '../ports/adapter.js'
import type { ProjectionPlan, McpPlanEntry, Manifest, AgentId, McpServer } from '@loom/core'
import { resolveVars, renderText, type VarsContext } from '@loom/core'
import { agentMcpFile, agentSkillsDir, agentMemoryFile, agentConfigDir } from '../adapters/paths.js'
import { mergeMcp } from './mcp-merge.js'

export interface ProjectionDeps {
  fs: IFileSystem
  adapters: Partial<Record<AgentId, IAgentAdapter>>
  installedAgents: Set<AgentId>
  resolveSkillSrc: (link: ProjectionPlan['links'][number]) => string | null
  logger?: {
    error: (obj: unknown, msg: string) => void
    warn?: (obj: unknown, msg: string) => void
  }
  // Per-agent set of mcp ids loom projected last time (persisted by caller).
  // Used to distinguish loom-managed entries (removable) from user-handwritten (preserved).
  // Absent => first run / state lost: mergeMcp degrades to preserving all existing entries.
  getManagedMcpIds?: (agent: AgentId) => Promise<Set<string>>
  setManagedMcpIds?: (agent: AgentId, ids: string[]) => Promise<void>
}

export type ProjectionResult = { ok: true } | { ok: false; failure: ProjectionFailure }

export type ProjectionScope = 'skills' | 'mcp' | 'memory' | 'all'
const COPY_MARKER = '.loom-projection.json'

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
              deps.logger?.warn?.(
                { dest, skillId: link.skillId },
                'skip cleanup: target is real file/dir',
              )
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
      // Phase B: clean stale links for skills still in manifest but no longer projected
      // (enabled:false etc). Orphaned links from deleted skills are cleaned in Phase C.
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
              deps.logger?.warn?.(
                { dest, skillId: link.skillId },
                'skip cleanup: target is real file/dir',
              )
            }
          }
        }
      }
      // Phase C: clean orphaned links — skills deleted from manifest entirely.
      // Scan each installed agent's skills dir; any loom-projected link whose id is
      // not in the current plan's link set is removed. Non-link real dirs are skipped.
      await cleanOrphanedLinks(plan, installedAgents, fs, deps.logger)
    }
    // MCP config
    if (scope === 'mcp' || scope === 'all') {
      for (const agent of Object.keys(adapters) as AgentId[]) {
        const adapter = adapters[agent]
        if (!adapter) continue
        const file = agentMcpFile(agent)
        const fragments = resolveMcpFragments(
          plan.mcpEntries,
          manifest.mcp,
          agent,
          varsCtx,
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
      if (mp.active && mp.content !== null) {
        for (const agent of mp.targets) {
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
            rendered = renderText(mp.content, ctx)
          } catch (e) {
            deps.logger?.error({ err: e, agent }, 'memory var resolve failed')
            throw e
          }
          const path = agentMemoryFile(agent)
          await fs.mkdir(join(path, '..'), true).catch(() => {})
          const backup = (await fs.exists(path)) ? await fs.readFile(path) : null
          journal.undos.push({ kind: 'restoreMemory', path, backup })
          await fs.writeFile(path, rendered)
        }
      } else {
        deps.logger?.warn?.({}, 'no active memory, skip memory phase')
      }
    }
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
        deps.logger?.error({ err: e, undo: u }, 'projection rollback step failed')
      }
    }
    deps.logger?.error(
      { err: originalError, rollbackReport: { undone, rollbackFailures } },
      'projection failed, rolled back',
    )
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
          logger?.warn?.({ dest }, 'skip orphan cleanup: target is real file/dir')
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
  while (current !== skillsDir) {
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
    current = parent
  }
}

function resolveMcpFragments(
  entries: McpPlanEntry[],
  mcp: McpServer[],
  agent: AgentId,
  ctx: VarsContext,
  logger?: ProjectionDeps['logger'],
): McpFragment[] {
  const byId = new Map(mcp.map((s) => [s.id, s]))
  const out: McpFragment[] = []
  for (const e of entries) {
    if (!e.targets.includes(agent)) continue
    const s = byId.get(e.id)
    if (!s) continue
    try {
      const rv = (v: string | undefined) => (v === undefined ? undefined : resolveVars(v, ctx))
      const rva = (v: string[] | undefined) => v?.map((a) => resolveVars(a, ctx))
      const rvm = (v: Record<string, string> | undefined) =>
        v && Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveVars(x, ctx)]))
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
      logger?.error({ err: e, mcpId: s.id, agent }, 'mcp var resolve failed, skip this entry')
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
