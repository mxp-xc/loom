import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import yaml from 'js-yaml'
import { registerRoutes } from '../../src/api/router'

const logFns = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))

const files: Record<string, string> = {}

const memFs = {
  readFile: vi.fn(async (path: string) => {
    const normalized = path.replace(/\\/g, '/')
    if (!(normalized in files)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return files[normalized]
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files[path.replace(/\\/g, '/')] = content
  }),
  exists: vi.fn(async (path: string) => path.replace(/\\/g, '/') in files),
  mkdir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: vi.fn(() => logFns),
    error: logFns.error,
    warn: logFns.warn,
    info: logFns.info,
  },
}))

vi.mock('../../src/api/repo.js', () => ({
  resolveRepoPath: vi.fn(async (_fs: unknown, repo: string) => repo),
  listRepos: vi.fn(async () => []),
}))

function app() {
  return new Hono().route(
    '/api',
    registerRoutes({
      fs: memFs as never,
      git: {} as never,
      proc: {} as never,
      home: '/home/tester',
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(files)) delete files[key]
  vi.stubEnv('HOME', '/home/tester')
  vi.stubEnv('USERPROFILE', '/home/tester')
  vi.stubEnv('CODEX_HOME', '/home/tester/.codex')
  vi.stubEnv('OPENCODE_CONFIG_DIR', '/home/tester/.config/opencode')
})

describe('MCP import routes', () => {
  it('scans native agent configs without writing mcp.yaml', async () => {
    files['/home/tester/.codex/config.toml'] =
      '[mcp_servers.browser]\n' + 'transport = "http"\n' + 'url = "https://codex.example/mcp"\n'

    const res = await app().request('/api/mcp/import/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/repo', sources: ['codex'] }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      id: 'browser',
      finalId: 'browser',
      targets: ['codex'],
      status: 'ready',
      selectedByDefault: true,
      server: { id: 'browser', type: 'http', url: 'https://codex.example/mcp' },
    })
    expect(files['/repo/mcp.yaml']).toBeUndefined()
  })

  it('applies selected import keys and returns stale previews as conflicts', async () => {
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: { browser: { type: 'stdio', command: 'npx' } },
    })

    const scanRes = await app().request('/api/mcp/import/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/repo', sources: ['claude-code'] }),
    })
    const scan = await scanRes.json()

    const applyRes = await app().request('/api/mcp/import/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/repo', sources: ['claude-code'], keys: [scan.items[0].key] }),
    })

    expect(applyRes.status).toBe(200)
    expect(yaml.load(files['/repo/mcp.yaml'])).toEqual([
      { id: 'browser', type: 'stdio', command: 'npx', targets: ['claude-code'] },
    ])

    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: { browser: { type: 'stdio', command: 'node' } },
    })
    const staleRes = await app().request('/api/mcp/import/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/repo', sources: ['claude-code'], keys: [scan.items[0].key] }),
    })

    expect(staleRes.status).toBe(409)
    expect(await staleRes.json()).toMatchObject({
      ok: false,
      error: 'stale_import_preview',
      message: '导入预览已过期，请重新扫描',
    })
  })

  it('rejects invalid sources and logs the validation error', async () => {
    const res = await app().request('/api/mcp/import/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/repo', sources: ['bad-agent'] }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_sources' })
    expect(logFns.error).toHaveBeenCalledWith(
      'invalid MCP import sources',
      expect.objectContaining({ err: expect.any(Error), sources: ['bad-agent'] }),
    )
  })

  it('rejects invalid repository input before scanning imports', async () => {
    const res = await app().request('/api/mcp/import/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '', sources: ['codex'] }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_repo' })
    expect(logFns.error).toHaveBeenCalledWith(
      'invalid repository input for MCP import scan',
      expect.objectContaining({ err: expect.any(Error), repo: '' }),
    )
  })
})
