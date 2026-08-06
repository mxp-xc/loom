import type { GitRefType, IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type {
  AgentId,
  SkillProjectionDestination,
  SkillSource,
  SourceProjectionEntry,
  SourceTree,
  SourceTreeNode,
} from '@loom/core'
import {
  compareVersion,
  parseSkillProjectionDestinationKey,
  planSourceProjectionForDestinations,
  resourceSelectionState,
  skillProjectionDestinationKey,
  type RemoteRef,
  type VersionStatus,
} from '@loom/core'
import { scanSourceTree, scanSourceTreeWithoutMetadata } from './source-tree.js'
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
  candidateIdentity?: string
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
  destination: SkillProjectionDestination
  kind: SourceProjectionEntry['kind']
  sourcePath: string
  previousTargetPath?: string
  nextTargetPath?: string
}

export class SourceUpdateRefChangedError extends Error {
  readonly code = 'source_update_stale'

  constructor(
    readonly expectedCommit: string,
    readonly actualCommit: string,
  ) {
    super('source ref changed after update check')
    this.name = 'SourceUpdateRefChangedError'
  }
}

export async function prepareSourceUpdate(
  git: IGit,
  fs: IFileSystem,
  source: SkillSource,
  newRef: string,
  workspace: SourceUpdateWorkspace,
  oldMembers: SkillMemberSnapshot[],
  expectedCommit?: string,
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
    const refType = await resolveUpdateRefType(git, source, newRef)
    let metadataOnlyCandidate = false
    let sourceTree: SourceTree
    if (cacheEntry && previousTree) {
      await assertOwnedDirectory(fs, cacheDir, cacheEntry.identity, 'previous source cache')
      await git.clone(cacheDir, candidateDir, false)
      await assertOwnedDirectory(fs, cacheDir, cacheEntry.identity, 'previous source cache')
      await git.addOrUpdateRemote(candidateDir, source.url)
      await git.fetchRef(candidateDir, newRef, refType, { filter: 'blob:none' })
      sourceTree = await scanSourceTreeWithoutMetadata(git, candidateDir, 'FETCH_HEAD', source)
      metadataOnlyCandidate = true
    } else {
      await git.clone(source.url, candidateDir, false)
      await git.fetchRef(candidateDir, newRef, refType)
      await git.checkout(candidateDir, 'FETCH_HEAD')
      sourceTree = await scanSourceTree(git, candidateDir, 'HEAD', source)
    }
    await assertOwnedDirectory(fs, candidateDir, candidateEntry.identity, 'candidate source cache')
    if (expectedCommit && sourceTree.commit !== expectedCommit) {
      throw new SourceUpdateRefChangedError(expectedCommit, sourceTree.commit)
    }
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
    const selectedEntries = new Set(oldMembers.map((member) => member.entry ?? member.path))
    const selectedNextMembers = newMembers
      .filter((member) => selectedEntries.has(member.entry))
      .map((member) => ({ name: member.name, entry: member.entry, path: member.entry }))
    const selectedChanges =
      metadataOnlyCandidate && previousTree
        ? classifySourceTreeMemberChanges(previousTree, sourceTree, oldMembers, selectedNextMembers)
        : await classifySkillMemberChanges(
            fs,
            stagingDir,
            candidateDir,
            oldMembers,
            selectedNextMembers,
          )
    const changes: SkillMemberChangeSet = {
      ...selectedChanges,
      added: newMembers
        .filter((member) => !previousBundleEntries.has(member.entry))
        .map((member) => ({ name: member.name, nextPath: member.entry })),
    }
    return {
      pinned_commit,
      candidateIdentity: candidateEntry.identity,
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

export async function hydrateSourceUpdateCandidate(
  git: IGit,
  fs: IFileSystem,
  workspace: SourceUpdateWorkspace,
  pinnedCommit: string,
  expectedCandidateIdentity?: string,
): Promise<void> {
  const candidate = await inspectOptionalOwnedDirectory(
    fs,
    workspace.candidateDir,
    'candidate source cache',
  )
  if (!candidate) throw new Error('Candidate source cache is unavailable')
  if (expectedCandidateIdentity && candidate.identity !== expectedCandidateIdentity) {
    throw new Error('Candidate source cache identity changed before checkout')
  }
  const candidateIdentity = expectedCandidateIdentity ?? candidate.identity
  await assertOwnedDirectory(
    fs,
    workspace.candidateDir,
    candidateIdentity,
    'candidate source cache',
  )
  if ((await git.revParseHead(workspace.candidateDir)) !== pinnedCommit) {
    await git.checkout(workspace.candidateDir, pinnedCommit)
  }
  await assertOwnedDirectory(
    fs,
    workspace.candidateDir,
    candidateIdentity,
    'candidate source cache',
  )
  const hydratedCommit = await git.revParseHead(workspace.candidateDir)
  if (hydratedCommit !== pinnedCommit) {
    throw new Error(`Candidate source cache checkout mismatch: ${hydratedCommit}`)
  }
  if ((await git.status(workspace.candidateDir)).dirty) {
    throw new Error('Candidate source cache is dirty after checkout')
  }
}

async function resolveUpdateRefType(
  git: IGit,
  source: Pick<SkillSource, 'url' | 'type'>,
  newRef: string,
): Promise<GitRefType> {
  if (source.type) return source.type
  if (newRef.startsWith('refs/heads/')) return 'branch'
  if (newRef.startsWith('refs/tags/')) return 'tag'
  const remote = await git.lsRemote(source.url)
  return Object.hasOwn(remote.tags, newRef) ? 'tag' : 'branch'
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

function classifySourceTreeMemberChanges(
  previousTree: SourceTree,
  nextTree: SourceTree,
  previousMembers: readonly SkillMemberSnapshot[],
  nextMembers: readonly SkillMemberSnapshot[],
): SkillMemberChangeSet {
  const previousByEntry = new Map(
    previousMembers.map((member) => [member.entry ?? member.name, member]),
  )
  const nextByEntry = new Map(nextMembers.map((member) => [member.entry ?? member.name, member]))
  const previousBundles = bundleNodeMap(previousTree.nodes)
  const nextBundles = bundleNodeMap(nextTree.nodes)
  const changes: SkillMemberChangeSet = { added: [], updated: [], removed: [], unchanged: [] }

  for (const member of previousMembers) {
    if (!nextByEntry.has(member.entry ?? member.name)) {
      changes.removed.push(toMemberChange(member, undefined))
    }
  }
  for (const member of nextMembers) {
    const old = previousByEntry.get(member.entry ?? member.name)
    if (!old) {
      changes.added.push(toMemberChange(undefined, member))
      continue
    }
    const previousPath = normalizeSkillPath(old.path)
    const nextPath = normalizeSkillPath(member.path)
    const previousBundle = previousBundles.get(previousPath)
    const nextBundle = nextBundles.get(nextPath)
    if (!previousBundle || !nextBundle) {
      throw new Error(`Source update bundle tree is unavailable: ${nextPath}`)
    }
    const changed = previousPath !== nextPath || previousBundle.oid !== nextBundle.oid
    changes[changed ? 'updated' : 'unchanged'].push(toMemberChange(old, member))
  }

  for (const list of [changes.added, changes.updated, changes.removed, changes.unchanged]) {
    list.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  }
  return changes
}

function bundleNodeMap(
  nodes: readonly SourceTreeNode[],
): Map<string, Extract<SourceTreeNode, { kind: 'bundle' }>> {
  const bundles = new Map<string, Extract<SourceTreeNode, { kind: 'bundle' }>>()
  for (const node of nodes) {
    if (node.kind === 'bundle') {
      bundles.set(node.entry, node)
    } else if (node.kind === 'container') {
      for (const [entry, bundle] of bundleNodeMap(node.children)) bundles.set(entry, bundle)
    }
  }
  return bundles
}

function toMemberChange(
  previous: SkillMemberSnapshot | undefined,
  next: SkillMemberSnapshot | undefined,
): SkillMemberChangeSet['updated'][number] {
  return {
    name: (next ?? previous)!.name,
    ...(previous ? { previousPath: normalizeSkillPath(previous.path) } : {}),
    ...(next ? { nextPath: normalizeSkillPath(next.path) } : {}),
    ...(previous?.agents ? { agents: [...previous.agents] } : {}),
    ...(previous?.shared ? { shared: true } : {}),
  }
}

export function compareProjectionPaths(
  source: SkillSource,
  previousTree: SourceTree,
  nextTree: SourceTree,
  nextBundles: readonly ScannedSourceBundle[],
): ProjectionPathMove[] {
  const destinations = [
    ...new Set((source.members ?? []).flatMap((member) => member.agents ?? [])),
  ].map((agent): SkillProjectionDestination => ({ kind: 'agent', agent }))
  if ((source.members ?? []).some((member) => member.shared === true)) {
    destinations.push({ kind: 'shared' })
  }
  if (destinations.length === 0) return []
  const previousEntries = new Set(bundleMembers(previousTree.nodes).map(({ entry }) => entry))
  const previousPlans = planSourceProjectionForDestinations(
    {
      ...source,
      members: (source.members ?? []).filter(({ entry }) => previousEntries.has(entry)),
      sourceTree: previousTree,
    },
    new Set(destinations.map(skillProjectionDestinationKey)),
  )
  const nextBundleEntries = new Set(nextBundles.map(({ entry }) => entry))
  const nextMembers = (source.members ?? [])
    .filter(({ entry }) => nextBundleEntries.has(entry))
    .map((member) => ({
      ...member,
      name: nextBundles.find(({ entry }) => entry === member.entry)?.name ?? member.name,
    }))
  const nextPlans = planSourceProjectionForDestinations(
    { ...source, members: nextMembers, sourceTree: nextTree },
    new Set(destinations.map(skillProjectionDestinationKey)),
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
    const [destinationKey, kind, sourcePath] = key.split('\0') as [
      string,
      SourceProjectionEntry['kind'],
      string,
    ]
    const destination = parseSkillProjectionDestinationKey(destinationKey)
    if (!destination) throw new Error(`Invalid projection destination key: ${destinationKey}`)
    return [
      {
        destination,
        kind,
        sourcePath,
        ...(before ? { previousTargetPath: before.targetPath } : {}),
        ...(after ? { nextTargetPath: after.targetPath } : {}),
      },
    ]
  })
}

function projectionEntryMap(
  plans: ReturnType<typeof planSourceProjectionForDestinations>,
): Map<string, SourceProjectionEntry> {
  return new Map(
    plans.flatMap((plan) =>
      plan.entries.map(
        (entry) =>
          [
            `${skillProjectionDestinationKey(plan.destination)}\0${entry.kind}\0${entry.sourcePath}`,
            entry,
          ] as const,
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
