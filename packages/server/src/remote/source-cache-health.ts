import { normalize, resolve } from 'node:path'
import { deriveRepoId, type SkillSource } from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import type { IGit } from '../ports/git.js'
import { SourceProjectionCatalog } from '../projection/source-catalog.js'
import { assertAuthorizedSourceCache, resolveSourceCache } from './cache-boundary.js'
import { scanProjectionSourceTree } from './source-tree.js'

export type SourceCacheHealth =
  { healthy: true } | { healthy: false; reason: 'missing' | 'invalid'; err?: unknown }

export class SourceCacheHealthCatalog {
  private readonly entries = new Map<string, SourceCacheHealth>()
  private readonly pending = new Map<string, Promise<SourceCacheHealth>>()
  private readonly revisions = new Map<string, number>()

  revision(repoPath: string, sourceUrl: string): number {
    return this.revisions.get(sourcePrefix(repoPath, sourceUrl)) ?? 0
  }

  isCurrent(repoPath: string, sourceUrl: string, revision: number): boolean {
    return this.revision(repoPath, sourceUrl) === revision
  }

  get(
    repoPath: string,
    source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
  ): SourceCacheHealth | undefined {
    return this.entries.get(healthKey(repoPath, source))
  }

  async getOrCheck(
    repoPath: string,
    source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
    check: () => Promise<SourceCacheHealth>,
    expectedRevision = this.revision(repoPath, source.url),
  ): Promise<SourceCacheHealth> {
    const key = healthKey(repoPath, source)
    const current = this.entries.get(key)
    if (current) return current
    const active = this.pending.get(key)
    if (active) return active
    const checking = check().then(
      (health) => {
        if (
          this.pending.get(key) === checking &&
          this.isCurrent(repoPath, source.url, expectedRevision)
        ) {
          this.entries.set(key, health)
          this.pending.delete(key)
        } else if (this.pending.get(key) === checking) {
          this.pending.delete(key)
        }
        return health
      },
      (err: unknown) => {
        if (this.pending.get(key) === checking) this.pending.delete(key)
        throw err
      },
    )
    this.pending.set(key, checking)
    return checking
  }

  put(
    repoPath: string,
    source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
    health: SourceCacheHealth,
    expectedRevision = this.revision(repoPath, source.url),
  ): void {
    const key = healthKey(repoPath, source)
    this.pending.delete(key)
    if (this.isCurrent(repoPath, source.url, expectedRevision)) this.entries.set(key, health)
  }

  invalidateSource(repoPath: string, sourceUrl: string): void {
    const prefix = sourcePrefix(repoPath, sourceUrl)
    this.revisions.set(prefix, this.revision(repoPath, sourceUrl) + 1)
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) this.pending.delete(key)
    }
  }
}

export async function inspectSourceCacheHealth(
  fs: IFileSystem,
  git: IGit,
  repoPath: string,
  source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
): Promise<SourceCacheHealth> {
  try {
    const cache = await resolveSourceCache(fs, repoPath, deriveRepoId(source.url))
    if (!cache) return { healthy: false, reason: 'missing' }
    const expectedCommit = source.pinned_commit?.trim()
    if (!expectedCommit) return { healthy: false, reason: 'invalid' }
    const actualCommit = await git.revParseHead(cache.directory.path)
    await assertAuthorizedSourceCache(fs, cache)
    return actualCommit === expectedCommit
      ? { healthy: true }
      : {
          healthy: false,
          reason: 'invalid',
          err: new Error('Source cache checkout does not match its pinned commit'),
        }
  } catch (err) {
    return { healthy: false, reason: 'invalid', err }
  }
}

export async function warmSourceProjectionCatalog(
  fs: IFileSystem,
  git: IGit,
  catalog: SourceProjectionCatalog,
  repoPath: string,
  source: SkillSource,
  expectedRevision = catalog.revision(repoPath, source.url),
): Promise<void> {
  const cache = await resolveSourceCache(fs, repoPath, deriveRepoId(source.url))
  if (!cache) throw new Error(`Source cache unavailable: ${source.url}`)
  const commit = source.pinned_commit?.trim() || source.ref
  await catalog.getOrLoad(
    repoPath,
    source,
    async () => {
      const entry = await scanProjectionSourceTree(git, cache.directory.path, commit, source)
      await assertAuthorizedSourceCache(fs, cache)
      return entry
    },
    expectedRevision,
  )
}

export function invalidateSourceRuntimeCatalogs(
  projectionCatalog: SourceProjectionCatalog | undefined,
  healthCatalog: SourceCacheHealthCatalog | undefined,
  repoPath: string,
  sourceUrl: string,
): void {
  projectionCatalog?.invalidateSource(repoPath, sourceUrl)
  healthCatalog?.invalidateSource(repoPath, sourceUrl)
}

export async function refreshSourceRuntimeCatalogs(
  fs: IFileSystem,
  git: IGit,
  projectionCatalog: SourceProjectionCatalog | undefined,
  healthCatalog: SourceCacheHealthCatalog | undefined,
  repoPath: string,
  source: SkillSource,
): Promise<SourceCacheHealth> {
  invalidateSourceRuntimeCatalogs(projectionCatalog, healthCatalog, repoPath, source.url)
  const health = healthCatalog
    ? await healthCatalog.getOrCheck(repoPath, source, () =>
        inspectSourceCacheHealth(fs, git, repoPath, source),
      )
    : await inspectSourceCacheHealth(fs, git, repoPath, source)
  if (health.healthy && projectionCatalog) {
    await warmSourceProjectionCatalog(fs, git, projectionCatalog, repoPath, source)
  }
  return health
}

function healthKey(
  repoPath: string,
  source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
): string {
  return `${normalize(resolve(repoPath))}\0${source.url}\0${source.pinned_commit ?? source.ref}`
}

function sourcePrefix(repoPath: string, sourceUrl: string): string {
  return `${normalize(resolve(repoPath))}\0${sourceUrl}\0`
}
