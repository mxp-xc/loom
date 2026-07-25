import { normalize, resolve } from 'node:path'
import type { SkillSource, SourceTree } from '@loom/core'

export interface SourceProjectionCatalogEntry {
  tree: SourceTree
  files: readonly string[]
}

export class SourceProjectionCatalog {
  private readonly entries = new Map<string, SourceProjectionCatalogEntry>()
  private readonly pending = new Map<string, Promise<SourceProjectionCatalogEntry>>()
  private readonly revisions = new Map<string, number>()

  revision(repoPath: string, sourceUrl: string): number {
    return this.revisions.get(sourcePrefix(repoPath, sourceUrl)) ?? 0
  }

  isCurrent(repoPath: string, sourceUrl: string, revision: number): boolean {
    return this.revision(repoPath, sourceUrl) === revision
  }

  async getOrLoad(
    repoPath: string,
    source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
    load: () => Promise<SourceProjectionCatalogEntry>,
    expectedRevision = this.revision(repoPath, source.url),
  ): Promise<SourceProjectionCatalogEntry> {
    const key = catalogKey(repoPath, source)
    const current = this.entries.get(key)
    if (current) return current
    const active = this.pending.get(key)
    if (active) return active
    const loading = load().then(
      (entry) => {
        if (
          this.pending.get(key) === loading &&
          this.isCurrent(repoPath, source.url, expectedRevision)
        ) {
          this.entries.set(key, entry)
          this.pending.delete(key)
        } else if (this.pending.get(key) === loading) {
          this.pending.delete(key)
        }
        return entry
      },
      (err: unknown) => {
        if (this.pending.get(key) === loading) this.pending.delete(key)
        throw err
      },
    )
    this.pending.set(key, loading)
    return loading
  }

  put(
    repoPath: string,
    source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
    entry: SourceProjectionCatalogEntry,
    expectedRevision = this.revision(repoPath, source.url),
  ): void {
    const key = catalogKey(repoPath, source)
    this.pending.delete(key)
    if (this.isCurrent(repoPath, source.url, expectedRevision)) this.entries.set(key, entry)
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

function sourcePrefix(repoPath: string, sourceUrl: string): string {
  return `${normalize(resolve(repoPath))}\0${sourceUrl}\0`
}

function catalogKey(
  repoPath: string,
  source: Pick<SkillSource, 'url' | 'ref' | 'pinned_commit'>,
): string {
  return `${normalize(resolve(repoPath))}\0${source.url}\0${source.pinned_commit ?? source.ref}`
}
