import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createApp } from '../../src/api/server'

vi.mock('../../src/api/router.js', () => ({
  registerRoutes: () => new Hono().get('/health', (c) => c.json({ ok: true })),
}))

let webuiDist: string
beforeEach(async () => {
  webuiDist = await mkdtemp(join(tmpdir(), 'webui-'))
  await writeFile(join(webuiDist, 'index.html'), '<html><body>SPA</body></html>')
  await mkdir(join(webuiDist, 'assets'), { recursive: true })
  await writeFile(join(webuiDist, 'assets', 'app.js'), 'console.log(1)')
  process.env.LOOM_WEB_DIST = webuiDist
})
afterEach(async () => {
  delete process.env.LOOM_WEB_DIST
  await rm(webuiDist, { recursive: true, force: true }).catch(() => {})
})

describe('createApp', () => {
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
