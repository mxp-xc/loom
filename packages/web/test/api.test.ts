// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../src/lib/api'

describe('API errors', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves structured error metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: 'resolution_failed',
                message: '变量解析失败',
                diagnostics: [{ code: 'cycle', severity: 'error', message: '循环' }],
              },
            }),
            { status: 422, statusText: 'Unprocessable Entity' },
          ),
      ),
    )
    const error = await api.vars.listEnvironments('/repo').catch((cause) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 422, code: 'resolution_failed', message: '变量解析失败' })
    expect(error.diagnostics).toHaveLength(1)
  })

  it('preserves flat error codes during envelope migration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: 'invalid_repo',
              message: 'Repository is unavailable',
              diagnostics: [{ code: 'invalid', severity: 'error', message: 'Invalid repo' }],
            }),
            { status: 400, statusText: 'Bad Request' },
          ),
      ),
    )

    const error = await api.getManifest('missing').catch((cause) => cause)
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_repo',
      message: 'Repository is unavailable',
    })
    if (!(error instanceof ApiError)) throw error
    expect(error.diagnostics).toHaveLength(1)
  })

  it('falls back for non-JSON errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway down', { status: 502, statusText: 'Bad Gateway' })),
    )
    const error = await api.vars.listEnvironments('/repo').catch((cause) => cause)
    expect(error).toMatchObject({ status: 502, message: '502 Bad Gateway: gateway down' })
    expect(error.cause).toBeDefined()
  })
})
