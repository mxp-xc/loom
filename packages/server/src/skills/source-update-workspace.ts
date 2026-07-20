import { createHash, randomUUID } from 'node:crypto'
import { join, normalize } from 'node:path'
import { deriveRepoId } from '@loom/core'
import type { FileSystemEntry, IFileSystem } from '../ports/fs.js'

export const SOURCE_UPDATE_SESSION_VERSION = 1 as const
export const SOURCE_UPDATE_OWNER_FILE = '.loom-source-update-owner.json'

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type WorkspaceFileSystem = Pick<
  IFileSystem,
  | 'inspectEntry'
  | 'realPath'
  | 'mkdir'
  | 'readFile'
  | 'writeFile'
  | 'writeFileExclusive'
  | 'removeDir'
  | 'removeEntryIfIdentity'
>

export interface SourceUpdateWorkspaceIdentity {
  version: typeof SOURCE_UPDATE_SESSION_VERSION
  id: string
  ownerToken: string
  sourceKey: string
  rootIdentity: string
}

export interface SourceUpdateWorkspace extends SourceUpdateWorkspaceIdentity {
  repoPath: string
  updatesRoot: string
  sessionRoot: string
  stagingDir: string
  candidateDir: string
  backupCacheDir: string
  manifestCandidatePath: string
  manifestBackupPath: string
  stateFile: string
  stateTemporaryFile: string
  ownerFile: string
  manifestPath: string
  liveCacheDir: string
}

interface OwnerDocument extends SourceUpdateWorkspaceIdentity {}

export class SourceUpdateWorkspaceError extends Error {
  constructor(
    readonly code: 'invalid_update_session_state' | 'update_session_unavailable',
    readonly status: 422 | 500,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SourceUpdateWorkspaceError'
  }
}

export function sourceUpdateKey(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

export function assertSourceUpdateSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SourceUpdateWorkspaceError(
      'invalid_update_session_state',
      422,
      'source update session id is invalid',
    )
  }
}

export function deriveSourceUpdateWorkspace(
  repoPath: string,
  identity: Omit<SourceUpdateWorkspaceIdentity, 'rootIdentity'> & { rootIdentity?: string },
  sourceUrl: string,
): SourceUpdateWorkspace {
  assertSourceUpdateSessionId(identity.id)
  const sourceKey = sourceUpdateKey(sourceUrl)
  if (identity.sourceKey !== sourceKey) {
    throw new SourceUpdateWorkspaceError(
      'invalid_update_session_state',
      422,
      'source update session source identity is invalid',
    )
  }
  const updatesRoot = join(repoPath, 'temp', 'source-updates')
  const sessionRoot = join(updatesRoot, identity.id)
  return {
    version: SOURCE_UPDATE_SESSION_VERSION,
    id: identity.id,
    ownerToken: identity.ownerToken,
    sourceKey,
    rootIdentity: identity.rootIdentity ?? '',
    repoPath,
    updatesRoot,
    sessionRoot,
    stagingDir: join(sessionRoot, 'previous'),
    candidateDir: join(sessionRoot, 'candidate'),
    backupCacheDir: join(sessionRoot, 'live-backup'),
    manifestCandidatePath: join(sessionRoot, 'manifest.next.yaml'),
    manifestBackupPath: join(sessionRoot, 'manifest.previous.yaml'),
    stateFile: join(sessionRoot, 'session.json'),
    stateTemporaryFile: join(sessionRoot, 'session.next.json'),
    ownerFile: join(sessionRoot, SOURCE_UPDATE_OWNER_FILE),
    manifestPath: join(repoPath, 'skills.yaml'),
    liveCacheDir: join(repoPath, 'remote-cache', deriveRepoId(sourceUrl)),
  }
}

export async function createSourceUpdateWorkspace(
  fs: WorkspaceFileSystem,
  repoPath: string,
  sourceUrl: string,
): Promise<SourceUpdateWorkspace> {
  await assertCanonicalDirectory(fs, repoPath, repoPath, 'repository root')
  await ensureCanonicalChildDirectory(fs, repoPath, 'temp')
  const updatesRoot = await ensureCanonicalChildDirectory(
    fs,
    join(repoPath, 'temp'),
    'source-updates',
  )

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomUUID()
    const ownerToken = randomUUID()
    const sourceKey = sourceUpdateKey(sourceUrl)
    const provisional = deriveSourceUpdateWorkspace(
      repoPath,
      { version: SOURCE_UPDATE_SESSION_VERSION, id, ownerToken, sourceKey },
      sourceUrl,
    )
    try {
      await fs.mkdir(provisional.sessionRoot, false)
    } catch (error) {
      if (isAlreadyExists(error)) continue
      throw unavailable('failed to create source update workspace', error)
    }

    let rootIdentity: string | undefined
    try {
      const created = await fs.inspectEntry(provisional.sessionRoot)
      if (created?.kind !== 'directory') {
        throw invalidState('source update workspace is not a physical directory')
      }
      rootIdentity = created.identity
      const root = await assertStableDirectory(
        fs,
        provisional.sessionRoot,
        rootIdentity,
        'source update workspace',
      )
      const workspace = { ...provisional, rootIdentity: root.identity }
      const owner: OwnerDocument = workspaceIdentity(workspace)
      const ownerEntry = await fs.writeFileExclusive(workspace.ownerFile, JSON.stringify(owner))
      await assertStableFile(fs, workspace.ownerFile, ownerEntry.identity, 'workspace owner file')
      await fs.mkdir(workspace.stagingDir, false)
      await fs.mkdir(workspace.candidateDir, false)
      await assertCanonicalDirectory(
        fs,
        workspace.stagingDir,
        workspace.stagingDir,
        'previous snapshot',
      )
      await assertCanonicalDirectory(
        fs,
        workspace.candidateDir,
        workspace.candidateDir,
        'candidate cache',
      )
      await assertStableDirectory(fs, updatesRoot.path, updatesRoot.identity, 'source update root')
      return workspace
    } catch (error) {
      if (rootIdentity) {
        try {
          await fs.removeEntryIfIdentity(provisional.sessionRoot, rootIdentity)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'source update workspace creation and cleanup failed',
            { cause: error },
          )
        }
      }
      throw error
    }
  }

  throw new SourceUpdateWorkspaceError(
    'update_session_unavailable',
    500,
    'failed to allocate a unique source update workspace',
  )
}

export async function inspectSourceUpdateStateFile(
  fs: WorkspaceFileSystem,
  repoPath: string,
  id: string,
): Promise<string | undefined> {
  assertSourceUpdateSessionId(id)
  await assertCanonicalDirectory(fs, repoPath, repoPath, 'repository root')
  const temp = await inspectOptionalCanonicalDirectory(
    fs,
    join(repoPath, 'temp'),
    'repository temp',
  )
  if (!temp) return undefined
  const updates = await inspectOptionalCanonicalDirectory(
    fs,
    join(repoPath, 'temp', 'source-updates'),
    'source update root',
  )
  if (!updates) return undefined
  const sessionRoot = join(repoPath, 'temp', 'source-updates', id)
  const session = await inspectOptionalCanonicalDirectory(
    fs,
    sessionRoot,
    'source update workspace',
  )
  if (!session) return undefined
  const stateFile = join(sessionRoot, 'session.json')
  const state = await fs.inspectEntry(stateFile)
  if (!state) throw invalidState('source update state is missing')
  await assertCanonicalFile(fs, stateFile, stateFile, 'source update state')
  try {
    return await fs.readFile(stateFile)
  } catch (error) {
    throw unavailable('failed to read source update state', error)
  }
}

export async function verifySourceUpdateWorkspace(
  fs: WorkspaceFileSystem,
  repoPath: string,
  sourceUrl: string,
  identity: SourceUpdateWorkspaceIdentity,
): Promise<SourceUpdateWorkspace> {
  if (
    identity.version !== SOURCE_UPDATE_SESSION_VERSION ||
    !SESSION_ID_PATTERN.test(identity.ownerToken) ||
    !/^[0-9a-f]{64}$/.test(identity.sourceKey) ||
    !identity.rootIdentity
  ) {
    throw invalidState('source update workspace identity is malformed')
  }
  const workspace = deriveSourceUpdateWorkspace(repoPath, identity, sourceUrl)
  await assertCanonicalDirectory(fs, repoPath, repoPath, 'repository root')
  await assertCanonicalDirectory(
    fs,
    join(repoPath, 'temp'),
    join(repoPath, 'temp'),
    'repository temp',
  )
  await assertCanonicalDirectory(
    fs,
    workspace.updatesRoot,
    workspace.updatesRoot,
    'source update root',
  )
  await assertStableDirectory(
    fs,
    workspace.sessionRoot,
    identity.rootIdentity,
    'source update workspace',
  )
  const ownerEntry = await assertCanonicalFile(
    fs,
    workspace.ownerFile,
    workspace.ownerFile,
    'workspace owner file',
  )
  let raw: string
  try {
    raw = await fs.readFile(workspace.ownerFile)
  } catch (error) {
    throw unavailable('failed to read source update workspace owner file', error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalidState('source update workspace owner file is invalid', error)
  }
  const owner = parseOwnerDocument(parsed)
  if (!sameWorkspaceIdentity(owner, identity)) {
    throw invalidState('source update workspace ownership does not match persisted state')
  }
  await assertStableFile(fs, workspace.ownerFile, ownerEntry.identity, 'workspace owner file')
  return workspace
}

export async function removeSourceUpdateWorkspace(
  fs: WorkspaceFileSystem,
  workspace: SourceUpdateWorkspace,
  sourceUrl: string,
): Promise<void> {
  const verified = await verifySourceUpdateWorkspace(fs, workspace.repoPath, sourceUrl, workspace)
  await fs.removeEntryIfIdentity(verified.sessionRoot, verified.rootIdentity)
}

export function workspaceIdentity(
  workspace: SourceUpdateWorkspaceIdentity,
): SourceUpdateWorkspaceIdentity {
  return {
    version: SOURCE_UPDATE_SESSION_VERSION,
    id: workspace.id,
    ownerToken: workspace.ownerToken,
    sourceKey: workspace.sourceKey,
    rootIdentity: workspace.rootIdentity,
  }
}

export async function assertOwnedDirectory(
  fs: WorkspaceFileSystem,
  path: string,
  identity: string,
  description: string,
): Promise<FileSystemEntry> {
  return assertStableDirectory(fs, path, identity, description)
}

export async function inspectOptionalOwnedDirectory(
  fs: WorkspaceFileSystem,
  path: string,
  description: string,
): Promise<FileSystemEntry | null> {
  const entry = await fs.inspectEntry(path)
  if (!entry) return null
  if (entry.kind !== 'directory') throw invalidState(`${description} is not a physical directory`)
  return assertCanonicalDirectory(fs, path, path, description)
}

export async function ensureSourceUpdateChildDirectory(
  fs: WorkspaceFileSystem,
  parent: string,
  name: string,
): Promise<FileSystemEntry & { path: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw invalidState('managed directory name is invalid')
  }
  await assertCanonicalDirectory(fs, parent, parent, 'managed directory parent')
  return ensureCanonicalChildDirectory(fs, parent, name)
}

async function ensureCanonicalChildDirectory(
  fs: WorkspaceFileSystem,
  parent: string,
  name: string,
): Promise<FileSystemEntry & { path: string }> {
  const path = join(parent, name)
  let entry = await fs.inspectEntry(path)
  if (!entry) {
    try {
      await fs.mkdir(path, false)
    } catch (error) {
      if (!isAlreadyExists(error)) throw unavailable(`failed to create ${name} directory`, error)
    }
    entry = await fs.inspectEntry(path)
  }
  if (entry?.kind !== 'directory') throw invalidState(`${name} is not a physical directory`)
  const stable = await assertCanonicalDirectory(fs, path, path, name)
  return { ...stable, path }
}

async function inspectOptionalCanonicalDirectory(
  fs: WorkspaceFileSystem,
  path: string,
  description: string,
): Promise<FileSystemEntry | null> {
  const entry = await fs.inspectEntry(path)
  if (!entry) return null
  if (entry.kind !== 'directory') throw invalidState(`${description} is not a physical directory`)
  return assertCanonicalDirectory(fs, path, path, description)
}

async function assertCanonicalDirectory(
  fs: WorkspaceFileSystem,
  path: string,
  expectedCanonical: string,
  description: string,
): Promise<FileSystemEntry> {
  const before = await fs.inspectEntry(path)
  if (before?.kind !== 'directory') throw invalidState(`${description} is not a physical directory`)
  let canonical: string
  try {
    canonical = normalize(await fs.realPath(path))
  } catch (error) {
    throw unavailable(`failed to resolve ${description}`, error)
  }
  const after = await fs.inspectEntry(path)
  if (after?.kind !== 'directory' || after.identity !== before.identity) {
    throw invalidState(`${description} changed during authorization`)
  }
  if (canonical !== normalize(expectedCanonical)) {
    throw invalidState(`${description} is outside its authorized location`)
  }
  return after
}

async function assertCanonicalFile(
  fs: WorkspaceFileSystem,
  path: string,
  expectedCanonical: string,
  description: string,
): Promise<FileSystemEntry> {
  const before = await fs.inspectEntry(path)
  if (before?.kind !== 'file') throw invalidState(`${description} is not a regular file`)
  let canonical: string
  try {
    canonical = normalize(await fs.realPath(path))
  } catch (error) {
    throw unavailable(`failed to resolve ${description}`, error)
  }
  const after = await fs.inspectEntry(path)
  if (after?.kind !== 'file' || after.identity !== before.identity) {
    throw invalidState(`${description} changed during authorization`)
  }
  if (canonical !== normalize(expectedCanonical)) {
    throw invalidState(`${description} is outside its authorized location`)
  }
  return after
}

async function assertStableDirectory(
  fs: WorkspaceFileSystem,
  path: string,
  identity: string,
  description: string,
): Promise<FileSystemEntry> {
  const entry = await assertCanonicalDirectory(fs, path, path, description)
  if (!identity || entry.identity !== identity)
    throw invalidState(`${description} identity changed`)
  return entry
}

async function assertStableFile(
  fs: WorkspaceFileSystem,
  path: string,
  identity: string,
  description: string,
): Promise<FileSystemEntry> {
  const entry = await assertCanonicalFile(fs, path, path, description)
  if (entry.identity !== identity) throw invalidState(`${description} identity changed`)
  return entry
}

function parseOwnerDocument(value: unknown): OwnerDocument {
  if (!isRecord(value)) throw invalidState('source update workspace owner is malformed')
  const keys = Object.keys(value).sort()
  const expected = ['id', 'ownerToken', 'rootIdentity', 'sourceKey', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalidState('source update workspace owner has unexpected fields')
  }
  if (
    value.version !== SOURCE_UPDATE_SESSION_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.ownerToken !== 'string' ||
    typeof value.sourceKey !== 'string' ||
    typeof value.rootIdentity !== 'string'
  ) {
    throw invalidState('source update workspace owner is malformed')
  }
  assertSourceUpdateSessionId(value.id)
  if (
    !SESSION_ID_PATTERN.test(value.ownerToken) ||
    !/^[0-9a-f]{64}$/.test(value.sourceKey) ||
    !value.rootIdentity
  ) {
    throw invalidState('source update workspace owner identity is malformed')
  }
  return value as unknown as OwnerDocument
}

function sameWorkspaceIdentity(
  left: SourceUpdateWorkspaceIdentity,
  right: SourceUpdateWorkspaceIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.id === right.id &&
    left.ownerToken === right.ownerToken &&
    left.sourceKey === right.sourceKey &&
    left.rootIdentity === right.rootIdentity
  )
}

function invalidState(message: string, cause?: unknown): SourceUpdateWorkspaceError {
  return new SourceUpdateWorkspaceError('invalid_update_session_state', 422, message, { cause })
}

function unavailable(message: string, cause: unknown): SourceUpdateWorkspaceError {
  return new SourceUpdateWorkspaceError('update_session_unavailable', 500, message, { cause })
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
