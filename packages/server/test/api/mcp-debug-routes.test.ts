import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import yaml from 'js-yaml'
import { registerRoutes } from '../../src/api/router'
import type { McpDebugSessionManagerLike } from '../../src/api/routes/mcp-debug.js'

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
  mkdir: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  isLink: vi.fn(async () => false),
  copyDir: vi.fn(async () => undefined),
  move: vi.fn(async () => undefined),
  removeDir: vi.fn(async () => undefined),
  replaceFile: vi.fn(async () => undefined),
  removeFile: vi.fn(async () => undefined),
  realPath: vi.fn(async (path: string) => path),
  createLink: vi.fn(async () => ({ fallback: null })),
  removeLink: vi.fn(async () => undefined),
}

const debugManager = {
  createSession: vi.fn(async (input: { previewAgent: 'default' | 'codex' }) => ({
    sessionId: 'debug-1',
    source: 'saved',
    serverFingerprint: 'abc123',
    previewAgent: input.previewAgent,
    tools: [{ name: 'capture_live_filter', inputSchema: { type: 'object' } }],
    createdAt: '2026-07-13T00:00:00.000Z',
    idleExpiresAt: '2026-07-13T00:05:00.000Z',
    hardExpiresAt: '2026-07-13T00:30:00.000Z',
  })),
  callTool: vi.fn(async () => ({
    ok: true,
    result: { content: [{ type: 'text', text: 'ok' }] },
    durationMs: 12,
    calledAt: '2026-07-13T00:00:01.000Z',
    idleExpiresAt: '2026-07-13T00:05:01.000Z',
  })),
  disconnect: vi.fn(async () => undefined),
} satisfies McpDebugSessionManagerLike

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
      mcpDebug: debugManager,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(files)) delete files[key]
  files['/repo/mcp.yaml'] = yaml.dump([
    { id: 'reqable', type: 'stdio', command: 'mcp-server', args: ['--debug'] },
  ])
})

describe('MCP debug routes', () => {
  it('creates a saved-server debug session from mcp.yaml without writing desired state', async () => {
    const res = await app().request('/api/mcp/debug/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/repo',
        source: 'saved',
        serverId: 'reqable',
        previewAgent: 'codex',
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      sessionId: 'debug-1',
      tools: [{ name: 'capture_live_filter' }],
    })
    expect(debugManager.createSession).toHaveBeenCalledWith({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'reqable', type: 'stdio', command: 'mcp-server', args: ['--debug'] },
    })
    expect(memFs.writeFile).not.toHaveBeenCalled()
  })

  it('creates a draft debug session from the request body', async () => {
    const res = await app().request('/api/mcp/debug/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/repo',
        source: 'draft',
        previewAgent: 'codex',
        draft: { id: 'draft-browser', type: 'http', url: 'https://example.test/mcp' },
      }),
    })

    expect(res.status).toBe(200)
    expect(debugManager.createSession).toHaveBeenCalledWith({
      source: 'draft',
      previewAgent: 'codex',
      server: { id: 'draft-browser', type: 'http', url: 'https://example.test/mcp' },
    })
  })

  it('resolves an unmasked saved secret for a default-context debug session', async () => {
    files['/repo/mcp.yaml'] = yaml.dump([
      { id: 'default-server', type: 'stdio', command: '${command}' },
    ])
    files['/repo/vars/base.yaml'] = 'command:\n  type: secret\n  value: base-command\n'
    files['/home/tester/.loom/local/repos/repo/vars/local.yaml'] =
      'command:\n  value: local-command\n'
    files['/repo/vars/agents/codex.yaml'] = 'command:\n  value: codex-command\n'

    const res = await app().request('/api/mcp/debug/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: '/repo',
        source: 'saved',
        serverId: 'default-server',
        previewAgent: 'default',
      }),
    })

    expect(res.status).toBe(200)
    expect(debugManager.createSession).toHaveBeenCalledWith({
      source: 'saved',
      previewAgent: 'default',
      server: { id: 'default-server', type: 'stdio', command: 'local-command' },
    })
  })

  it('calls tools and disconnects sessions through the manager', async () => {
    const callRes = await app().request('/api/mcp/debug/sessions/debug-1/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'capture_live_filter', arguments: { pattern: 'mcp' } }),
    })
    const deleteRes = await app().request('/api/mcp/debug/sessions/debug-1', {
      method: 'DELETE',
    })

    expect(callRes.status).toBe(200)
    expect(await callRes.json()).toMatchObject({ ok: true, durationMs: 12 })
    expect(debugManager.callTool).toHaveBeenCalledWith('debug-1', {
      toolName: 'capture_live_filter',
      arguments: { pattern: 'mcp' },
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ ok: true })
    expect(debugManager.disconnect).toHaveBeenCalledWith('debug-1')
  })
})
