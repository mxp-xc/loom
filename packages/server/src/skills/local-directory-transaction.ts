import { randomUUID } from 'node:crypto'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { deriveRepoId, type SkillSource } from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import type { LoggerPort } from '../ports/logger.js'
import {
  LocalSkillBoundaryError,
  type OwnedBuiltInLocalSkillRoot,
  type PreparedBuiltInLocalSkill,
  type ResolvedLocalSkill,
  type StableLocalDirectory,
} from './local-paths.js'

const MAX_SNAPSHOT_ENTRIES = 10_000
const MAX_SNAPSHOT_DEPTH = 64
const PINNED_COMMIT_REGEX = /^[0-9a-f]{7,64}$/
const REGULAR_BLOB_MODES = new Set(['100644', '100755'])

export interface LocalArchiveFile {
  path: string
  content: string | Uint8Array
  mode?: '100644' | '100755'
}

export interface LocalDirectorySnapshot {
  root: StableLocalDirectory
  directories: Array<{ path: string; relativePath: string; identity: string }>
  files: Array<{ path: string; relativePath: string; identity: string }>
}

interface PendingInstall {
  destination: PreparedBuiltInLocalSkill
  candidate: LocalDirectorySnapshot
}

interface InstalledDirectory {
  destination: PreparedBuiltInLocalSkill
  identity: string
}

interface MovedDirectory {
  original: string
  staged: string
  identity: string
}

interface LocalTransactionBuckets {
  candidates: StableLocalDirectory
  moved: StableLocalDirectory
  removed: StableLocalDirectory
}

export function normalizeLocalArchiveFiles(
  files: ReadonlyArray<{ path: unknown; content: unknown; mode?: unknown }>,
): LocalArchiveFile[] {
  const root = archiveTrieNode()
  const normalized: LocalArchiveFile[] = []
  for (const file of files) {
    const path = normalizeArchivePath(file.path)
    insertArchivePath(root, path)
    normalized.push({
      path,
      content: file.content instanceof Uint8Array ? file.content : String(file.content ?? ''),
      mode: file.mode === '100755' ? '100755' : '100644',
    })
  }
  if (!normalized.some((file) => file.path === 'SKILL.md')) {
    throw boundary(400, 'invalid_skill_files', 'Local skill archive must contain SKILL.md')
  }
  return normalized.sort(compareInstallPath)
}

export async function inspectLocalDirectorySnapshot(
  fs: IFileSystem,
  source: StableLocalDirectory,
): Promise<LocalDirectorySnapshot> {
  const directories: LocalDirectorySnapshot['directories'] = []
  const files: LocalDirectorySnapshot['files'] = []
  let entries = 0

  const walk = async (directory: StableLocalDirectory, relativePath: string, depth: number) => {
    if (depth > MAX_SNAPSHOT_DEPTH) {
      throw boundary(422, 'local_skill_tree_too_deep', 'Local skill directory is too deep')
    }
    await assertStableDirectory(fs, directory, 'revalidate local skill snapshot directory')
    const names = await readDirectory(fs, directory.path)
    const foldedNames = new Set<string>()
    for (const name of names.sort((left, right) => left.localeCompare(right, 'en'))) {
      if (!isSafeEntryName(name)) {
        throw boundary(422, 'invalid_local_skill_tree', 'Local skill contains an invalid entry')
      }
      const folded = name.toLocaleLowerCase('en-US')
      if (foldedNames.has(folded)) {
        throw boundary(409, 'local_skill_case_collision', 'Local skill contains a case collision')
      }
      foldedNames.add(folded)
      entries += 1
      if (entries > MAX_SNAPSHOT_ENTRIES) {
        throw boundary(
          422,
          'local_skill_tree_too_large',
          'Local skill directory has too many entries',
        )
      }
      const path = join(directory.path, name)
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name
      const entry = await inspectEntry(fs, path, 'inspect local skill snapshot entry')
      if (!entry)
        throw boundary(409, 'local_skill_identity_changed', 'Local skill changed during validation')
      if (entry.kind === 'directory') {
        directories.push({ path, relativePath: childRelativePath, identity: entry.identity })
        await walk({ path, identity: entry.identity }, childRelativePath, depth + 1)
      } else if (entry.kind === 'file' && entry.linkCount === 1) {
        files.push({ path, relativePath: childRelativePath, identity: entry.identity })
      } else {
        throw boundary(
          422,
          entry.kind === 'file' ? 'local_skill_hardlink_rejected' : 'invalid_local_skill_tree',
          'Local skill may contain only real, single-link regular files and directories',
        )
      }
    }
    await assertStableDirectory(fs, directory, 'revalidate local skill snapshot directory')
  }

  await walk(source, '', 0)
  if (!files.some((file) => file.relativePath === 'SKILL.md')) {
    throw boundary(422, 'local_skill_unavailable', 'Local skill must contain a regular SKILL.md')
  }
  return { root: source, directories, files: files.sort(compareInstallPath) }
}

export async function readPinnedLocalArchive(
  fs: IFileSystem,
  git: IGit,
  repository: StableLocalDirectory,
  source: SkillSource,
  memberEntry: string,
): Promise<LocalArchiveFile[]> {
  const commit = source.pinned_commit?.trim() ?? ''
  if (!PINNED_COMMIT_REGEX.test(commit)) {
    throw boundary(422, 'source_commit_unavailable', 'Source pinned commit is unavailable')
  }
  const normalizedEntry = normalizeGitPath(memberEntry)
  if (!normalizedEntry.endsWith('/SKILL.md') && normalizedEntry !== 'SKILL.md') {
    throw boundary(422, 'invalid_member_entry', 'Source member entry is invalid')
  }
  const cacheRoot = await requireStableDirectory(
    fs,
    join(repository.path, 'remote-cache'),
    'resolve remote source cache root',
  )
  const cache = await requireStableDirectory(
    fs,
    join(cacheRoot.path, deriveRepoId(source.url)),
    'resolve remote source cache',
  )
  if (normalize(dirname(cache.path)) !== cacheRoot.path) {
    throw boundary(422, 'invalid_source_cache', 'Remote source cache escaped its owned root')
  }
  const entries = await git.readTree(cache.path, commit)
  const skillEntry = entries.find((entry) => entry.path === normalizedEntry)
  if (!skillEntry || skillEntry.type !== 'blob' || !REGULAR_BLOB_MODES.has(skillEntry.mode)) {
    throw boundary(422, 'source_skill_unavailable', 'Pinned source skill is unavailable')
  }
  const bundleDirectory = dirname(normalizedEntry).replace(/\\/g, '/')
  const prefix = bundleDirectory === '.' ? '' : `${bundleDirectory}/`
  const selected = entries.filter((entry) => !prefix || entry.path.startsWith(prefix))
  const files: LocalArchiveFile[] = []
  for (const entry of selected) {
    if (entry.type === 'tree') continue
    if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
      throw boundary(
        422,
        'invalid_source_skill_tree',
        'Pinned source skill contains a link, submodule, or special entry',
      )
    }
    const path = prefix ? entry.path.slice(prefix.length) : entry.path
    files.push({
      path,
      content: git.showBytes
        ? await git.showBytes(cache.path, commit, entry.path)
        : await git.show(cache.path, commit, entry.path),
      mode: entry.mode as '100644' | '100755',
    })
  }
  await assertStableDirectory(fs, cacheRoot, 'revalidate remote source cache root')
  await assertStableDirectory(fs, cache, 'revalidate remote source cache')
  return normalizeLocalArchiveFiles(files)
}

export class LocalDirectoryTransaction {
  private readonly pendingInstalls: PendingInstall[] = []
  private readonly installed: InstalledDirectory[] = []
  private readonly moved: MovedDirectory[] = []
  private rollbackBucket?: StableLocalDirectory
  private closed = false

  private constructor(
    private readonly fs: IFileSystem,
    private readonly root: OwnedBuiltInLocalSkillRoot,
    private readonly staging: StableLocalDirectory,
    private readonly buckets: LocalTransactionBuckets,
    private readonly log: LoggerPort,
  ) {}

  static async open(
    fs: IFileSystem,
    root: OwnedBuiltInLocalSkillRoot,
    log: LoggerPort,
  ): Promise<LocalDirectoryTransaction> {
    return this.openAt(fs, root, root.directory, `.loom-transaction-${randomUUID()}`, log)
  }

  static async openAt(
    fs: IFileSystem,
    root: OwnedBuiltInLocalSkillRoot,
    stagingParent: StableLocalDirectory,
    stagingName: string,
    log: LoggerPort,
  ): Promise<LocalDirectoryTransaction> {
    if (!/^[a-z0-9._-]+$/i.test(stagingName) || stagingName === '.' || stagingName === '..') {
      throw boundary(422, 'invalid_local_skill_staging', 'Local skill staging name is invalid')
    }
    await assertStableDirectory(fs, root.directory, 'revalidate built-in local skill root')
    await assertStableDirectory(fs, stagingParent, 'revalidate local skill staging parent')
    const path = join(stagingParent.path, stagingName)
    try {
      await fs.mkdir(path, false)
    } catch (err) {
      throw ioFailure('create local skill transaction staging', err, path)
    }
    let entry: Awaited<ReturnType<IFileSystem['inspectEntry']>> = null
    try {
      entry = await inspectEntry(fs, path, 'inspect local skill transaction staging')
      if (!entry || entry.kind !== 'directory') {
        throw boundary(500, 'local_skill_staging_failed', 'Local skill staging is unavailable')
      }
      const canonical = normalize(
        await realPath(fs, path, 'resolve local skill transaction staging'),
      )
      if (canonical !== path || normalize(dirname(canonical)) !== stagingParent.path) {
        throw boundary(
          422,
          'invalid_local_skill_staging',
          'Local skill staging escaped its owned root',
        )
      }
      await assertStableDirectory(fs, root.directory, 'revalidate built-in local skill root')
      await assertStableDirectory(fs, stagingParent, 'revalidate local skill staging parent')
      const staging = { path: canonical, identity: entry.identity }
      const buckets = {
        candidates: await createOwnedChildDirectory(fs, staging, 'candidates'),
        moved: await createOwnedChildDirectory(fs, staging, 'moved'),
        removed: await createOwnedChildDirectory(fs, staging, 'removed'),
      }
      return new LocalDirectoryTransaction(fs, root, staging, buckets, log)
    } catch (primary) {
      const failures: unknown[] = []
      if (entry?.kind === 'directory') {
        try {
          await fs.removeEntryIfIdentity(path, entry.identity)
        } catch (rollbackError) {
          failures.push(rollbackError)
          log.error('failed to clean invalid local skill staging', { err: rollbackError, path })
        }
      }
      throw combineLocalTransactionFailure(primary, failures)
    }
  }

  async stageArchive(
    destination: PreparedBuiltInLocalSkill,
    files: ReadonlyArray<LocalArchiveFile>,
  ): Promise<LocalDirectorySnapshot> {
    this.assertDestination(destination)
    const candidate = await this.createCandidate(destination.id)
    const directories = await createOwnedRelativeDirectories(
      this.fs,
      candidate,
      files.map((file) => dirname(file.path)).filter((path) => path !== '.'),
    )
    for (const file of [...files].sort(compareInstallPath)) {
      const parentPath = dirname(file.path).replace(/\\\\/g, '/')
      const parent = parentPath === '.' ? candidate : directories.get(parentPath)
      if (!parent)
        throw boundary(500, 'local_skill_staging_failed', 'Archive parent is unavailable')
      await assertStableDirectory(this.fs, parent, 'revalidate archive staging directory')
      const target = join(candidate.path, file.path)
      const mode = file.mode === '100755' ? 0o755 : 0o644
      if (file.content instanceof Uint8Array) {
        if (!this.fs.writeFileBytesExclusive) {
          throw boundary(500, 'local_skill_staging_failed', 'Binary archive writes are unavailable')
        }
        await this.fs.writeFileBytesExclusive(target, file.content, mode)
      } else {
        await this.fs.writeFileExclusive(target, file.content, mode)
      }
      await assertStableDirectory(this.fs, parent, 'revalidate archive staging directory')
    }
    const snapshot = await inspectLocalDirectorySnapshot(
      this.fs,
      await requireStableDirectory(this.fs, candidate.path, 'inspect staged local skill candidate'),
    )
    this.pendingInstalls.push({ destination, candidate: snapshot })
    return snapshot
  }

  async stageCopiedDirectory(
    destination: PreparedBuiltInLocalSkill,
    snapshot: LocalDirectorySnapshot,
  ): Promise<void> {
    this.assertDestination(destination)
    await revalidateSnapshot(this.fs, snapshot)
    const candidate = await this.createCandidate(destination.id)
    const directories = await createOwnedRelativeDirectories(
      this.fs,
      candidate,
      snapshot.directories.map((directory) => directory.relativePath),
    )
    for (const file of [...snapshot.files].sort(compareInstallPath)) {
      const parentPath = dirname(file.relativePath).replace(/\\\\/g, '/')
      const parent = parentPath === '.' ? candidate : directories.get(parentPath)
      if (!parent) throw boundary(500, 'local_skill_staging_failed', 'Copy parent is unavailable')
      await assertStableDirectory(this.fs, parent, 'revalidate copied staging directory')
      await this.fs.copyFileNoFollow(
        file.path,
        join(candidate.path, file.relativePath),
        file.identity,
      )
      await assertStableDirectory(this.fs, parent, 'revalidate copied staging directory')
    }
    await revalidateSnapshot(this.fs, snapshot)
    const candidateSnapshot = await inspectLocalDirectorySnapshot(
      this.fs,
      await requireStableDirectory(this.fs, candidate.path, 'inspect copied local skill candidate'),
    )
    this.pendingInstalls.push({ destination, candidate: candidateSnapshot })
  }

  async stageMovedDirectory(
    destination: PreparedBuiltInLocalSkill,
    snapshot: LocalDirectorySnapshot,
  ): Promise<void> {
    this.assertDestination(destination)
    if (containsPath(snapshot.root.path, this.root.directory.path)) {
      throw boundary(422, 'invalid_local_skill_source', 'Local skill source owns the built-in root')
    }
    await revalidateSnapshot(this.fs, snapshot)
    await assertStableDirectory(this.fs, this.buckets.moved, 'revalidate moved staging bucket')
    const staged = join(this.buckets.moved.path, destination.id)
    const moved = await this.fs.moveNoReplace(snapshot.root.path, staged, snapshot.root.identity)
    this.moved.push({ original: snapshot.root.path, staged, identity: moved.identity })
    const movedRoot = { path: staged, identity: moved.identity }
    await assertStableDirectory(this.fs, movedRoot, 'inspect moved local skill source')
    await assertStableDirectory(this.fs, this.buckets.moved, 'revalidate moved staging bucket')
    await this.stageCopiedDirectory(
      destination,
      await inspectLocalDirectorySnapshot(this.fs, movedRoot),
    )
  }

  async stageRemoval(skill: ResolvedLocalSkill): Promise<void> {
    if (
      !skill.available ||
      !skill.builtInRoot ||
      !skill.directoryIdentity ||
      skill.builtInRoot.directory.identity !== this.root.directory.identity
    ) {
      throw boundary(
        422,
        'invalid_local_skill_path',
        'Built-in local skill ownership is unavailable',
      )
    }
    await assertStableDirectory(
      this.fs,
      { path: skill.directory, identity: skill.directoryIdentity },
      'revalidate built-in local skill removal',
    )
    await assertStableDirectory(this.fs, this.buckets.removed, 'revalidate removed staging bucket')
    const staged = join(this.buckets.removed.path, skill.id)
    const moved = await this.fs.moveNoReplace(skill.directory, staged, skill.directoryIdentity)
    this.moved.push({ original: skill.directory, staged, identity: moved.identity })
    await assertStableDirectory(
      this.fs,
      { path: staged, identity: moved.identity },
      'inspect staged local skill removal',
    )
    await assertStableDirectory(this.fs, this.buckets.removed, 'revalidate removed staging bucket')
  }

  async apply(): Promise<void> {
    this.assertOpen()
    for (const pending of this.pendingInstalls) {
      await assertStableDirectory(
        this.fs,
        this.root.directory,
        'revalidate built-in local skill root',
      )
      await revalidateSnapshot(this.fs, pending.candidate)
      const installed = await this.fs.moveNoReplace(
        pending.candidate.root.path,
        pending.destination.directory,
        pending.candidate.root.identity,
      )
      this.installed.push({ destination: pending.destination, identity: installed.identity })
      await assertStableDirectory(
        this.fs,
        { path: pending.destination.directory, identity: installed.identity },
        'inspect installed local skill',
      )
      await assertStableDirectory(
        this.fs,
        this.root.directory,
        'revalidate built-in local skill root',
      )
    }
  }

  async complete(): Promise<void> {
    this.assertOpen()
    await this.removeOwnedStaging()
    this.closed = true
  }

  async rollback(): Promise<unknown[]> {
    if (this.closed) return []
    const failures: unknown[] = []
    for (const installed of [...this.installed].reverse()) {
      try {
        const rollbackBucket = await this.ensureRollbackBucket()
        const quarantine = join(rollbackBucket.path, installed.destination.id)
        await assertStableDirectory(
          this.fs,
          { path: installed.destination.directory, identity: installed.identity },
          'revalidate installed local skill rollback',
        )
        await this.fs.moveNoReplace(installed.destination.directory, quarantine, installed.identity)
        await assertStableDirectory(this.fs, rollbackBucket, 'revalidate rollback staging bucket')
      } catch (err) {
        failures.push(err)
        this.log.error('failed to roll back installed local skill', {
          err,
          path: installed.destination.directory,
        })
      }
    }
    for (const moved of [...this.moved].reverse()) {
      try {
        await assertStableDirectory(
          this.fs,
          { path: moved.staged, identity: moved.identity },
          'revalidate staged local skill rollback',
        )
        if (
          await inspectEntry(this.fs, moved.original, 'inspect local skill rollback destination')
        ) {
          throw boundary(
            409,
            'local_skill_rollback_collision',
            'Local skill rollback destination exists',
          )
        }
        await this.fs.moveNoReplace(moved.staged, moved.original, moved.identity)
      } catch (err) {
        failures.push(err)
        this.log.error('failed to restore staged local skill', {
          err,
          from: moved.staged,
          to: moved.original,
        })
      }
    }
    if (failures.length === 0) {
      try {
        await this.removeOwnedStaging()
        this.closed = true
      } catch (err) {
        failures.push(err)
        this.log.error('failed to clean local skill transaction staging', {
          err,
          path: this.staging.path,
        })
      }
    }
    return failures
  }

  private async createCandidate(id: string): Promise<StableLocalDirectory> {
    this.assertOpen()
    return createOwnedChildDirectory(this.fs, this.buckets.candidates, id)
  }

  private async ensureRollbackBucket(): Promise<StableLocalDirectory> {
    if (this.rollbackBucket) {
      await assertStableDirectory(
        this.fs,
        this.rollbackBucket,
        'revalidate rollback staging bucket',
      )
      return this.rollbackBucket
    }
    this.rollbackBucket = await createOwnedChildDirectory(this.fs, this.staging, 'rollback')
    return this.rollbackBucket
  }

  private assertDestination(destination: PreparedBuiltInLocalSkill): void {
    this.assertOpen()
    if (
      destination.root.directory.path !== this.root.directory.path ||
      destination.root.directory.identity !== this.root.directory.identity ||
      normalize(dirname(destination.directory)) !== this.root.directory.path
    ) {
      throw boundary(422, 'invalid_local_skill_destination', 'Local skill destination is not owned')
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Local directory transaction is closed')
  }

  private async removeOwnedStaging(): Promise<void> {
    await assertStableDirectory(this.fs, this.staging, 'revalidate local skill transaction staging')
    await this.fs.removeEntryIfIdentity(this.staging.path, this.staging.identity)
  }
}

export function combineLocalTransactionFailure(
  primary: unknown,
  rollbackFailures: unknown[],
): unknown {
  if (rollbackFailures.length === 0) return primary
  return new AggregateError(
    [primary, ...rollbackFailures],
    'local skill mutation and rollback failed',
    { cause: primary },
  )
}

async function createOwnedChildDirectory(
  fs: IFileSystem,
  parent: StableLocalDirectory,
  name: string,
): Promise<StableLocalDirectory> {
  await assertStableDirectory(fs, parent, 'revalidate local skill transaction directory')
  const path = join(parent.path, name)
  await fs.mkdir(path, false)
  const entry = await inspectEntry(fs, path, 'inspect local skill transaction directory')
  if (!entry || entry.kind !== 'directory') {
    throw boundary(500, 'local_skill_staging_failed', 'Local skill staging is unavailable')
  }
  const canonical = normalize(await realPath(fs, path, 'resolve local skill transaction directory'))
  if (canonical !== path || normalize(dirname(canonical)) !== parent.path) {
    throw boundary(422, 'invalid_local_skill_staging', 'Local skill staging escaped its owned root')
  }
  await assertStableDirectory(fs, parent, 'revalidate local skill transaction directory')
  return { path: canonical, identity: entry.identity }
}

async function createOwnedRelativeDirectories(
  fs: IFileSystem,
  root: StableLocalDirectory,
  paths: ReadonlyArray<string>,
): Promise<Map<string, StableLocalDirectory>> {
  const relativePaths = new Set<string>()
  for (const path of paths) {
    const segments = path.replace(/\\\\/g, '/').split('/')
    for (let index = 1; index <= segments.length; index++) {
      const relativePath = segments.slice(0, index).join('/')
      if (!relativePath || segments.slice(0, index).some((segment) => !isSafeEntryName(segment))) {
        throw boundary(422, 'invalid_local_skill_tree', 'Local skill contains an invalid entry')
      }
      relativePaths.add(relativePath)
    }
  }

  const directories = new Map<string, StableLocalDirectory>()
  for (const relativePath of [...relativePaths].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length
    return depth || left.localeCompare(right, 'en')
  })) {
    const segments = relativePath.split('/')
    const name = segments.pop()!
    const parentPath = segments.join('/')
    const parent = parentPath ? directories.get(parentPath) : root
    if (!parent) {
      throw boundary(500, 'local_skill_staging_failed', 'Local skill staging parent is unavailable')
    }
    directories.set(relativePath, await createOwnedChildDirectory(fs, parent, name))
  }
  return directories
}

async function revalidateSnapshot(
  fs: IFileSystem,
  snapshot: LocalDirectorySnapshot,
): Promise<void> {
  await assertStableDirectory(fs, snapshot.root, 'revalidate local skill snapshot root')
  for (const directory of snapshot.directories) {
    await assertStableDirectory(
      fs,
      { path: directory.path, identity: directory.identity },
      'revalidate local skill snapshot directory',
    )
  }
  for (const file of snapshot.files) {
    const entry = await inspectEntry(fs, file.path, 'revalidate local skill snapshot file')
    if (
      !entry ||
      entry.kind !== 'file' ||
      entry.identity !== file.identity ||
      entry.linkCount !== 1
    ) {
      throw boundary(409, 'local_skill_identity_changed', 'Local skill changed during validation')
    }
  }
}

async function assertStableDirectory(
  fs: IFileSystem,
  directory: StableLocalDirectory,
  operation: string,
): Promise<void> {
  const entry = await inspectEntry(fs, directory.path, operation)
  if (!entry || entry.kind !== 'directory' || entry.identity !== directory.identity) {
    throw boundary(409, 'local_skill_identity_changed', 'Local skill directory identity changed')
  }
  const canonical = normalize(await realPath(fs, directory.path, operation))
  if (canonical !== directory.path) {
    throw boundary(422, 'invalid_local_skill_path', 'Local skill directory is not canonical')
  }
}

async function requireStableDirectory(
  fs: IFileSystem,
  path: string,
  operation: string,
): Promise<StableLocalDirectory> {
  const entry = await inspectEntry(fs, path, operation)
  if (!entry || entry.kind !== 'directory') {
    throw boundary(422, 'invalid_local_skill_path', 'Expected a real local skill directory')
  }
  const directory = {
    path: normalize(await realPath(fs, path, operation)),
    identity: entry.identity,
  }
  if (directory.path !== normalize(path)) {
    throw boundary(422, 'invalid_local_skill_path', 'Local skill directory escaped its path')
  }
  await assertStableDirectory(fs, directory, operation)
  return directory
}

async function inspectEntry(fs: IFileSystem, path: string, operation: string) {
  try {
    return await fs.inspectEntry(path)
  } catch (err) {
    throw ioFailure(operation, err, path)
  }
}

async function readDirectory(fs: IFileSystem, path: string): Promise<string[]> {
  try {
    return await fs.readDir(path)
  } catch (err) {
    throw ioFailure('read local skill directory', err, path)
  }
}

async function realPath(fs: IFileSystem, path: string, operation: string): Promise<string> {
  try {
    return await fs.realPath(path)
  } catch (err) {
    throw ioFailure(operation, err, path)
  }
}

function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..')
}

function isSafeEntryName(name: string): boolean {
  return (
    Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  )
}

interface ArchiveTrieNode {
  originalSegment?: string
  file: boolean
  children: Map<string, ArchiveTrieNode>
}

function archiveTrieNode(originalSegment?: string): ArchiveTrieNode {
  return { originalSegment, file: false, children: new Map() }
}

function insertArchivePath(root: ArchiveTrieNode, path: string): void {
  let node = root
  for (const segment of path.split('/')) {
    if (node.file) throw archiveCollision(path)
    const folded = segment.toLocaleLowerCase('en-US')
    const existing = node.children.get(folded)
    if (existing?.originalSegment !== undefined && existing.originalSegment !== segment) {
      throw archiveCollision(path)
    }
    const child = existing ?? archiveTrieNode(segment)
    node.children.set(folded, child)
    node = child
  }
  if (node.file || node.children.size > 0) throw archiveCollision(path)
  node.file = true
}

function normalizeArchivePath(value: unknown): string {
  const path = String(value ?? '').replace(/\\/g, '/')
  const segments = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw boundary(400, 'invalid_skill_file_path', 'Invalid local skill file path')
  }
  return path
}

function normalizeGitPath(value: unknown): string {
  const path = String(value ?? '').replace(/\\/g, '/')
  const segments = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw boundary(422, 'invalid_member_entry', 'Source member entry is invalid')
  }
  return path
}

function compareInstallPath(
  left: { path?: string; relativePath?: string },
  right: { path?: string; relativePath?: string },
): number {
  const leftPath = left.relativePath ?? left.path ?? ''
  const rightPath = right.relativePath ?? right.path ?? ''
  if (leftPath === 'SKILL.md') return 1
  if (rightPath === 'SKILL.md') return -1
  return leftPath.localeCompare(rightPath, 'en')
}

function archiveCollision(path: string): LocalSkillBoundaryError {
  return boundary(
    409,
    'local_skill_archive_collision',
    `Local skill archive path collides: ${path}`,
  )
}

function boundary(
  status: 400 | 404 | 409 | 422 | 500,
  code: string,
  message: string,
  cause?: unknown,
): LocalSkillBoundaryError {
  return new LocalSkillBoundaryError(
    status,
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function ioFailure(operation: string, err: unknown, path: string): LocalSkillBoundaryError {
  return boundary(500, 'local_skill_io_failed', `${operation}: ${path}`, err)
}
