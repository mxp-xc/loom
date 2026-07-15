import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type {
  AgentId,
  SkillSource,
  SourceProjectionEntry,
  SourceTree,
  SourceTreeNode,
} from '@loom/core'
import {
  compareVersion,
  planSourceProjectionForTargets,
  resourceSelectionState,
  type RemoteRef,
  type VersionStatus,
} from '@loom/core'
import { scanSourceTree } from './source-tree.js'
import { cacheDirFor } from './cache.js'
import { deriveRepoId } from '@loom/core'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  classifySkillMemberChanges,
  normalizeSkillPath,
  type SkillMemberChangeSet,
  type SkillMemberSnapshot,
} from '../skills/reconciliation.js'
import { logger } from '../lib/logger.js'

const updateLogger = logger.child('remote.update')

export async function checkUpdates(
  sources: SkillSource[],
  git: IGit,
): Promise<(VersionStatus & { source: SkillSource })[]> {
  const out: (VersionStatus & { source: SkillSource })[] = []
  for (const s of sources) {
    const remote: RemoteRef = await git.lsRemote(s.url)
    out.push({
      ...compareVersion({ ref: s.ref, pinned_commit: s.pinned_commit ?? '' }, remote),
      source: s,
    })
  }
  return out
}

export interface ScannedSourceBundle {
  name: string
  entry: string
  description?: string
}

export interface PreparedSourceUpdate {
  pinned_commit: string
  stagingDir: string
  candidateDir: string
  newMembers: ScannedSourceBundle[]
  changes: SkillMemberChangeSet
  resourceBoundaryChanges: ResourceBoundaryChange[]
  pathMoves: ProjectionPathMove[]
}

export interface ResourceBoundaryChange {
  name: string
  entry: string
  path: string
}

export interface ProjectionPathMove {
  target: AgentId
  kind: SourceProjectionEntry['kind']
  sourcePath: string
  previousTargetPath?: string
  nextTargetPath?: string
}

export async function prepareSourceUpdate(
  git: IGit,
  fs: IFileSystem,
  source: SkillSource,
  newRef: string,
  repoPath: string,
  oldMembers: SkillMemberSnapshot[],
): Promise<PreparedSourceUpdate> {
  const cacheDir = cacheDirFor(repoPath, deriveRepoId(source.url))
  const sessionRoot = join(repoPath, 'temp', 'source-updates', randomUUID())
  const stagingDir = join(sessionRoot, 'previous')
  const candidateDir = join(sessionRoot, 'candidate')
  await fs.mkdir(stagingDir, true)
  try {
    const previousTree = await readPreviousSourceTree(git, fs, cacheDir, source)
    const previousBundleEntries = new Set(
      previousTree
        ? bundleMembers(previousTree.nodes).map(({ entry }) => entry)
        : (source.members ?? []).map(({ entry }) => entry),
    )
    for (const member of oldMembers) {
      const skillPath = normalizeSkillPath(member.path)
      const sourceDir = join(cacheDir, dirname(skillPath))
      if (await fs.exists(sourceDir)) {
        const parent = dirname(skillPath)
        if (parent === '.') await copyRootBundleSnapshot(fs, sourceDir, stagingDir)
        else await fs.copyDir(sourceDir, join(stagingDir, parent))
      }
    }
    await git.clone(source.url, candidateDir, false)
    await git.checkout(candidateDir, newRef)
    const sourceTree = await scanSourceTree(git, candidateDir, 'HEAD', source)
    if (sourceTree.diagnostics.length > 0) {
      throw new Error(sourceTree.diagnostics.map(({ message }) => message).join('; '))
    }
    const pinned_commit = sourceTree.commit
    const newMembers = bundleMembers(sourceTree.nodes)
    const resourceBoundaryChanges = detectResourceBoundaryChanges(
      source,
      previousBundleEntries,
      newMembers,
    )
    const pathMoves = previousTree
      ? compareProjectionPaths(source, previousTree, sourceTree, newMembers)
      : []
    const previousSnapshots = oldMembers
    const nextSnapshots = newMembers.map((member) => ({
      name: member.name,
      entry: member.entry,
      path: member.entry,
    }))
    const changes = await classifySkillMemberChanges(
      fs,
      stagingDir,
      candidateDir,
      previousSnapshots,
      nextSnapshots,
    )
    return {
      pinned_commit,
      stagingDir,
      candidateDir,
      newMembers,
      changes,
      resourceBoundaryChanges,
      pathMoves,
    }
  } catch (err) {
    await fs.removeDir(sessionRoot)
    updateLogger.error('source update prepare failed', { err, source: source.url, ref: newRef })
    throw err
  }
}

async function copyRootBundleSnapshot(
  fs: IFileSystem,
  source: string,
  destination: string,
): Promise<void> {
  for (const name of await fs.readDir(source)) {
    if (name === '.git') continue
    const childSource = join(source, name)
    const childDestination = join(destination, name)
    if (await fs.isDirectory(childSource)) await fs.copyDir(childSource, childDestination)
    else await fs.copyFile(childSource, childDestination)
  }
}

async function readPreviousSourceTree(
  git: IGit,
  fs: IFileSystem,
  cacheDir: string,
  source: SkillSource,
): Promise<SourceTree | undefined> {
  if (source.sourceTree) return source.sourceTree
  if (await fs.exists(cacheDir)) {
    try {
      const tree = await scanSourceTree(git, cacheDir, source.pinned_commit ?? 'HEAD', source)
      return tree
    } catch (err) {
      updateLogger.warn('previous source tree unavailable during update prepare', {
        err,
        source: source.url,
        commit: source.pinned_commit,
      })
    }
  }
  return undefined
}

export function compareProjectionPaths(
  source: SkillSource,
  previousTree: SourceTree,
  nextTree: SourceTree,
  nextBundles: readonly ScannedSourceBundle[],
): ProjectionPathMove[] {
  const targets = new Set(
    (source.members ?? []).flatMap((member) => member.targets ?? []),
  ) as Set<AgentId>
  if (targets.size === 0) return []
  const previousEntries = new Set(bundleMembers(previousTree.nodes).map(({ entry }) => entry))
  const previousPlans = planSourceProjectionForTargets(
    {
      ...source,
      members: (source.members ?? []).filter(({ entry }) => previousEntries.has(entry)),
      sourceTree: previousTree,
    },
    targets,
  )
  const nextBundleEntries = new Set(nextBundles.map(({ entry }) => entry))
  const nextMembers = (source.members ?? [])
    .filter(({ entry }) => nextBundleEntries.has(entry))
    .map((member) => ({
      ...member,
      name: nextBundles.find(({ entry }) => entry === member.entry)?.name ?? member.name,
    }))
  const nextPlans = planSourceProjectionForTargets(
    { ...source, members: nextMembers, sourceTree: nextTree },
    targets,
  )
  const previous = projectionEntryMap(previousPlans)
  const next = projectionEntryMap(nextPlans)
  const keys = [...new Set([...previous.keys(), ...next.keys()])].sort((a, b) =>
    a.localeCompare(b, 'en'),
  )
  return keys.flatMap((key) => {
    const before = previous.get(key)
    const after = next.get(key)
    if (before?.targetPath === after?.targetPath) return []
    const [target, kind, sourcePath] = key.split('\0') as [
      AgentId,
      SourceProjectionEntry['kind'],
      string,
    ]
    return [
      {
        target,
        kind,
        sourcePath,
        ...(before ? { previousTargetPath: before.targetPath } : {}),
        ...(after ? { nextTargetPath: after.targetPath } : {}),
      },
    ]
  })
}

function projectionEntryMap(
  plans: ReturnType<typeof planSourceProjectionForTargets>,
): Map<string, SourceProjectionEntry> {
  return new Map(
    plans.flatMap((plan) =>
      plan.entries.map(
        (entry) => [`${plan.target}\0${entry.kind}\0${entry.sourcePath}`, entry] as const,
      ),
    ),
  )
}

export function detectResourceBoundaryChanges(
  source: Pick<SkillSource, 'resources'>,
  previousBundleEntries: ReadonlySet<string>,
  nextBundles: readonly ScannedSourceBundle[],
): ResourceBoundaryChange[] {
  if (!source.resources?.include.length) return []
  return nextBundles.flatMap((bundle) => {
    if (previousBundleEntries.has(bundle.entry)) return []
    const path = bundle.entry.split('/').slice(0, -1).join('/')
    if (!path || !resourceSelectionIntersects(path, source.resources!)) return []
    return [{ name: bundle.name, entry: bundle.entry, path }]
  })
}

function resourceSelectionIntersects(
  bundlePath: string,
  resources: NonNullable<SkillSource['resources']>,
): boolean {
  if (resourceSelectionState(bundlePath, 'directory', resources).selected) return true
  return resources.include.some(
    (rule) =>
      rule.path.startsWith(`${bundlePath}/`) &&
      resourceSelectionState(rule.path, rule.kind, resources).selected,
  )
}

function bundleMembers(nodes: readonly SourceTreeNode[]): ScannedSourceBundle[] {
  const members: ScannedSourceBundle[] = []
  for (const node of nodes) {
    if (node.kind === 'bundle') {
      members.push({
        name: node.name,
        entry: node.entry,
        ...(node.description ? { description: node.description } : {}),
      })
    } else if (node.kind === 'container') {
      members.push(...bundleMembers(node.children))
    }
  }
  return members.sort((a, b) => a.entry.localeCompare(b.entry, 'en'))
}
