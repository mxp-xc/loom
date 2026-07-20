import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../../web/src/lib/api.js'
import type { IGit } from '../../src/ports/git.js'
import { createContractApp } from '../helpers/contract-app.js'
import { honoFetch } from '../helpers/http.js'

vi.mock('../../src/lib/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  }
  return { logger }
})

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function useContractApp(overrides?: Parameters<typeof createContractApp>[0]) {
  const fixture = await createContractApp(overrides)
  disposals.push(fixture.dispose)
  vi.stubGlobal('fetch', honoFetch(fixture.app))
  return fixture
}

describe('Hono to Web API contract', () => {
  it('preserves flat validation status, code, and message', async () => {
    await useContractApp()

    await expect(api.syncPull('')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_repo',
      message: 'request validation failed',
    } satisfies Partial<ApiError>)
  })

  it('preserves nested Vars diagnostics for state conflicts', async () => {
    const { repoPath } = await useContractApp()
    await mkdir(join(repoPath, 'vars'), { recursive: true })
    await writeFile(
      join(repoPath, 'vars', 'base.yaml'),
      [
        'API_URL:',
        '  type: string',
        '  value: https://example.test',
        'CLIENT:',
        '  type: string',
        '  value: ${API_URL}',
        '',
      ].join('\n'),
    )

    await expect(api.vars.deleteBaseKey(repoPath, 'API_URL')).rejects.toMatchObject({
      status: 409,
      code: 'delete_blocked_by_reference',
      diagnostics: [expect.objectContaining({ code: 'REFERENCE_EXISTS', key: 'CLIENT' })],
    } satisfies Partial<ApiError>)
  })

  it('maps operational Config failures to a safe HTTP 500 error', async () => {
    const error = new Error('secret filesystem failure')
    const fixture = await useContractApp()
    vi.spyOn(fixture.fs, 'readFile').mockRejectedValueOnce(error)

    await expect(api.getConfig('default')).rejects.toMatchObject({
      status: 500,
      code: 'config_read_failed',
      message: 'failed to read configuration',
    } satisfies Partial<ApiError>)
  })

  it('keeps Sync push rejection as an HTTP 200 business result', async () => {
    const git = {
      status: async () => ({ dirty: false }),
      push: async () => ({ ok: false as const, nonFastForward: true, message: 'rejected' }),
    } as unknown as IGit
    await useContractApp({ git })

    await expect(api.syncPush('default')).resolves.toEqual({
      ok: false,
      nonFastForward: true,
      message: 'rejected',
    })
  })

  it('preserves inactive and active Sync session variants', async () => {
    await useContractApp()
    await expect(api.getSyncSession('default')).resolves.toEqual({ ok: true, active: false })

    const active = await useContractApp({
      sync: {
        getSession: async () => ({
          sessionId: 'sync-1',
          clean: false,
          conflicts: [],
        }),
      },
    })
    vi.stubGlobal('fetch', honoFetch(active.app))
    await expect(api.getSyncSession('default')).resolves.toEqual({
      ok: true,
      active: true,
      sessionId: 'sync-1',
      clean: false,
      conflicts: [],
    })
  })

  it('returns diagnostics instead of throwing for an invalid Manifest container', async () => {
    const { repoPath } = await useContractApp()
    await writeFile(join(repoPath, 'skills.yaml'), 'scalar\n')

    await expect(api.getManifest('default')).resolves.toMatchObject({
      errors: [expect.stringContaining('skills.yaml')],
      skills: { sources: [], skills: [] },
    })
  })
})
