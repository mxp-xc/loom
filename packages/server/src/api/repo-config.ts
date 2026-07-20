import { basename, dirname, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import {
  loadRepoManifest,
  normalizeConfigDocument,
  type Config,
  type ManifestConfigFile,
  type ManifestLoadDiagnostic,
  type McpServer,
  type RepoManifest,
  type SkillsManifest,
} from '@loom/core'
import { logger } from '../lib/logger.js'
import type { FileSystemEntry, IFileSystem } from '../ports/fs.js'

const repoConfigLogger = logger.child('repo-config')

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class RepoConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'RepoConfigError'
    this.code = code
  }
}

export class RepoManifestError extends RepoConfigError {
  constructor(
    readonly file: ManifestConfigFile,
    readonly diagnostics: ManifestLoadDiagnostic[],
  ) {
    super('manifest_container_invalid', `${file} has an invalid structure`, diagnostics)
    this.name = 'RepoManifestError'
  }
}

function safeYamlLoad(source: string): unknown {
  try {
    return yaml.load(source) ?? null
  } catch (error) {
    throw new RepoConfigError('yaml_invalid', 'invalid YAML configuration', error)
  }
}

export async function readYaml(
  fs: { readFile: (p: string) => Promise<string> },
  filePath: string,
): Promise<any> {
  let raw: string
  try {
    raw = await fs.readFile(filePath)
  } catch (error) {
    if (isMissing(error)) return null
    repoConfigLogger.error('failed to read YAML config', { err: error, path: filePath })
    throw error
  }
  try {
    return safeYamlLoad(raw)
  } catch (error) {
    repoConfigLogger.error('failed to parse YAML config', { err: error, path: filePath })
    throw error
  }
}

async function readRepoManifestDocument(
  fs: { readFile: (p: string) => Promise<string> },
  repoPath: string,
  file: ManifestConfigFile,
): Promise<RepoManifest> {
  const path = join(repoPath, file)
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch (error) {
    if (isMissing(error)) return loadRepoManifest({})
    repoConfigLogger.error('failed to read repository manifest document', { err: error, path })
    throw error
  }

  try {
    const manifest = loadRepoManifest({ [file]: raw })
    const diagnostics = (manifest.loadDiagnostics ?? []).filter(
      (diagnostic) => diagnostic.file === file,
    )
    if (diagnostics.length > 0) throw new RepoManifestError(file, diagnostics)
    return manifest
  } catch (error) {
    repoConfigLogger.error('failed to parse repository manifest document', { err: error, path })
    if (error instanceof RepoConfigError) throw error
    throw new RepoConfigError('yaml_invalid', `${file} contains invalid YAML`, error)
  }
}

export async function readSkillsManifest(
  fs: { readFile: (p: string) => Promise<string> },
  repoPath: string,
): Promise<SkillsManifest> {
  return (await readRepoManifestDocument(fs, repoPath, 'skills.yaml')).skills
}

export async function readMcpManifest(
  fs: { readFile: (p: string) => Promise<string> },
  repoPath: string,
): Promise<McpServer[]> {
  return (await readRepoManifestDocument(fs, repoPath, 'mcp.yaml')).mcp
}

export async function readRepoConfig(
  fs: { readFile: (p: string) => Promise<string> },
  repoPath: string,
): Promise<Config> {
  return (await readRepoManifestDocument(fs, repoPath, 'config.yaml')).repoConfig
}

export async function writeYaml(
  fs: {
    writeFile: (p: string, content: string) => Promise<void>
    replaceFile: (tempPath: string, targetPath: string) => Promise<void>
    removeFile: (p: string) => Promise<void>
  },
  filePath: string,
  data: any,
): Promise<void> {
  const temporary = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  )
  try {
    await fs.writeFile(temporary, serializeYaml(data))
    await fs.replaceFile(temporary, filePath)
  } catch (error) {
    repoConfigLogger.error('failed to atomically write YAML config', { err: error, path: filePath })
    try {
      await fs.removeFile(temporary)
    } catch (cleanupError) {
      if (!isMissing(cleanupError))
        repoConfigLogger.error('failed to clean up YAML temporary file', {
          err: cleanupError,
          path: temporary,
        })
    }
    throw error
  }
}

export function serializeYaml(data: unknown): string {
  return yaml.dump(data) + '\n'
}

export async function readRepoFiles(
  fs: Pick<IFileSystem, 'readFile' | 'readDir' | 'realPath' | 'inspectEntry'>,
  repoPath: string,
): Promise<Record<string, string>> {
  const repo = await requireStableDirectory(fs, repoPath, 'repository')
  const files: Record<string, string> = {}
  for (const p of ['config.yaml', 'skills.yaml', 'mcp.yaml']) {
    const content = await readStableOptionalFile(fs, join(repoPath, p))
    if (content !== null) files[p] = content
  }
  await readStableDirectoryFiles(fs, repoPath, 'vars', '.yaml', files)
  await readStableDirectoryFiles(fs, repoPath, 'memories', '.md', files)
  await assertStableEntry(fs, repoPath, repo)
  return files
}

async function readStableDirectoryFiles(
  fs: Pick<IFileSystem, 'readFile' | 'readDir' | 'realPath' | 'inspectEntry'>,
  repoPath: string,
  directoryName: string,
  extension: string,
  files: Record<string, string>,
): Promise<void> {
  const path = join(repoPath, directoryName)
  const entry = await inspectRepoEntry(fs, path)
  if (!entry) return
  const directory = await requireStableDirectory(fs, path, directoryName, entry)
  let names: string[]
  try {
    names = await fs.readDir(path)
  } catch (err) {
    throw repoBoundaryError(`failed to read ${directoryName} directory`, err, path)
  }
  for (const name of names.sort()) {
    if (!name.endsWith(extension)) continue
    if (!isSafeDirectName(name)) {
      throw repoBoundaryError(
        `invalid ${directoryName} entry name`,
        new Error('repository entry is not a safe direct child'),
        join(path, name),
      )
    }
    const content = await readStableOptionalFile(fs, join(path, name))
    if (content !== null) files[`${directoryName}/${name}`] = content
  }
  await assertStableEntry(fs, path, directory)
}

async function readStableOptionalFile(
  fs: Pick<IFileSystem, 'readFile' | 'inspectEntry'>,
  path: string,
): Promise<string | null> {
  const entry = await inspectRepoEntry(fs, path)
  if (!entry) return null
  if (entry.kind !== 'file' || entry.linkCount !== 1) {
    throw repoBoundaryError(
      'repository file is not an independent regular file',
      new Error(`unexpected repository entry kind: ${entry.kind}`),
      path,
    )
  }
  let content: string
  try {
    content = await fs.readFile(path)
  } catch (err) {
    throw repoBoundaryError('failed to read repository file', err, path)
  }
  await assertStableEntry(fs, path, entry)
  return content
}

async function requireStableDirectory(
  fs: Pick<IFileSystem, 'realPath' | 'inspectEntry'>,
  path: string,
  label: string,
  inspected?: FileSystemEntry,
): Promise<FileSystemEntry> {
  const entry = inspected ?? (await inspectRepoEntry(fs, path))
  if (!entry || entry.kind !== 'directory') {
    throw repoBoundaryError(
      `${label} is not a physical directory`,
      new Error(`unexpected repository entry kind: ${entry?.kind ?? 'missing'}`),
      path,
    )
  }
  let canonical: string
  try {
    canonical = normalize(await fs.realPath(path))
  } catch (err) {
    throw repoBoundaryError(`failed to resolve ${label}`, err, path)
  }
  if (canonical !== normalize(path)) {
    throw repoBoundaryError(
      `${label} escaped its repository path`,
      new Error('repository directory is not canonical'),
      path,
    )
  }
  await assertStableEntry(fs, path, entry)
  return entry
}

async function inspectRepoEntry(
  fs: Pick<IFileSystem, 'inspectEntry'>,
  path: string,
): Promise<FileSystemEntry | null> {
  try {
    return await fs.inspectEntry(path)
  } catch (err) {
    throw repoBoundaryError('failed to inspect repository entry', err, path)
  }
}

async function assertStableEntry(
  fs: Pick<IFileSystem, 'inspectEntry'>,
  path: string,
  expected: FileSystemEntry,
): Promise<void> {
  const current = await inspectRepoEntry(fs, path)
  if (
    !current ||
    current.kind !== expected.kind ||
    current.identity !== expected.identity ||
    current.linkCount !== expected.linkCount
  ) {
    throw repoBoundaryError(
      'repository entry changed during read',
      new Error('repository entry identity changed'),
      path,
    )
  }
}

function repoBoundaryError(message: string, cause: unknown, path: string): RepoConfigError {
  const err = new RepoConfigError('repository_boundary_invalid', message, cause)
  repoConfigLogger.error(message, { err, path })
  return err
}

function isSafeDirectName(name: string): boolean {
  return (
    Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  )
}

export async function readLocalConfig(
  fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
  home: string,
): Promise<Record<string, unknown>> {
  const path = join(home, '.loom', 'config.yaml')
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch (error) {
    if (isMissing(error)) return {}
    repoConfigLogger.error('failed to read local config', { err: error, path })
    throw error
  }
  try {
    const config = normalizeConfigDocument(raw.trim() === '' ? {} : safeYamlLoad(raw))
    if (!config) {
      throw new RepoConfigError(
        'config_container_invalid',
        'configuration must be an object',
        new TypeError('expected an object'),
      )
    }
    return config as Record<string, unknown>
  } catch (error) {
    repoConfigLogger.error('failed to parse local config', { err: error, path })
    throw error
  }
}
