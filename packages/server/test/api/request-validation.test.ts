import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { jsonValidator, paramValidator, queryValidator } from '../../src/api/request-validation'

describe('request validation middleware', () => {
  it('returns the configured error body when JSON validation fails', async () => {
    const app = new Hono().post(
      '/demo',
      jsonValidator(
        z.object({
          id: z.string().min(1),
        }),
        { error: 'invalid_id' },
      ),
      (c) => c.json(c.req.valid('json')),
    )

    const response = await app.request('/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_id' })
  })

  it('can derive the error code from the failed issue path', async () => {
    const app = new Hono().post(
      '/demo',
      jsonValidator(
        z.object({
          sourceUrl: z.string().min(1),
          updates: z.array(z.unknown()),
        }),
        {
          error: (issues) =>
            issues[0]?.path[0] === 'sourceUrl' ? 'invalid_source_url' : 'invalid_updates',
        },
      ),
      (c) => c.json(c.req.valid('json')),
    )

    const response = await app.request('/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUrl: 'https://example.test/skills.git', updates: null }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_updates' })
  })

  it('validates query input and exposes the parsed query', async () => {
    const app = new Hono().get(
      '/demo',
      queryValidator(
        z.object({
          repo: z.string().min(1),
        }),
        { error: 'invalid_repo' },
      ),
      (c) => c.json(c.req.valid('query')),
    )

    const invalid = await app.request('/demo')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ ok: false, error: 'invalid_repo' })

    const valid = await app.request('/demo?repo=default')
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ repo: 'default' })
  })

  it('validates route params and supports custom error bodies', async () => {
    const app = new Hono().get(
      '/demo/:environment',
      paramValidator(
        z.object({
          environment: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
        }),
        {
          error: 'invalid_request',
          body: (error) => ({ ok: false, error: { code: error, message: 'environment 无效' } }),
        },
      ),
      (c) => c.json(c.req.valid('param')),
    )

    const invalid = await app.request('/demo/..bad')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'environment 无效' },
    })

    const valid = await app.request('/demo/dev')
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ environment: 'dev' })
  })
})
