import { describe, expect, it, vi } from 'vitest'
import type { SkillSource } from '@loom/core'
import { SourceProjectionCatalog } from '../../src/projection/source-catalog.js'
import { SourceCacheHealthCatalog } from '../../src/remote/source-cache-health.js'

const source: SkillSource = {
  url: 'https://example.test/skills.git',
  ref: 'main',
  pinned_commit: 'abc123',
  members: [],
}
const entry = {
  tree: { commit: 'abc123', nodes: [], diagnostics: [] },
  files: ['skills/example/SKILL.md'],
}

describe('SourceProjectionCatalog', () => {
  it('loads the same source key once across concurrent callers', async () => {
    let release!: (value: typeof entry) => void
    const loader = vi.fn(
      () =>
        new Promise<typeof entry>((resolve) => {
          release = resolve
        }),
    )
    const catalog = new SourceProjectionCatalog()

    const first = catalog.getOrLoad('/repo', source, loader)
    const second = catalog.getOrLoad('/repo', source, loader)
    release(entry)

    await expect(Promise.all([first, second])).resolves.toEqual([entry, entry])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns a warm entry without calling the loader', async () => {
    const catalog = new SourceProjectionCatalog()
    catalog.put('/repo', source, entry)
    const loader = vi.fn(async () => entry)

    await expect(catalog.getOrLoad('/repo', source, loader)).resolves.toBe(entry)
    expect(loader).not.toHaveBeenCalled()
  })

  it('loads again after invalidating the source', async () => {
    const catalog = new SourceProjectionCatalog()
    catalog.put('/repo', source, entry)
    catalog.invalidateSource('/repo', source.url)
    const loader = vi.fn(async () => entry)

    await expect(catalog.getOrLoad('/repo', source, loader)).resolves.toBe(entry)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not restore an invalidated in-flight entry after a newer load completes', async () => {
    let releaseOld!: (value: typeof entry) => void
    const catalog = new SourceProjectionCatalog()
    const oldEntry = { ...entry, files: ['old'] }
    const newEntry = { ...entry, files: ['new'] }
    const oldLoad = catalog.getOrLoad(
      '/repo',
      source,
      () =>
        new Promise<typeof entry>((resolve) => {
          releaseOld = resolve
        }),
    )
    catalog.invalidateSource('/repo', source.url)

    await expect(catalog.getOrLoad('/repo', source, async () => newEntry)).resolves.toBe(newEntry)
    releaseOld(oldEntry)
    await expect(oldLoad).resolves.toBe(oldEntry)

    const loader = vi.fn(async () => oldEntry)
    await expect(catalog.getOrLoad('/repo', source, loader)).resolves.toBe(newEntry)
    expect(loader).not.toHaveBeenCalled()
  })
})

describe('SourceCacheHealthCatalog', () => {
  it('does not restore invalidated in-flight health after a newer check completes', async () => {
    let releaseOld!: (value: { healthy: true }) => void
    const catalog = new SourceCacheHealthCatalog()
    const oldCheck = catalog.getOrCheck(
      '/repo',
      source,
      () =>
        new Promise<{ healthy: true }>((resolve) => {
          releaseOld = resolve
        }),
    )
    catalog.invalidateSource('/repo', source.url)
    const current = { healthy: false as const, reason: 'invalid' as const }

    await expect(catalog.getOrCheck('/repo', source, async () => current)).resolves.toBe(current)
    releaseOld({ healthy: true })
    await expect(oldCheck).resolves.toEqual({ healthy: true })

    expect(catalog.get('/repo', source)).toBe(current)
  })
})
