import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path'
import type { AgentId, AgentPathSpec } from '@loom/core'
import type { AgentPathContext } from '../adapters/paths.js'
import { resolveAgentDefinition } from '../adapters/paths.js'
import type { FileSystemEntry, FileSystemEntryKind, IFileSystem } from '../ports/fs.js'

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001f]/
const MAX_SOURCE_ENTRIES = 10_000
const MAX_SOURCE_DEPTH = 64

export interface StableEntry {
  path: string
  canonicalPath: string
  kind: 'file' | 'directory'
  identity: string
  linkCount?: number
}

export interface SafeDirectoryChain {
  root: string
  target: string
  entries: StableEntry[]
}

export interface StableDirectoryTree {
  root: StableEntry
  entries: StableEntry[]
}

export interface StableRelativeFiles {
  root: StableEntry
  paths: string[]
  entries: StableEntry[]
  entriesByPath: ReadonlyMap<string, StableEntry>
}

export function assertSafePathSegment(value: string, description: string): void {
  if (
    !SAFE_SEGMENT.test(value) ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    WINDOWS_RESERVED.test(value)
  ) {
    throw new Error(`Invalid ${description}: ${value || '<empty>'}`)
  }
}

export function assertSafeRelativePath(
  value: string,
  description: string,
  options: { allowEmpty?: boolean } = {},
): void {
  if (
    (!value && !options.allowEmpty) ||
    isAbsolute(value) ||
    value.includes('\\') ||
    /^[A-Za-z]:\//.test(value) ||
    (value &&
      value
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.endsWith('.') ||
            part.endsWith(' ') ||
            WINDOWS_RESERVED.test(part) ||
            WINDOWS_INVALID.test(part),
        ))
  ) {
    throw new Error(`Invalid ${description}: ${value || '.'}`)
  }
}

export async function captureStableEntry(
  fs: IFileSystem,
  path: string,
  kind: StableEntry['kind'],
  description: string,
): Promise<StableEntry> {
  const before = await fs.inspectEntry(path)
  if (before?.kind !== kind) throw new Error(`${description} is not a real ${kind}: ${path}`)
  const canonicalPath = normalize(await fs.realPath(path))
  const after = await fs.inspectEntry(path)
  const confirmedCanonical = normalize(await fs.realPath(path))
  if (
    after?.kind !== kind ||
    after.identity !== before.identity ||
    (kind === 'file' && after.linkCount !== before.linkCount) ||
    confirmedCanonical !== canonicalPath
  ) {
    throw new Error(`${description} changed during validation: ${path}`)
  }
  return {
    path: normalize(path),
    canonicalPath,
    kind,
    identity: before.identity,
    ...(kind === 'file' ? { linkCount: before.linkCount } : {}),
  }
}

export async function revalidateStableEntry(
  fs: IFileSystem,
  expected: StableEntry,
  description: string,
): Promise<void> {
  const current = await captureStableEntry(fs, expected.path, expected.kind, description)
  if (
    current.identity !== expected.identity ||
    current.canonicalPath !== expected.canonicalPath ||
    current.linkCount !== expected.linkCount
  ) {
    throw new Error(`${description} identity changed: ${expected.path}`)
  }
}

export async function readStableFile(
  fs: IFileSystem,
  path: string,
  description: string,
): Promise<{ content: string; entry: StableEntry }> {
  const entry = await captureStableEntry(fs, path, 'file', description)
  const content = await fs.readFile(path)
  await revalidateStableEntry(fs, entry, description)
  return { content, entry }
}

export async function captureSafeDirectoryChain(
  fs: IFileSystem,
  root: string,
  target: string,
  description: string,
): Promise<SafeDirectoryChain> {
  const normalizedRoot = normalize(root)
  const normalizedTarget = normalize(target)
  if (!isAbsolute(normalizedRoot) || !isAbsolute(normalizedTarget)) {
    throw new Error(`${description} must use absolute paths`)
  }
  const targetRelative = relative(normalizedRoot, normalizedTarget)
  if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
    throw new Error(`${description} escaped its trusted root: ${normalizedTarget}`)
  }

  const paths = [normalizedRoot]
  let current = normalizedRoot
  for (const segment of targetRelative ? targetRelative.split(/[\\/]/) : []) {
    current = join(current, segment)
    paths.push(current)
  }

  const entries: StableEntry[] = []
  let canonicalRoot: string | null = null
  for (const path of paths) {
    const inspected = await fs.inspectEntry(path)
    if (!inspected) break
    if (inspected.kind !== 'directory') {
      throw new Error(`${description} ancestor is not a real directory: ${path}`)
    }
    const entry = await captureStableEntry(fs, path, 'directory', description)
    if (!canonicalRoot) canonicalRoot = entry.canonicalPath
    const rel = relative(normalizedRoot, path)
    const expectedCanonical = rel ? join(canonicalRoot, rel) : canonicalRoot
    if (entry.canonicalPath !== normalize(expectedCanonical)) {
      throw new Error(`${description} ancestor escaped its trusted root: ${path}`)
    }
    entries.push(entry)
  }
  return { root: normalizedRoot, target: normalizedTarget, entries }
}

export async function revalidateSafeDirectoryChain(
  fs: IFileSystem,
  expected: SafeDirectoryChain,
  description: string,
): Promise<void> {
  const current = await captureSafeDirectoryChain(fs, expected.root, expected.target, description)
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]))
  for (const entry of expected.entries) {
    const actual = currentByPath.get(entry.path)
    if (
      !actual ||
      actual.identity !== entry.identity ||
      actual.canonicalPath !== entry.canonicalPath
    ) {
      throw new Error(`${description} ancestor identity changed: ${entry.path}`)
    }
  }
}

export async function ensureSafeDirectoryChain(
  fs: IFileSystem,
  expected: SafeDirectoryChain,
  description: string,
): Promise<SafeDirectoryChain> {
  await revalidateSafeDirectoryChain(fs, expected, description)
  const root = await ensurePhysicalDirectory(fs, expected.root, description)
  const targetRelative = relative(expected.root, expected.target)
  let parent = root
  let currentPath = expected.root
  for (const segment of targetRelative ? targetRelative.split(/[\\/]/) : []) {
    currentPath = join(currentPath, segment)
    parent = await ensurePhysicalChild(fs, parent, currentPath, description)
  }
  await revalidateSafeDirectoryChain(fs, expected, description)
  return captureSafeDirectoryChain(fs, expected.root, expected.target, description)
}

async function ensurePhysicalDirectory(
  fs: IFileSystem,
  path: string,
  description: string,
): Promise<StableEntry> {
  const existing = await fs.inspectEntry(path)
  if (existing) return captureStableEntry(fs, path, 'directory', description)
  const parentPath = dirname(path)
  if (parentPath === path) throw new Error(`${description} root is unavailable: ${path}`)
  const parent = await ensurePhysicalDirectory(fs, parentPath, description)
  return ensurePhysicalChild(fs, parent, path, description)
}

async function ensurePhysicalChild(
  fs: IFileSystem,
  parent: StableEntry,
  path: string,
  description: string,
): Promise<StableEntry> {
  await revalidateStableEntry(fs, parent, description)
  const existing = await fs.inspectEntry(path)
  if (!existing) {
    let creationError: unknown
    try {
      await fs.mkdir(path, false)
    } catch (error) {
      creationError = error
    }
    if (!(await fs.inspectEntry(path)) && creationError) throw creationError
  }
  const child = await captureStableEntry(fs, path, 'directory', description)
  const expectedCanonical = normalize(join(parent.canonicalPath, basename(path)))
  if (child.canonicalPath !== expectedCanonical) {
    throw new Error(`${description} ancestor escaped its trusted root: ${path}`)
  }
  await revalidateStableEntry(fs, parent, description)
  return child
}

export async function captureAgentDirectoryChain(
  fs: IFileSystem,
  agent: AgentId,
  capability: 'skills' | 'mcp' | 'memory',
  targetDirectory: string,
  context: AgentPathContext,
): Promise<SafeDirectoryChain> {
  const root = agentTrustRoot(agent, capability, context)
  return captureSafeDirectoryChain(fs, root, targetDirectory, `${agent} ${capability} destination`)
}

export async function captureRepoCacheRoot(
  fs: IFileSystem,
  repoPath: string,
  cacheId: string,
): Promise<StableEntry | null> {
  assertSafePathSegment(cacheId, 'source cache id')
  const repo = await captureStableEntry(fs, repoPath, 'directory', 'repository root')
  const cacheParentPath = join(repo.canonicalPath, 'remote-cache')
  const cacheParentEntry = await fs.inspectEntry(cacheParentPath)
  if (!cacheParentEntry) {
    await revalidateStableEntry(fs, repo, 'repository root')
    return null
  }
  const cacheParent = await captureStableEntry(
    fs,
    cacheParentPath,
    'directory',
    'remote cache root',
  )
  if (
    cacheParent.canonicalPath !== normalize(cacheParentPath) ||
    normalize(dirname(cacheParent.canonicalPath)) !== repo.canonicalPath
  ) {
    throw new Error(`Remote cache root escaped the repository: ${cacheParentPath}`)
  }

  const cachePath = join(cacheParent.canonicalPath, cacheId)
  const cacheEntry = await fs.inspectEntry(cachePath)
  if (!cacheEntry) {
    await revalidateStableEntry(fs, repo, 'repository root')
    await revalidateStableEntry(fs, cacheParent, 'remote cache root')
    return null
  }
  const cache = await captureStableEntry(fs, cachePath, 'directory', 'source cache')
  if (
    cache.canonicalPath !== normalize(cachePath) ||
    normalize(dirname(cache.canonicalPath)) !== cacheParent.canonicalPath
  ) {
    throw new Error(`Source cache is not a real direct child: ${cachePath}`)
  }
  await revalidateStableEntry(fs, repo, 'repository root')
  await revalidateStableEntry(fs, cacheParent, 'remote cache root')
  return cache
}

export async function captureSafeDirectoryTree(
  fs: IFileSystem,
  root: StableEntry,
  description: string,
): Promise<StableDirectoryTree> {
  await revalidateStableEntry(fs, root, description)
  const entries: StableEntry[] = []
  let count = 0

  const visit = async (directory: StableEntry, depth: number): Promise<void> => {
    if (depth > MAX_SOURCE_DEPTH) throw new Error(`${description} exceeds maximum depth`)
    const names = (await fs.readDir(directory.path)).sort()
    for (const name of names) {
      if (name.includes('/') || name.includes('\\') || !name) {
        throw new Error(`${description} contains an invalid entry name`)
      }
      count++
      if (count > MAX_SOURCE_ENTRIES) throw new Error(`${description} exceeds maximum entries`)
      const path = join(directory.path, name)
      const inspected = await fs.inspectEntry(path)
      if (inspected?.kind !== 'file' && inspected?.kind !== 'directory') {
        throw new Error(`${description} contains a link or special entry: ${path}`)
      }
      const entry = await captureStableEntry(fs, path, inspected.kind, description)
      if (entry.kind === 'file' && entry.linkCount !== 1) {
        throw new Error(`${description} contains a hardlinked file: ${path}`)
      }
      const rel = relative(root.canonicalPath, entry.canonicalPath)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`${description} entry escaped its root: ${path}`)
      }
      entries.push(entry)
      if (entry.kind === 'directory') await visit(entry, depth + 1)
    }
    const confirmedNames = (await fs.readDir(directory.path)).sort()
    if (
      confirmedNames.length !== names.length ||
      confirmedNames.some((name, index) => name !== names[index])
    ) {
      throw new Error(`${description} changed during validation: ${directory.path}`)
    }
    await revalidateStableEntry(fs, directory, description)
  }

  await visit(root, 0)
  return { root, entries }
}

export async function revalidateSafeDirectoryTree(
  fs: IFileSystem,
  tree: StableDirectoryTree,
  description: string,
): Promise<void> {
  const current = await captureSafeDirectoryTree(fs, tree.root, description)
  assertSameEntries(tree.entries, current.entries, description)
}

export async function captureStableRelativeFiles(
  fs: IFileSystem,
  root: StableEntry,
  paths: readonly string[],
  description: string,
): Promise<StableRelativeFiles> {
  await revalidateStableEntry(fs, root, description)
  if (paths.length > MAX_SOURCE_ENTRIES) {
    throw new Error(`${description} exceeds maximum entries`)
  }
  const entriesByPath = new Map<string, StableEntry>()
  const normalizedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right, 'en'))

  for (const relativePath of normalizedPaths) {
    assertSafeRelativePath(relativePath, `${description} path`)
    const segments = relativePath.split('/')
    if (segments.length > MAX_SOURCE_DEPTH) {
      throw new Error(`${description} exceeds maximum depth`)
    }
    let currentPath = root.path
    for (const [index, segment] of segments.entries()) {
      currentPath = join(currentPath, segment)
      const kind = index === segments.length - 1 ? 'file' : 'directory'
      const entry = await captureStableEntry(fs, currentPath, kind, description)
      if (entry.kind === 'file' && entry.linkCount !== 1) {
        throw new Error(`${description} contains a hardlinked file: ${currentPath}`)
      }
      const expectedCanonical = normalize(join(root.canonicalPath, ...segments.slice(0, index + 1)))
      if (entry.canonicalPath !== expectedCanonical) {
        throw new Error(`${description} entry escaped its root: ${currentPath}`)
      }
      const existing = entriesByPath.get(entry.path)
      if (
        existing &&
        (existing.kind !== entry.kind ||
          existing.identity !== entry.identity ||
          existing.canonicalPath !== entry.canonicalPath)
      ) {
        throw new Error(`${description} entry changed during validation: ${currentPath}`)
      }
      if (!existing && entriesByPath.size >= MAX_SOURCE_ENTRIES) {
        throw new Error(`${description} exceeds maximum entries`)
      }
      entriesByPath.set(entry.path, entry)
    }
  }
  await revalidateStableEntry(fs, root, description)
  return { root, paths: normalizedPaths, entries: [...entriesByPath.values()], entriesByPath }
}

export async function revalidateStableRelativeFiles(
  fs: IFileSystem,
  expected: StableRelativeFiles,
  description: string,
): Promise<void> {
  const current = await captureStableRelativeFiles(fs, expected.root, expected.paths, description)
  assertSameEntries(expected.entries, current.entries, description)
}

export async function revalidateStableRelativeFile(
  fs: IFileSystem,
  expected: StableRelativeFiles,
  relativePath: string,
  description: string,
): Promise<void> {
  assertSafeRelativePath(relativePath, `${description} path`)
  const segments = relativePath.split('/')
  if (segments.length > MAX_SOURCE_DEPTH) {
    throw new Error(`${description} exceeds maximum depth`)
  }

  await revalidateStableEntry(fs, expected.root, description)
  let currentPath = expected.root.path
  for (const [index, segment] of segments.entries()) {
    currentPath = normalize(join(currentPath, segment))
    const entry = expected.entriesByPath.get(currentPath)
    const kind = index === segments.length - 1 ? 'file' : 'directory'
    if (!entry || entry.kind !== kind) {
      throw new Error(`${description} file was not authorized: ${relativePath}`)
    }
    await revalidateStableEntry(fs, entry, description)
  }
  await revalidateStableEntry(fs, expected.root, description)
}

export async function atomicReplaceTextFile(
  fs: IFileSystem,
  targetPath: string,
  content: string,
  expectedTargetIdentity: string | null,
): Promise<FileSystemEntry> {
  const tempPath = join(
    dirname(targetPath),
    `.${targetPath.split(/[\\/]/).pop() ?? 'projection'}.loom-write-${process.pid}-${crypto.randomUUID()}`,
  )
  try {
    const temporary = await fs.writeFileExclusive(tempPath, content)
    return await fs.replaceFileIfIdentity(tempPath, targetPath, expectedTargetIdentity)
  } catch (error) {
    const temporary = await fs.inspectEntry(tempPath)
    try {
      if (temporary) await fs.removeEntryIfIdentity(tempPath, temporary.identity)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'atomic projection write and cleanup failed',
        {
          cause: error,
        },
      )
    }
    throw error
  }
}

function agentTrustRoot(
  agent: AgentId,
  capability: 'skills' | 'mcp' | 'memory',
  context: AgentPathContext,
): string {
  if (!isAbsolute(context.home)) throw new Error('Projection home must be absolute')
  const definition = resolveAgentDefinition(agent, context)
  const path = (definition[capability] as { path: AgentPathSpec } | undefined)?.path
  if (!path) throw new Error(`Agent ${agent} does not support ${capability}`)
  if (path.root === 'home') return normalize(context.home)
  if (path.root === 'xdg-config') return xdgTrustRoot(context)

  const overrideName = definition.configDir.overrideEnv
  const override = overrideName ? context.env[overrideName] : undefined
  if (override) {
    if (!isAbsolute(override)) throw new Error(`${overrideName} must be an absolute path`)
    return normalize(override)
  }
  return definition.configDir.fallback.root === 'home'
    ? normalize(context.home)
    : xdgTrustRoot(context)
}

function xdgTrustRoot(context: AgentPathContext): string {
  const explicit = context.env.XDG_CONFIG_HOME
  if (!explicit) return normalize(context.home)
  if (!isAbsolute(explicit)) throw new Error('XDG_CONFIG_HOME must be an absolute path')
  return normalize(explicit)
}

export function isSupportedStableKind(kind: FileSystemEntryKind): kind is StableEntry['kind'] {
  return kind === 'file' || kind === 'directory'
}

function assertSameEntries(
  expected: readonly StableEntry[],
  current: readonly StableEntry[],
  description: string,
): void {
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]))
  if (currentByPath.size !== expected.length) {
    throw new Error(`${description} tree identity changed`)
  }
  for (const entry of expected) {
    const actual = currentByPath.get(entry.path)
    if (
      !actual ||
      actual.kind !== entry.kind ||
      actual.identity !== entry.identity ||
      actual.linkCount !== entry.linkCount ||
      actual.canonicalPath !== entry.canonicalPath
    ) {
      throw new Error(`${description} entry identity changed: ${entry.path}`)
    }
  }
}
