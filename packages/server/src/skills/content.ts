import { dirname, join, normalize } from 'node:path'
import { deriveRepoId, SkillSourceSchema, type SkillSource } from '@loom/core'
import { logger } from '../lib/logger.js'
import { readSkillsManifest, RepoManifestError } from '../api/repo-config.js'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import {
  LocalSkillBoundaryError,
  requireAvailableLocalSkill,
  resolveEffectiveLocalSkill,
} from './local-paths.js'

const contentLogger = logger.child('skill-content')
const PINNED_COMMIT_REGEX = /^[0-9a-f]{7,64}$/
const REGULAR_BLOB_MODES = new Set(['100644', '100755'])

export type SkillContentIdentity =
  { kind: 'local'; skillId: string } | { kind: 'source'; sourceUrl: string; memberEntry: string }

export class SkillContentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SkillContentError'
  }
}

export async function readSkillContent(
  fs: IFileSystem,
  git: IGit,
  repoPath: string,
  identity: SkillContentIdentity,
): Promise<{ content: string }> {
  try {
    const manifest = await readSkillsManifest(fs, repoPath)
    const sources = indexSources(manifest.sources)
    if (identity.kind === 'local') {
      const skill = requireAvailableLocalSkill(
        await resolveEffectiveLocalSkill(fs, repoPath, manifest, identity.skillId),
        identity.skillId,
      )
      return { content: await fs.readFile(skill.skillFile) }
    }

    const source = sources.get(identity.sourceUrl)
    const member = source?.members?.find((candidate) => candidate.entry === identity.memberEntry)
    if (!source || !member) {
      throw new SkillContentError(404, 'source_skill_not_found', 'Source skill not found')
    }
    const commit = source.pinned_commit?.trim() ?? ''
    if (!PINNED_COMMIT_REGEX.test(commit)) {
      throw new SkillContentError(
        422,
        'source_commit_unavailable',
        'Source pinned commit is unavailable',
      )
    }

    const cacheDir = await resolveSourceCache(fs, repoPath, deriveRepoId(source.url))
    const entries = await git.readTree(cacheDir, commit)
    const entry = entries.find((candidate) => candidate.path === member.entry)
    if (!entry || entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
      throw new SkillContentError(422, 'source_skill_unavailable', 'Source skill is unavailable')
    }
    const content = await git.show(cacheDir, commit, member.entry)
    return { content }
  } catch (err) {
    throw mapContentError(err, 'read', identity)
  }
}

export async function writeLocalSkillContent(
  fs: IFileSystem,
  repoPath: string,
  skillId: string,
  content: string,
): Promise<void> {
  try {
    const manifest = await readSkillsManifest(fs, repoPath)
    const skill = requireAvailableLocalSkill(
      await resolveEffectiveLocalSkill(fs, repoPath, manifest, skillId),
      skillId,
    )
    await fs.writeFile(skill.skillFile, content)
  } catch (err) {
    throw mapContentError(err, 'write', { kind: 'local', skillId })
  }
}

function indexSources(sources: unknown[]): Map<string, SkillSource> {
  const byUrl = new Map<string, SkillSource>()
  const names = new Set<string>()
  const cacheIds = new Set<string>()
  for (const [index, candidate] of sources.entries()) {
    const parsed = SkillSourceSchema.safeParse(candidate)
    if (!parsed.success) {
      throw invalidManifest(`Invalid source at sources[${index}]`, parsed.error)
    }
    const source = parsed.data
    const name = source.name ?? deriveRepoId(source.url)
    const cacheId = deriveRepoId(source.url)
    if (byUrl.has(source.url) || names.has(name) || cacheIds.has(cacheId)) {
      throw invalidManifest(`Ambiguous source identity at sources[${index}]`)
    }
    byUrl.set(source.url, source)
    names.add(name)
    cacheIds.add(cacheId)
  }
  return byUrl
}

function invalidManifest(message: string, cause?: unknown): SkillContentError {
  return new SkillContentError(422, 'invalid_skills_manifest', 'Skills manifest is invalid', {
    cause: cause ?? new Error(message),
  })
}

async function resolveSourceCache(
  fs: IFileSystem,
  repoPath: string,
  cacheId: string,
): Promise<string> {
  const canonicalRepo = normalize(await fs.realPath(repoPath))
  const rootPath = join(canonicalRepo, 'remote-cache')
  const rootEntry = await fs.inspectEntry(rootPath)
  if (!rootEntry) {
    throw new SkillContentError(404, 'source_cache_unavailable', 'Source cache is unavailable')
  }
  if (rootEntry.kind !== 'directory') {
    throw new SkillContentError(422, 'invalid_source_cache', 'Source cache is invalid')
  }
  const canonicalRoot = normalize(await fs.realPath(rootPath))
  if (canonicalRoot !== normalize(rootPath)) {
    throw new SkillContentError(422, 'invalid_source_cache', 'Source cache is invalid')
  }

  const cachePath = join(canonicalRoot, cacheId)
  const before = await fs.inspectEntry(cachePath)
  if (!before) {
    throw new SkillContentError(404, 'source_cache_unavailable', 'Source cache is unavailable')
  }
  if (before.kind !== 'directory') {
    throw new SkillContentError(422, 'invalid_source_cache', 'Source cache is invalid')
  }
  const canonicalCache = normalize(await fs.realPath(cachePath))
  const after = await fs.inspectEntry(cachePath)
  const confirmedCanonical = normalize(await fs.realPath(cachePath))
  if (
    dirname(canonicalCache) !== canonicalRoot ||
    after?.kind !== 'directory' ||
    after.identity !== before.identity ||
    confirmedCanonical !== canonicalCache
  ) {
    throw new SkillContentError(422, 'invalid_source_cache', 'Source cache is invalid')
  }
  return canonicalCache
}

function mapContentError(
  err: unknown,
  operation: 'read' | 'write',
  identity: SkillContentIdentity,
): SkillContentError {
  if (err instanceof SkillContentError) return err
  if (err instanceof RepoManifestError) {
    return new SkillContentError(422, 'invalid_skills_manifest', 'Skills manifest is invalid', {
      cause: err,
    })
  }
  if (err instanceof LocalSkillBoundaryError) {
    return new SkillContentError(
      err.status,
      err.code,
      err.status === 404 ? 'Local skill not found' : 'Local skill is unavailable',
      { cause: err },
    )
  }
  contentLogger.error(`skill content ${operation} failed`, { err, identity })
  return new SkillContentError(
    500,
    `skill_content_${operation}_failed`,
    'Skill content unavailable',
    {
      cause: err,
    },
  )
}
