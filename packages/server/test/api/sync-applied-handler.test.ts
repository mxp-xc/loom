import { describe, expect, it, vi } from 'vitest'
import type { SkillSource } from '@loom/core'
import { createSyncAppliedHandler } from '../../src/api/router.js'

const source: SkillSource = {
  url: 'https://example.test/skills.git',
  ref: 'main',
  pinned_commit: 'a'.repeat(40),
  members: [],
}

describe('createSyncAppliedHandler', () => {
  it('reconciles source caches before projection', async () => {
    const order: string[] = []
    const reconcile = vi.fn(async () => {
      order.push('reconcile')
      return { restored: [source.url], unchanged: [], unavailable: [] }
    })
    const project = vi.fn(async () => {
      order.push('project')
      return { ok: true as const, warnings: [] }
    })
    const handler = createSyncAppliedHandler(deps(), { reconcile, project })

    await handler('/repo', '/home')

    expect(order).toEqual(['reconcile', 'project'])
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ home: '/home' }), '/repo')
  })

  it('logs the complete source error and still projects unavailable sources', async () => {
    const err = new Error('network unavailable')
    const log = { warn: vi.fn() }
    const project = vi.fn(async () => ({ ok: true as const, warnings: [] }))
    const handler = createSyncAppliedHandler(deps(), {
      reconcile: vi.fn(async () => ({
        restored: [],
        unchanged: [],
        unavailable: [{ source, err }],
      })),
      project,
      log: log as never,
    })

    await handler('/repo', '/home')

    expect(log.warn).toHaveBeenCalledWith(
      'sync source cache reconciliation completed with an unavailable source',
      expect.objectContaining({ err, sourceUrl: source.url }),
    )
    expect(project).toHaveBeenCalledTimes(1)
  })

  it('does not project after a hard reconciliation failure', async () => {
    const failure = new Error('cache boundary failed')
    const project = vi.fn()
    const handler = createSyncAppliedHandler(deps(), {
      reconcile: vi.fn(async () => Promise.reject(failure)),
      project,
    })

    await expect(handler('/repo', '/home')).rejects.toBe(failure)
    expect(project).not.toHaveBeenCalled()
  })
})

function deps() {
  return {
    fs: {} as never,
    git: {} as never,
    proc: {} as never,
    home: '/default-home',
    sourceProjectionCatalog: {} as never,
    sourceCacheHealthCatalog: {} as never,
  }
}
