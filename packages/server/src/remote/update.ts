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
  planSourceProjectionForAgents,
  resourceSelectionState,
  type RemoteRef,
  type VersionStatus,
} from '@loom/core'
import { scanSourceTree } from './source-tree.js'
import { cacheDirFor } from './cache.js'
import { deriveRepoId } from '@loom/core'
import { dirname, join } from 'node:path'
import {
  classifySkillMemberChanges,
  normalizeSkillPath,
  type SkillMemberChangeSet,
  type SkillMemberSnapshot,
} from '../skills/reconciliation.js'
import { logger } from '../lib/logger.js'
import {
  assertOwnedDirectory,
  ensureSourceUpdateChildDirectory,
  inspectOptionalOwnedDirectory,
  removeSourceUpdateWorkspace,
  type SourceUpdateWorkspace,
} from '../skills/source-update-workspace.js'

const updateLogger = logger.child('remote.update')

export async function checkUpdates(
  sources: SkillSource[],
  git: IGit,
): Promise<(VersionStatus & { source: SkillSource })[]> {
  const out: (VersionStatus & { source: SkillSource })[] = []
  for (const s of sources) {
    const remote: RemoteRef = await git.lsRemote(s.url)
    out.push({
      ...compareVersion({ ref: s.ref, pinned_commit: s.pinned_commit ?? '', type: s.type }, remote),
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
  agent: AgentId
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
  workspace: SourceUpdateWorkspace,
  oldMembers: SkillMemberSnapshot[],
): Promise<PreparedSourceUpdate> {
  const cacheDir = cacheDirFor(workspace.repoPath, deriveRepoId(source.url))
  const { stagingDir, candidateDir } = workspace
  try {
    await ensureSourceUpdateChildDirectory(fs, workspace.repoPath, 'remote-cache')
    const cacheEntry = await inspectOptionalOwnedDirectory(fs, cacheDir, 'previous source cache')
    const stagingEntry = await inspectOptionalOwnedDirectory(
      fs,
      stagingDir,
      'previous source snapshot',
    )
    const candidateEntry = await inspectOptionalOwnedDirectory(
      fs,
      candidateDir,
      'candidate source cache',
    )
    if (!stagingEntry || !candidateEntry) throw new Error('Source update workspace is incomplete')
    const previousTree = await readPreviousSourceTree(git, cacheDir, source, Boolean(cacheEntry))
    const previousBundleEntries = new Set(
      previousTree
        ? bundleMembers(previousTree.nodes).map(({ entry }) => entry)
        : (source.members ?? []).map(({ entry }) => entry),
    )
    await snapshotPinnedMembers(
      git,
      fs,
      cacheDir,
      cacheEntry?.identity,
      source,
      oldMembers,
      stagingDir,
    )
    await assertOwnedDirectory(fs, stagingDir, stagingEntry.identity, 'previous source snapshot')
    await git.clone(source.url, candidateDir, false)
    await git.checkout(candidateDir, newRef)
    await assertOwnedDirectory(fs, candidateDir, candidateEntry.identity, 'candidate source cache')
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
      newMembers,
      changes,
      resourceBoundaryChanges,
      pathMoves,
    }
  } catch (err) {
    let failure: unknown = err
    try {
      await removeSourceUpdateWorkspace(fs, workspace, source.url)
    } catch (cleanupError) {
      failure = new AggregateError(
        [err, cleanupError],
        'source update prepare and workspace cleanup failed',
        { cause: err },
      )
    }
    updateLogger.error('source update prepare failed', {
      err: failure,
      source: source.url,
      ref: newRef,
    })
    throw failure
  }
}

async function snapshotPinnedMembers(
  git: IGit,
  fs: IFileSystem,
  cacheDir: string,
  cacheIdentity: string | undefined,
  source: SkillSource,
  members: readonly SkillMemberSnapshot[],
  stagingDir: string,
): Promise<void> {
  if (members.length === 0) return
  if (!source.pinned_commit) {
    throw new Error('Cannot preserve source members without a pinned commit')
  }
  if (!cacheIdentity) throw new Error('Previous source cache is unavailable')
  await assertOwnedDirectory(fs, cacheDir, cacheIdentity, 'previous source cache')
  const entries = await git.readTree(cacheDir, source.pinned_commit)
  const selected = new Map<string, { mode: string; oid: string }>()

  for (const member of members) {
    const skillPath = normalizeSkillPath(member.path)
    const root = dirname(skillPath) === '.' ? '' : dirname(skillPath)
    const prefix = root ? `${root}/` : ''
    const subtree = entries.filter(({ path }) => !root || path === root || path.startsWith(prefix))
    const skillEntry = subtree.find(({ path }) => path === skillPath)
    if (!skillEntry || skillEntry.type !== 'blob' || !isRegularBlobMode(skillEntry.mode)) {
      throw new Error(`Pinned source skill is unavailable or not a regular file: ${skillPath}`)
    }
    for (const entry of subtree) {
      if (entry.type === 'tree') continue
      if (entry.type !== 'blob' || !isRegularBlobMode(entry.mode)) {
        throw new Error(`Pinned source member contains an unsupported entry: ${entry.path}`)
      }
      if (!isSafeGitPath(entry.path)) {
        throw new Error(`Pinned source member contains an invalid path: ${entry.path}`)
      }
      const previous = selected.get(entry.path)
      if (previous && (previous.mode !== entry.mode || previous.oid !== entry.oid)) {
        throw new Error(`Pinned source snapshot path collision: ${entry.path}`)
      }
      selected.set(entry.path, { mode: entry.mode, oid: entry.oid })
    }
  }

  const files = [...selected.keys()].sort((left, right) => {
    const leftIsSkill = left.endsWith('/SKILL.md') || left === 'SKILL.md'
    const rightIsSkill = right.endsWith('/SKILL.md') || right === 'SKILL.md'
    if (leftIsSkill !== rightIsSkill) return leftIsSkill ? 1 : -1
    return left.localeCompare(right, 'en')
  })
  const normalizedPaths = new Set<string>()
  for (const path of files) {
    const key = path.toLowerCase()
    if (normalizedPaths.has(key)) throw new Error(`Pinned source snapshot path collision: ${path}`)
    const segments = key.split('/')
    for (let index = 1; index < segments.length; index++) {
      if (normalizedPaths.has(segments.slice(0, index).join('/'))) {
        throw new Error(`Pinned source snapshot file/ancestor collision: ${path}`)
      }
    }
    normalizedPaths.add(key)
  }
  for (const path of files) {
    const destination = join(stagingDir, path)
    await fs.mkdir(dirname(destination), true)
    await fs.writeFile(destination, await git.show(cacheDir, source.pinned_commit, path))
  }
  await assertOwnedDirectory(fs, cacheDir, cacheIdentity, 'previous source cache')
}

function isRegularBlobMode(mode: string): boolean {
  return mode === '100644' || mode === '100755'
}

function isSafeGitPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:\//.test(path))
    return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

async function readPreviousSourceTree(
  git: IGit,
  cacheDir: string,
  source: SkillSource,
  cacheAvailable: boolean,
): Promise<SourceTree | undefined> {
  if (source.sourceTree) return source.sourceTree
  if (cacheAvailable) {
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
  const agents = new Set(
    (source.members ?? []).flatMap((member) => member.agents ?? []),
  ) as Set<AgentId>
  if (agents.size === 0) return []
  const previousEntries = new Set(bundleMembers(previousTree.nodes).map(({ entry }) => entry))
  const previousPlans = planSourceProjectionForAgents(
    {
      ...source,
      members: (source.members ?? []).filter(({ entry }) => previousEntries.has(entry)),
      sourceTree: previousTree,
    },
    agents,
  )
  const nextBundleEntries = new Set(nextBundles.map(({ entry }) => entry))
  const nextMembers = (source.members ?? [])
    .filter(({ entry }) => nextBundleEntries.has(entry))
    .map((member) => ({
      ...member,
      name: nextBundles.find(({ entry }) => entry === member.entry)?.name ?? member.name,
    }))
  const nextPlans = planSourceProjectionForAgents(
    { ...source, members: nextMembers, sourceTree: nextTree },
    agents,
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
    const [agent, kind, sourcePath] = key.split('\0') as [
      AgentId,
      SourceProjectionEntry['kind'],
      string,
    ]
    return [
      {
        agent,
        kind,
        sourcePath,
        ...(before ? { previousTargetPath: before.targetPath } : {}),
        ...(after ? { nextTargetPath: after.targetPath } : {}),
      },
    ]
  })
}

function projectionEntryMap(
  plans: ReturnType<typeof planSourceProjectionForAgents>,
): Map<string, SourceProjectionEntry> {
  return new Map(
    plans.flatMap((plan) =>
      plan.entries.map(
        (entry) => [`${plan.agent}\0${entry.kind}\0${entry.sourcePath}`, entry] as const,
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
