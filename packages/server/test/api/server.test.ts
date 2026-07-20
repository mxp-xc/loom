import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createApp, startApiServer } from '../../src/api/server'

const routeDispose = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../src/lib/logger.js', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: async () => {},
    child: () => logger,
  }
  return { logger }
})

vi.mock('../../src/api/router.js', () => ({
  registerRoutes: () =>
    Object.assign(
      new Hono().get('/health', (c) => c.json({ ok: true })),
      {
        dispose: routeDispose,
      },
    ),
}))

let webuiDist: string
beforeEach(async () => {
  webuiDist = await mkdtemp(join(tmpdir(), 'webui-'))
  await writeFile(join(webuiDist, 'index.html'), '<html><body>SPA</body></html>')
  await mkdir(join(webuiDist, 'assets'), { recursive: true })
  await writeFile(join(webuiDist, 'assets', 'app.js'), 'console.log(1)')
  vi.stubEnv('LOOM_WEB_DIST', webuiDist)
})
afterEach(async () => {
  await rm(webuiDist, { recursive: true, force: true }).catch(() => {})
})

describe('createApp', () => {
  it('binds the API server to loopback explicitly', async () => {
    const close = vi.fn((callback: (error?: Error) => void) => callback())
    const serve = vi.fn(() => ({ close }))
    const server = await startApiServer(4321, serve as never)
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4321, hostname: '127.0.0.1' }),
      expect.any(Function),
    )
    const first = server.dispose()
    const second = server.dispose()
    expect(second).toBe(first)
    await first
    expect(close).toHaveBeenCalledTimes(1)
    expect(routeDispose).toHaveBeenCalledTimes(1)
  })
  it('GET /api/health returns ok', async () => {
    const res = await createApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('serves static asset from webui dist', async () => {
    const res = await createApp().request('/assets/app.js')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('console.log(1)')
  })
  it('SPA fallback: unknown non-api route returns index.html', async () => {
    const res = await createApp().request('/skills/frontend-design')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html')
  })
  it('api 404 returns json not index.html', async () => {
    const res = await createApp().request('/api/nonexistent')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
