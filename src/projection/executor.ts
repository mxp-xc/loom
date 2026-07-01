import { join } from 'node:path'
import type { IFileSystem } from '../platform/interfaces.js'
import type { IAgentAdapter, McpFragment, ProjectionJournal, UndoAction, ProjectionFailure } from '../adapters/types.js'
import type { ProjectionPlan, McpPlanEntry } from '../core/projection.js'
import type { Manifest, AgentId, McpServer } from '../core/types.js'
import { resolveVars, type VarsContext } from '../core/vars.js'
import { agentMcpFile, agentSkillsDir } from '../adapters/paths.js'
import { mergeMcp } from './mcp-merge.js'

export interface ProjectionDeps {
  fs: IFileSystem
  adapters: Partial<Record<AgentId, IAgentAdapter>>
  installedAgents: Set<AgentId>
  resolveSkillSrc: (link: ProjectionPlan['links'][number]) => string | null
  logger?: { error: (obj: unknown, msg: string) => void; warn?: (obj: unknown, msg: string) => void }
  // Per-agent set of mcp ids loom projected last time (persisted by caller).
  // Used to distinguish loom-managed entries (removable) from user-handwritten (preserved).
  // Absent => first run / state lost: mergeMcp degrades to preserving all existing entries.
  getManagedMcpIds?: (agent: AgentId) => Promise<Set<string>>
  setManagedMcpIds?: (agent: AgentId, ids: string[]) => Promise<void>
}

export type ProjectionResult = { ok: true } | { ok: false; failure: ProjectionFailure }

export async function executeProjection(
  plan: ProjectionPlan,
  manifest: Manifest,
  varsCtx: VarsContext,
  deps: ProjectionDeps,
): Promise<ProjectionResult> {
  if (manifest.errors.length > 0) {
    return { ok: false, failure: { failedStep: 'manifest-invalid', originalError: new Error(manifest.errors.join('; ')), rollbackReport: { undone: 0, rollbackFailures: [] } } }
  }
  const journal: ProjectionJournal = { undos: [] }
  const { fs, adapters, installedAgents } = deps
  try {
    // Phase A: build enabled links
    const builtDests = new Set<string>()
    for (const link of plan.links) {
      const src = deps.resolveSkillSrc(link)
      if (!src || link.targets.length === 0) continue
      for (const agent of link.targets) {
        const skillsDir = agentSkillsDir(agent)
        await fs.mkdir(skillsDir, true)
        const dest = join(skillsDir, link.skillId)
        if (await fs.isLink(dest)) { await fs.removeLink(dest) }
        else if (await fs.exists(dest)) { deps.logger?.warn?.({ dest, skillId: link.skillId }, 'skip cleanup: target is real file/dir'); continue }
        if (plan.strategy === 'copy') {
          await fs.copyDir(src, dest)
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
        if (await fs.isLink(dest)) { await fs.removeLink(dest) }
        else if (await fs.exists(dest)) { deps.logger?.warn?.({ dest, skillId: link.skillId }, 'skip cleanup: target is real file/dir') }
      }
    }
    // Phase C: clean orphaned links — skills deleted from manifest entirely.
    // Scan each installed agent's skills dir; any loom-projected link whose id is
    // not in the current plan's link set is removed. Non-link real dirs are skipped.
    await cleanOrphanedLinks(plan, installedAgents, fs, deps.logger)
    // MCP config
    for (const agent of Object.keys(adapters) as AgentId[]) {
      const adapter = adapters[agent]
      if (!adapter) continue
      const file = agentMcpFile(agent)
      const fragments = resolveMcpFragments(plan.mcpEntries, manifest.mcp, agent, varsCtx, deps.logger)
      // Even with no fragments we must still remove managed entries the manifest deleted.
      const managedIds = await deps.getManagedMcpIds?.(agent) ?? new Set<string>()
      if (fragments.length === 0 && managedIds.size === 0) continue
      const backup = await fs.exists(file) ? await fs.readFile(file) : null
      journal.undos.push({ kind: 'restoreMcp', path: file, backup })
      const existing = await adapter.readMcp(fs)
      const merged = mergeMcp(existing, fragments, managedIds)
      await adapter.writeMcp(fs, merged)
      await deps.setManagedMcpIds?.(agent, fragments.map(f => f.id))
    }
    return { ok: true }
  } catch (originalError) {
    const rollbackFailures: { path: string; err: unknown }[] = []
    let undone = 0
    for (const u of [...journal.undos].reverse()) {
      try { await applyUndo(u, fs); undone++ }
      catch (e) { rollbackFailures.push({ path: u.path, err: e }); deps.logger?.error({ err: e, undo: u }, 'projection rollback step failed') }
    }
    deps.logger?.error({ err: originalError, rollbackReport: { undone, rollbackFailures } }, 'projection failed, rolled back')
    return { ok: false, failure: { failedStep: 'projection', originalError, rollbackReport: { undone, rollbackFailures } } }
  }
}

async function cleanOrphanedLinks(
  plan: ProjectionPlan,
  installedAgents: Set<AgentId>,
  fs: IFileSystem,
  logger?: ProjectionDeps['logger'],
): Promise<void> {
  // Collect skill ids that the current plan references (projected or not).
  const planSkillIds = new Set(plan.links.map(l => l.skillId))
  for (const agent of installedAgents) {
    const skillsDir = agentSkillsDir(agent)
    let entries: string[]
    try { entries = await fs.readDir(skillsDir) } catch { continue } // dir may not exist yet
    for (const name of entries) {
      if (planSkillIds.has(name)) continue
      const dest = join(skillsDir, name)
      if (await fs.isLink(dest)) { await fs.removeLink(dest) }
      // real file/dir is left untouched (user data)
      else if (await fs.exists(dest)) { logger?.warn?.({ dest }, 'skip orphan cleanup: target is real file/dir') }
    }
  }
}

function resolveMcpFragments(entries: McpPlanEntry[], mcp: McpServer[], agent: AgentId, ctx: VarsContext, logger?: ProjectionDeps['logger']): McpFragment[] {
  const byId = new Map(mcp.map(s => [s.id, s]))
  const out: McpFragment[] = []
  for (const e of entries) {
    if (!e.targets.includes(agent)) continue
    const s = byId.get(e.id)
    if (!s) continue
    try {
      const rv = (v: string | undefined) => v === undefined ? undefined : resolveVars(v, ctx)
      const rva = (v: string[] | undefined) => v?.map(a => resolveVars(a, ctx))
      const rvm = (v: Record<string, string> | undefined) => v && Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveVars(x, ctx)]))
      out.push({ id: s.id, type: s.type, targets: e.targets, command: rv(s.command), args: rva(s.args), env: rvm(s.env), url: rv(s.url), headers: rvm(s.headers) })
    } catch (e) {
      logger?.error({ err: e, mcpId: s.id, agent }, 'mcp var resolve failed, skip this entry')
    }
  }
  return out
}

async function applyUndo(u: UndoAction, fs: IFileSystem): Promise<void> {
  if (u.kind === 'unlink') {
    if (await fs.isLink(u.path)) { await fs.removeLink(u.path) }
    else { throw new Error(`cannot rollback copy artifact (not a link): ${u.path}`) }
  } else {
    if (u.backup === null) {
      throw new Error(`cannot rollback newly created MCP file: ${u.path}`)
    } else {
      await fs.writeFile(u.path, u.backup)
    }
  }
}
