import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillsYamlRoutes } from '../../src/api/routes/skills-yaml.js'
import { createMcpYamlRoutes } from '../../src/api/routes/mcp-yaml.js'
import { createMcpImportRoutes } from '../../src/api/routes/mcp-import.js'
import {
  createMcpDebugRoutes,
  type McpDebugSessionManagerLike,
} from '../../src/api/routes/mcp-debug.js'
import { SkillsApplication, SkillsApplicationError } from '../../src/skills/application.js'
import { McpApplication, McpApplicationError } from '../../src/mcp/application.js'
import { McpDebugSessionError } from '../../src/mcp/debug-session.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { validationError } from '../helpers/http.js'

const logFns = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))

const importMocks = vi.hoisted(() => ({
  scan: vi.fn(),
  apply: vi.fn(),
}))

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: vi.fn(() => logFns),
    error: logFns.error,
    warn: logFns.warn,
    info: logFns.info,
  },
}))

vi.mock('../../src/mcp/importer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/importer.js')>()
  return {
    ...actual,
    scanMcpImports: importMocks.scan,
    applyMcpImports: importMocks.apply,
  }
})

let home: string
let repoPath: string
let fs: NodeFileSystem

beforeEach(() => {
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), 'loom-b2-api-contract-'))
  repoPath = join(home, '.loom', 'repos', 'default')
  mkdirSync(repoPath, { recursive: true })
  fs = new NodeFileSystem()
  importMocks.scan.mockResolvedValue({ ok: true, items: [], sources: [], existing: { count: 0 } })
  importMocks.apply.mockResolvedValue({
    ok: true,
    imported: 0,
    renamed: 0,
    ignoredFields: 0,
    entries: [],
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function deps() {
  return { fs, git: {} as never, proc: {} as never, home }
}

function request(app: Hono, path: string, method: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function expectLoggedOnce(message: string, error: Error) {
  expect(logFns.error).toHaveBeenCalledTimes(1)
  expect(logFns.error).toHaveBeenCalledWith(message, expect.objectContaining({ err: error }))
}

describe('Skills route failure contract', () => {
  function app() {
    return new Hono().route('/api', createSkillsYamlRoutes(deps()))
  }

  it('returns validation failures as HTTP 400 before calling the application', async () => {
    const add = vi.spyOn(SkillsApplication.prototype, 'addLocalSkill')
    const response = await request(app(), '/api/skills/local', 'POST', {
      repo: 'default',
      skill: { id: '../invalid' },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(validationError('invalid_skill'))
    expect(add).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'not found',
      method: 'removeSource',
      path: '/api/sources',
      httpMethod: 'DELETE',
      body: { repo: 'default', url: 'https://example.test/missing.git' },
      error: new SkillsApplicationError(404, 'not_found', 'secret source path'),
      status: 404,
      code: 'not_found',
      message: 'Skill or source not found',
      logMessage: 'source removal failed',
    },
    {
      label: 'collision',
      method: 'addSource',
      path: '/api/sources',
      httpMethod: 'POST',
      body: { repo: 'default', url: 'https://example.test/source.git', ref: 'main' },
      error: new SkillsApplicationError(409, 'source_name_exists', 'secret source name'),
      status: 409,
      code: 'source_name_exists',
      message: 'Skills state conflict',
      logMessage: 'source add failed',
    },
    {
      label: 'invalid persisted manifest',
      method: 'reorderGroups',
      path: '/api/skills/order',
      httpMethod: 'PUT',
      body: { repo: 'default', ids: [] },
      error: new SkillsApplicationError(422, 'invalid_skills_manifest', 'secret YAML payload'),
      status: 422,
      code: 'invalid_skills_manifest',
      message: 'Skills configuration is invalid',
      logMessage: 'skill group reorder failed',
    },
  ])(
    'maps $label without exposing the domain error message',
    async ({ method, path, httpMethod, body, error, status, code, message, logMessage }) => {
      vi.spyOn(SkillsApplication.prototype as never, method as never).mockRejectedValueOnce(error)

      const response = await request(app(), path, httpMethod, body)
      const result = await response.json()

      expect(response.status).toBe(status)
      expect(result).toEqual({ ok: false, error: code, message })
      expect(JSON.stringify(result)).not.toContain('secret')
      expectLoggedOnce(logMessage, error)
    },
  )

  it('maps unexpected failures to a safe HTTP 500 response', async () => {
    const error = new Error(`secret scan failure at ${repoPath}`)
    vi.spyOn(SkillsApplication.prototype, 'scanLocalSkills').mockRejectedValueOnce(error)

    const response = await request(app(), '/api/skills/local/scan', 'POST', {
      dir: '/input/skills',
    })
    const result = await response.json()

    expect(response.status).toBe(500)
    expect(result).toEqual({
      ok: false,
      error: 'scan_failed',
      message: 'Failed to scan local skills',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expectLoggedOnce('local skill scan failed', error)
  })

  it('maps malformed persisted skills YAML to HTTP 422', async () => {
    writeFileSync(join(repoPath, 'skills.yaml'), 'sources: [\n')

    const response = await request(app(), '/api/skills/order', 'PUT', {
      repo: 'default',
      ids: [],
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_skills_manifest',
      message: 'Skills configuration is invalid',
    })
  })
})

describe('MCP route failure contract', () => {
  function app() {
    return new Hono().route('/api', createMcpYamlRoutes(deps()))
  }

  it('returns validation failures as HTTP 400 before calling the application', async () => {
    const add = vi.spyOn(McpApplication.prototype, 'addServer')
    const response = await request(app(), '/api/mcp', 'POST', {
      repo: 'default',
      server: { id: 'broken', type: 'stdio' },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(validationError('invalid_server'))
    expect(add).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'not found',
      method: 'removeServer',
      path: '/api/mcp',
      httpMethod: 'DELETE',
      body: { repo: 'default', id: 'missing' },
      error: new McpApplicationError(404, 'not_found', 'secret MCP id'),
      status: 404,
      code: 'not_found',
      message: 'MCP server not found',
      logMessage: 'MCP server removal failed',
    },
    {
      label: 'collision',
      method: 'addServer',
      path: '/api/mcp',
      httpMethod: 'POST',
      body: { repo: 'default', server: { id: 'duplicate', type: 'stdio', command: 'echo' } },
      error: new McpApplicationError(409, 'duplicate_mcp_id', 'secret duplicate id'),
      status: 409,
      code: 'duplicate_mcp_id',
      message: 'MCP state conflict',
      logMessage: 'MCP server add failed',
    },
    {
      label: 'invalid persisted manifest',
      method: 'reorderServers',
      path: '/api/mcp/order',
      httpMethod: 'PUT',
      body: { repo: 'default', ids: [] },
      error: new McpApplicationError(422, 'invalid_mcp_manifest', 'secret YAML payload'),
      status: 422,
      code: 'invalid_mcp_manifest',
      message: 'MCP configuration is invalid',
      logMessage: 'MCP server reorder failed',
    },
  ])(
    'maps $label without exposing the domain error message',
    async ({ method, path, httpMethod, body, error, status, code, message, logMessage }) => {
      vi.spyOn(McpApplication.prototype as never, method as never).mockRejectedValueOnce(error)

      const response = await request(app(), path, httpMethod, body)
      const result = await response.json()

      expect(response.status).toBe(status)
      expect(result).toEqual({ ok: false, error: code, message })
      expect(JSON.stringify(result)).not.toContain('secret')
      expectLoggedOnce(logMessage, error)
    },
  )

  it('maps unexpected failures to a safe HTTP 500 response', async () => {
    const error = new Error(`secret MCP failure at ${repoPath}`)
    vi.spyOn(McpApplication.prototype, 'setAgents').mockRejectedValueOnce(error)

    const response = await request(app(), '/api/mcp/agents', 'POST', {
      repo: 'default',
      id: 'server',
      agents: ['codex'],
    })
    const result = await response.json()

    expect(response.status).toBe(500)
    expect(result).toEqual({
      ok: false,
      error: 'update_failed',
      message: 'Failed to update MCP agents',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expectLoggedOnce('MCP agent update failed', error)
  })

  it('maps malformed persisted MCP YAML to HTTP 422', async () => {
    writeFileSync(join(repoPath, 'mcp.yaml'), '[\n')

    const response = await request(app(), '/api/mcp/order', 'PUT', {
      repo: 'default',
      ids: [],
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_mcp_manifest',
      message: 'MCP configuration is invalid',
    })
  })
})

describe('MCP import route failure contract', () => {
  function app() {
    return new Hono().route('/api', createMcpImportRoutes(deps()))
  }

  it('returns malformed JSON as a logged HTTP 400 validation failure', async () => {
    const response = await request(app(), '/api/mcp/import/scan', 'POST', '{')
    const result = await response.json()

    expect(response.status).toBe(400)
    expect(result).toEqual({
      ok: false,
      error: 'invalid_request',
      message: 'Invalid MCP import request',
    })
    expect(logFns.error).toHaveBeenCalledWith(
      'invalid MCP import JSON for scan',
      expect.objectContaining({ err: expect.any(Error) }),
    )
    expect(importMocks.scan).not.toHaveBeenCalled()
  })

  it('returns malformed persisted config as HTTP 422', async () => {
    writeFileSync(join(repoPath, 'config.yaml'), 'scalar\n')

    const response = await request(app(), '/api/mcp/import/scan', 'POST', { repo: 'default' })
    const result = await response.json()

    expect(response.status).toBe(422)
    expect(result).toEqual({
      ok: false,
      error: 'invalid_config',
      message: 'MCP import configuration is invalid',
    })
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expect(logFns.error).toHaveBeenCalledWith(
      'invalid repository config for MCP import scan',
      expect.objectContaining({ err: expect.any(Error) }),
    )
    expect(importMocks.scan).not.toHaveBeenCalled()
  })

  it('returns malformed persisted config YAML as HTTP 422', async () => {
    writeFileSync(join(repoPath, 'config.yaml'), 'agents: [\n')

    const response = await request(app(), '/api/mcp/import/scan', 'POST', { repo: 'default' })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_config',
      message: 'MCP import configuration is invalid',
    })
    expect(importMocks.scan).not.toHaveBeenCalled()
  })

  it('returns stale previews as a logged HTTP 409 conflict', async () => {
    importMocks.apply.mockResolvedValueOnce({
      ok: false,
      error: 'stale_import_preview',
      message: `secret stale path ${repoPath}`,
    })

    const response = await request(app(), '/api/mcp/import/apply', 'POST', {
      repo: 'default',
      sources: ['codex'],
      keys: ['stale-key'],
    })
    const result = await response.json()

    expect(response.status).toBe(409)
    expect(result).toEqual({
      ok: false,
      error: 'stale_import_preview',
      message: '导入预览已过期，请重新扫描',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expect(logFns.error).toHaveBeenCalledWith(
      'stale MCP import preview',
      expect.objectContaining({ err: expect.any(Error) }),
    )
  })

  it('maps unexpected import failures to a safe HTTP 500 response', async () => {
    const error = new Error(`secret import failure at ${repoPath}`)
    importMocks.scan.mockRejectedValueOnce(error)

    const response = await request(app(), '/api/mcp/import/scan', 'POST', {
      repo: 'default',
      sources: ['codex'],
    })
    const result = await response.json()

    expect(response.status).toBe(500)
    expect(result).toEqual({
      ok: false,
      error: 'scan_failed',
      message: 'Failed to scan MCP imports',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expectLoggedOnce('MCP import scan failed', error)
  })
})

describe('MCP debug route failure contract', () => {
  function debugManager(): McpDebugSessionManagerLike {
    return {
      createSession: vi.fn(async (input) => ({
        sessionId: 'debug-1',
        source: input.source,
        serverFingerprint: 'fingerprint',
        previewAgent: input.previewAgent,
        tools: [],
        createdAt: '2026-07-19T00:00:00.000Z',
        idleExpiresAt: '2026-07-19T00:05:00.000Z',
        hardExpiresAt: '2026-07-19T00:30:00.000Z',
      })),
      callTool: vi.fn(async () => ({
        ok: true as const,
        result: {},
        durationMs: 1,
        calledAt: '2026-07-19T00:00:01.000Z',
        idleExpiresAt: '2026-07-19T00:05:01.000Z',
      })),
      disconnect: vi.fn(async () => undefined),
    }
  }

  function app(manager: McpDebugSessionManagerLike) {
    return new Hono().route('/api', createMcpDebugRoutes({ ...deps(), mcpDebug: manager }))
  }

  function draftBody() {
    return {
      repo: 'default',
      source: 'draft',
      previewAgent: 'codex',
      draft: { id: 'debug', type: 'stdio', command: 'echo' },
    }
  }

  it('maps missing saved servers to HTTP 404', async () => {
    const manager = debugManager()
    const response = await request(app(manager), '/api/mcp/debug/sessions', 'POST', {
      repo: 'default',
      source: 'saved',
      serverId: 'missing',
      previewAgent: 'codex',
    })
    const result = await response.json()

    expect(response.status).toBe(404)
    expect(result).toEqual({ ok: false, error: 'not_found', message: 'MCP server not found' })
    expect(manager.createSession).not.toHaveBeenCalled()
    expect(logFns.error).toHaveBeenCalledWith(
      'MCP debug session create failed',
      expect.objectContaining({ err: expect.any(Error) }),
    )
  })

  it('maps malformed persisted MCP config to HTTP 422', async () => {
    writeFileSync(join(repoPath, 'mcp.yaml'), 'servers: []\n')
    const manager = debugManager()

    const response = await request(app(manager), '/api/mcp/debug/sessions', 'POST', {
      repo: 'default',
      source: 'saved',
      serverId: 'missing',
      previewAgent: 'codex',
    })
    const result = await response.json()

    expect(response.status).toBe(422)
    expect(result).toEqual({
      ok: false,
      error: 'invalid_mcp_yaml',
      message: 'MCP configuration is invalid',
    })
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expect(manager.createSession).not.toHaveBeenCalled()
  })

  it('maps malformed persisted MCP YAML to HTTP 422', async () => {
    writeFileSync(join(repoPath, 'mcp.yaml'), '[\n')
    const manager = debugManager()

    const response = await request(app(manager), '/api/mcp/debug/sessions', 'POST', {
      repo: 'default',
      source: 'saved',
      serverId: 'missing',
      previewAgent: 'codex',
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_mcp_yaml',
      message: 'MCP configuration is invalid',
    })
    expect(manager.createSession).not.toHaveBeenCalled()
  })

  it.each([
    ['too_many_sessions', 409, 'too_many_sessions', 'MCP debug session capacity reached'],
    ['connect_failed', 500, 'connect_failed', 'MCP connection failed'],
    ['list_tools_failed', 500, 'list_tools_failed', 'Failed to list MCP tools'],
    ['unknown_lifecycle', 500, 'debug_failed', 'MCP debug operation failed'],
  ] as const)(
    'maps session lifecycle error %s without trusting its default status',
    async (sessionCode, status, responseCode, message) => {
      const manager = debugManager()
      const error = new McpDebugSessionError(
        sessionCode as ConstructorParameters<typeof McpDebugSessionError>[0],
        `secret lifecycle failure at ${repoPath}`,
      )
      vi.mocked(manager.createSession).mockRejectedValueOnce(error)

      const response = await request(app(manager), '/api/mcp/debug/sessions', 'POST', draftBody())
      const result = await response.json()

      expect(response.status).toBe(status)
      expect(result).toEqual({ ok: false, error: responseCode, message })
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain(repoPath)
      expectLoggedOnce('MCP debug session create failed', error)
    },
  )

  it.each([
    ['session_expired', 404, 'session_expired', 'MCP debug session not found'],
    ['tool_call_failed', 500, 'tool_call_failed', 'MCP tool call failed'],
  ] as const)(
    'maps tool/session error %s to its typed HTTP status',
    async (sessionCode, status, responseCode, message) => {
      const manager = debugManager()
      const error = new McpDebugSessionError(
        sessionCode,
        `secret tool failure at ${repoPath}`,
        sessionCode === 'tool_call_failed' ? 12 : undefined,
      )
      vi.mocked(manager.callTool).mockRejectedValueOnce(error)

      const response = await request(
        app(manager),
        '/api/mcp/debug/sessions/debug-1/tools/call',
        'POST',
        { toolName: 'capture', arguments: {} },
      )
      const result = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(status)
      expect(result).toMatchObject({ ok: false, error: responseCode, message })
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain(repoPath)
      expectLoggedOnce('MCP debug tool call failed', error)
    },
  )

  it('maps unexpected disconnect failures to a safe HTTP 500 response', async () => {
    const manager = debugManager()
    const error = new Error(`secret disconnect failure at ${repoPath}`)
    vi.mocked(manager.disconnect).mockRejectedValueOnce(error)

    const response = await app(manager).request('/api/mcp/debug/sessions/debug-1', {
      method: 'DELETE',
    })
    const result = await response.json()

    expect(response.status).toBe(500)
    expect(result).toEqual({
      ok: false,
      error: 'debug_failed',
      message: 'MCP debug operation failed',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(repoPath)
    expectLoggedOnce('MCP debug disconnect failed', error)
  })
})
