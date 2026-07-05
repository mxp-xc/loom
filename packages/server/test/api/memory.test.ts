import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/router.js'

describe('memory routes', () => {
  let home: string
  let app: Hono

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-mem-'))
    mkdirSync(join(home, '.loom', 'repos', 'default', 'memories'), { recursive: true })
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), '')
    process.env.HOME = home
    app = new Hono().route('/api', registerRoutes())
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })

  it('GET /memory lists memories + active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), '# v1')
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'memories', 'v2.md'),
      '# v2 ${LOOM_AGENT}',
    )
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v2\n')
    const res = await req('GET', '/api/memory?repo=default')
    const j = await res.json()
    expect(j.memories.map((m: any) => m.name).sort()).toEqual(['v1', 'v2'])
    expect(j.active).toBe('v2')
    expect(j.activeContent).toContain('${LOOM_AGENT}')
  })

  it('GET /memory?name= returns single memory raw content', async () => {
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'),
      '# raw ${LOOM_AGENT}',
    )
    const res = await req('GET', '/api/memory?repo=default&name=v1')
    const j = await res.json()
    expect(j.content).toBe('# raw ${LOOM_AGENT}')
  })

  it('POST /memory creates new memory', async () => {
    const res = await req('POST', '/api/memory', { repo: 'default', name: 'v3' })
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v3.md'), 'utf8')).toBe(
      '',
    )
  })

  it('POST /memory rejects duplicate name (409)', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    const res = await req('POST', '/api/memory', { repo: 'default', name: 'v1' })
    expect(res.status).toBe(409)
  })

  it('POST /memory rejects path-traversal name', async () => {
    const res = await req('POST', '/api/memory', { repo: 'default', name: '../etc' })
    expect(res.status).toBe(400)
  })

  it('PUT /memory/content writes content', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'old')
    await req('PUT', '/api/memory/content', { repo: 'default', name: 'v1', content: 'new content' })
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'utf8')).toBe(
      'new content',
    )
  })

  it('POST /memory/active sets active_memory in config.yaml', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    await req('POST', '/api/memory/active', { repo: 'default', name: 'v1' })
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).toContain('active_memory: v1')
  })

  it('DELETE /memory removes file + clears active if active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    await req('DELETE', '/api/memory?repo=default&name=v1')
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).not.toContain('active_memory: v1')
  })

  it('POST /memory/rename renames + syncs active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'content')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    await req('POST', '/api/memory/rename', { repo: 'default', name: 'v1', newName: 'v2' })
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v2.md'), 'utf8')).toBe(
      'content',
    )
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).toContain('active_memory: v2')
  })

  it('POST /memory/preview renders ${VAR} for agent', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
    const res = await req('POST', '/api/memory/preview', {
      repo: 'default',
      content: 'agent=${LOOM_AGENT} file=${LOOM_AGENT_FILE}',
      agent: 'claude-code',
    })
    const j = await res.json()
    expect(j.rendered).toBe('agent=claude-code file=CLAUDE.md')
    delete process.env.CLAUDE_CONFIG_DIR
  })
})
