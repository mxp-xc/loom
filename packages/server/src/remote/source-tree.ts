import { basename, dirname } from 'node:path/posix'
import {
  deriveRepoId,
  type SkillSource,
  type SourceTree,
  type SourceTreeBundleNode,
  type SourceTreeContainerNode,
  type SourceTreeDiagnostic,
  type SourceTreeNode,
} from '@loom/core'
import type { GitTreeEntry, IGit } from '../ports/git.js'
import { logger } from '../lib/logger.js'
import { parseSkillMeta } from './frontmatter.js'

const sourceTreeLogger = logger.child('remote.source-tree')
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const METADATA_READ_CONCURRENCY = 8
let activeMetadataReads = 0
const metadataReadQueue: Array<() => void> = []
type SourceTreeSource = Pick<SkillSource, 'name' | 'url'>

interface TreeDirectory {
  path: string
  mode: string
  oid: string
  entries: GitTreeEntry[]
  children: Map<string, TreeDirectory>
}

export async function scanSourceTree(
  git: IGit,
  repoPath: string,
  ref: string,
  source: SourceTreeSource,
): Promise<SourceTree> {
  const [commit, entries, rootOid] = await Promise.all([
    git.revParse(repoPath, `${ref}^{commit}`),
    git.readTree(repoPath, ref),
    git.revParse(repoPath, `${ref}^{tree}`),
  ])
  const root = buildDirectoryIndex(entries, rootOid)
  const candidates = findBundleCandidates(root)
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path))
  const validBundles = new Set(
    candidates
      .filter(
        (candidate) =>
          !candidates.some(
            (descendant) =>
              descendant.path !== candidate.path && isDescendant(descendant.path, candidate.path),
          ),
      )
      .map((candidate) => candidate.path),
  )
  const diagnostics = buildDiagnostics(candidates, validBundles)
  validateBundleNames(
    candidates.filter((candidate) => validBundles.has(candidate.path)),
    source,
  )
  const nodes = validBundles.has('')
    ? [await renderBundle(git, repoPath, commit, source, root, diagnostics)]
    : await renderChildren(
        git,
        repoPath,
        commit,
        source,
        root,
        validBundles,
        candidatePaths,
        diagnostics,
      )
  return { commit, nodes, diagnostics: sortDiagnostics(diagnostics) }
}

function buildDirectoryIndex(entries: GitTreeEntry[], rootOid: string): TreeDirectory {
  const root: TreeDirectory = {
    path: '',
    mode: '040000',
    oid: rootOid,
    entries: [],
    children: new Map(),
  }
  const directories = new Map<string, TreeDirectory>([['', root]])
  for (const entry of entries) {
    if (entry.type !== 'tree') continue
    directories.set(entry.path, {
      path: entry.path,
      mode: entry.mode,
      oid: entry.oid,
      entries: [],
      children: new Map(),
    })
  }
  for (const directory of [...directories.values()].filter((item) => item.path)) {
    const parent = ensureDirectory(directories, dirnameOrRoot(directory.path))
    parent.children.set(basename(directory.path), directory)
  }
  for (const entry of entries) {
    if (entry.type === 'tree') continue
    ensureDirectory(directories, dirnameOrRoot(entry.path)).entries.push(entry)
  }
  return root
}

function ensureDirectory(directories: Map<string, TreeDirectory>, path: string): TreeDirectory {
  const existing = directories.get(path)
  if (existing) return existing
  const directory: TreeDirectory = {
    path,
    mode: '040000',
    oid: '',
    entries: [],
    children: new Map(),
  }
  directories.set(path, directory)
  if (path)
    ensureDirectory(directories, dirnameOrRoot(path)).children.set(basename(path), directory)
  return directory
}

function findBundleCandidates(root: TreeDirectory): TreeDirectory[] {
  const candidates: TreeDirectory[] = []
  visitDirectories(root, (directory) => {
    if (directory.entries.some((entry) => entry.path === childPath(directory.path, 'SKILL.md'))) {
      candidates.push(directory)
    }
  })
  return candidates.sort((a, b) => comparePaths(a.path, b.path))
}

function buildDiagnostics(
  candidates: TreeDirectory[],
  validBundles: Set<string>,
): SourceTreeDiagnostic[] {
  return candidates
    .filter((candidate) => !validBundles.has(candidate.path))
    .map((candidate) => {
      const descendants = candidates
        .filter(
          (descendant) =>
            descendant.path !== candidate.path && isDescendant(descendant.path, candidate.path),
        )
        .map((descendant) => childPath(descendant.path, 'SKILL.md'))
        .sort(comparePaths)
      const path = childPath(candidate.path, 'SKILL.md')
      return {
        code: 'invalid-nested-bundle' as const,
        path,
        relatedPaths: descendants,
        message: `Skill bundle candidate ${path} contains nested bundle candidates: ${descendants.join(', ')}`,
      }
    })
}

async function renderChildren(
  git: IGit,
  repoPath: string,
  commit: string,
  source: SourceTreeSource,
  directory: TreeDirectory,
  validBundles: Set<string>,
  candidatePaths: Set<string>,
  diagnostics: SourceTreeDiagnostic[],
): Promise<SourceTreeNode[]> {
  const nodes: SourceTreeNode[] = await Promise.all(
    [...directory.children.values()]
      .sort((a, b) => comparePaths(a.path, b.path))
      .map(async (child): Promise<SourceTreeNode> => {
        if (validBundles.has(child.path)) {
          return renderBundle(git, repoPath, commit, source, child, diagnostics)
        }
        return {
          kind: 'container',
          name: basename(child.path),
          path: child.path,
          mode: child.mode,
          oid: child.oid,
          children: await renderChildren(
            git,
            repoPath,
            commit,
            source,
            child,
            validBundles,
            candidatePaths,
            diagnostics,
          ),
        } satisfies SourceTreeContainerNode
      }),
  )
  for (const entry of [...directory.entries].sort((a, b) => comparePaths(a.path, b.path))) {
    if (candidatePaths.has(directory.path) && basename(entry.path) === 'SKILL.md') {
      if (validBundles.has(directory.path)) continue
    }
    nodes.push(renderEntry(entry))
  }
  return nodes.sort((a, b) => comparePaths(a.path, b.path))
}

async function renderBundle(
  git: IGit,
  repoPath: string,
  commit: string,
  source: SourceTreeSource,
  directory: TreeDirectory,
  diagnostics: SourceTreeDiagnostic[],
): Promise<SourceTreeBundleNode> {
  const entry = childPath(directory.path, 'SKILL.md')
  const name = bundleName(directory, source)

  forEachEntry(directory, (item) => {
    if (item.mode === '120000') {
      diagnostics.push(bundleEntryDiagnostic('bundle-symlink', entry, item.path))
    } else if (item.type === 'commit' || item.mode === '160000') {
      diagnostics.push(bundleEntryDiagnostic('bundle-submodule', entry, item.path))
    }
  })

  let description = ''
  try {
    const content = await withMetadataReadSlot(() => git.show(repoPath, commit, entry))
    description = parseSkillMeta(content, name, directory.path)?.description ?? ''
  } catch (err) {
    sourceTreeLogger.error('failed to read source skill metadata', {
      err,
      url: source.url,
      path: entry,
    })
  }
  return {
    kind: 'bundle',
    name,
    path: directory.path,
    mode: directory.mode,
    oid: directory.oid,
    entry,
    ...(description ? { description } : {}),
  }
}

function validateBundleNames(
  directories: readonly TreeDirectory[],
  source: SourceTreeSource,
): void {
  const names = new Map<string, string>()
  for (const directory of directories) {
    const entry = childPath(directory.path, 'SKILL.md')
    const name = bundleName(directory, source)
    if (!SKILL_NAME.test(name))
      throw new Error(`Invalid source skill member name "${name}" at ${entry}`)
    const duplicate = names.get(name)
    if (duplicate) {
      throw new Error(`Duplicate source skill member name "${name}" from ${duplicate} and ${entry}`)
    }
    names.set(name, entry)
  }
}

function bundleName(directory: TreeDirectory, source: SourceTreeSource): string {
  return directory.path ? basename(directory.path) : source.name?.trim() || deriveRepoId(source.url)
}

async function withMetadataReadSlot<T>(read: () => Promise<T>): Promise<T> {
  if (activeMetadataReads >= METADATA_READ_CONCURRENCY) {
    await new Promise<void>((resolve) => metadataReadQueue.push(resolve))
  } else {
    activeMetadataReads++
  }
  try {
    return await read()
  } finally {
    const next = metadataReadQueue.shift()
    if (next) next()
    else activeMetadataReads--
  }
}

function renderEntry(entry: GitTreeEntry): SourceTreeNode {
  const base = { name: basename(entry.path), path: entry.path, mode: entry.mode, oid: entry.oid }
  if (entry.type === 'commit' || entry.mode === '160000') return { ...base, kind: 'submodule' }
  if (entry.mode === '120000') return { ...base, kind: 'symlink' }
  return { ...base, kind: 'resource' }
}

function bundleEntryDiagnostic(
  code: 'bundle-symlink' | 'bundle-submodule',
  bundleEntry: string,
  path: string,
): SourceTreeDiagnostic {
  return {
    code,
    path,
    relatedPaths: [bundleEntry],
    message: `${code === 'bundle-symlink' ? 'Symlink' : 'Submodule'} ${path} is inside skill bundle ${bundleEntry}`,
  }
}

function visitDirectories(
  directory: TreeDirectory,
  visit: (directory: TreeDirectory) => void,
): void {
  visit(directory)
  for (const child of directory.children.values()) visitDirectories(child, visit)
}

function forEachEntry(directory: TreeDirectory, visit: (entry: GitTreeEntry) => void): void {
  for (const entry of directory.entries) visit(entry)
  for (const child of directory.children.values()) forEachEntry(child, visit)
}

function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function dirnameOrRoot(path: string): string {
  const parent = dirname(path)
  return parent === '.' ? '' : parent
}

function isDescendant(path: string, ancestor: string): boolean {
  return ancestor ? path.startsWith(`${ancestor}/`) : Boolean(path)
}

function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, 'en')
}

function sortDiagnostics(diagnostics: SourceTreeDiagnostic[]): SourceTreeDiagnostic[] {
  return diagnostics.sort((a, b) => comparePaths(a.path, b.path) || a.code.localeCompare(b.code))
}
