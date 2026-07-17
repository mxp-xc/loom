import { describe, expect, it } from 'vitest'
import type { McpServer } from '@loom/core'
import {
  buildMcpSettingsPreview,
  buildResolvedMcpServer,
  formatMcpTraceLayer,
  getMcpVariableTokens,
} from '../src/views/mcp/mcp-preview'
import type { AgentId } from '../src/lib/agents'
import type { VarsMatrixResponse } from '../src/lib/vars'

function matrix(agent: AgentId, overrides: Partial<VarsMatrixResponse['resolution']> = {}) {
  return {
    ok: true,
    agent,
    builtinKeys: ['LOOM_AGENT'],
    userKeys: ['browsers_path', 'workspace', 'json_blob'],
    snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
    resolution: {
      ok: true,
      values: {
        browsers_path: { type: 'string', value: `/preview/${agent}/browsers` },
        workspace: { type: 'string', value: `/repo/${agent}` },
        json_blob: { type: 'json', value: { nested: true } },
        LOOM_AGENT: { type: 'string', value: agent },
      },
      sources: {
        browsers_path: { locality: 'local', layer: 'agent', agent },
        workspace: { locality: 'synced', layer: 'base' },
        json_blob: { locality: 'synced', layer: 'base' },
        LOOM_AGENT: { locality: 'builtin', layer: 'runtime', agent },
      },
      overrideChains: {
        browsers_path: [
          { locality: 'synced', layer: 'base' },
          { locality: 'synced', layer: 'agent', agent },
          { locality: 'local', layer: 'local' },
          { locality: 'local', layer: 'agent', agent },
        ],
        workspace: [{ locality: 'synced', layer: 'base' }],
        LOOM_AGENT: [{ locality: 'builtin', layer: 'runtime', agent }],
      },
      dependencies: {},
      diagnostics: [],
      ...overrides,
    },
  } satisfies VarsMatrixResponse
}

describe('MCP preview model', () => {
  it('renders server fields with the selected agent vars without mutating agents', () => {
    const server: McpServer = {
      id: 'playwright',
      type: 'stdio',
      command: 'npx',
      args: ['${browsers_path}'],
      env: { PLAYWRIGHT_BROWSERS_PATH: '${browsers_path}', LOOM_AGENT: '${LOOM_AGENT}' },
      agents: ['codex'],
    }
    const preview = buildResolvedMcpServer(server, 'opencode', matrix('opencode'))
    expect(preview.server.args).toContain('/preview/opencode/browsers')
    expect(preview.server.env).toEqual({
      PLAYWRIGHT_BROWSERS_PATH: '/preview/opencode/browsers',
      LOOM_AGENT: 'opencode',
    })
    expect(server.agents).toEqual(['codex'])
    expect(preview.diagnostics).toEqual([])
  })

  it('formats CC/CX/OC settings preview with their real write shape', () => {
    const server: McpServer = {
      id: 'browser-tools',
      type: 'http',
      url: 'https://example.test/${workspace}',
      env: { REQUEST_TIMEOUT: '15s' },
      headers: { Authorization: 'Bearer ${LOOM_AGENT}' },
      agents: [],
    }
    const cc = buildMcpSettingsPreview(server, 'claude-code', matrix('claude-code')).text
    const cx = buildMcpSettingsPreview(server, 'codex', matrix('codex')).text
    const oc = buildMcpSettingsPreview(server, 'opencode', matrix('opencode')).text
    expect(cc).toContain('"mcpServers"')
    expect(cc).toContain('"browser-tools"')
    expect(cx).toContain('[mcp_servers.browser-tools]')
    expect(cx).toContain('url = "https://example.test//repo/codex"')
    expect(oc).toContain('"mcp"')
    expect(oc).toContain('Bearer opencode')
  })

  it('reports missing vars, unsupported defaults, and json text interpolation diagnostics', () => {
    const server: McpServer = {
      id: 'broken',
      type: 'stdio',
      command: 'node',
      args: ['${missing}', '${workspace:/tmp}', '${json_blob}'],
    }
    const preview = buildMcpSettingsPreview(server, 'codex', matrix('codex'))
    expect(preview.diagnostics.map((item) => item.code)).toEqual([
      'MISSING_REFERENCE',
      'UNSUPPORTED_DEFAULT',
      'JSON_TEXT_INTERPOLATION',
    ])
    expect(preview.text).toContain('${missing}')
  })

  it('keeps stdio headers out of preview and renders remote env/header as separate records', () => {
    const stdio: McpServer = {
      id: 'stdio-server',
      type: 'stdio',
      command: 'npx',
      headers: { Authorization: 'Bearer token' },
    }
    const remote: McpServer = {
      id: 'remote-server',
      type: 'sse',
      url: 'https://example.test/sse',
      env: { REQUEST_TIMEOUT: '15s' },
      headers: { Authorization: 'Bearer token' },
    }
    expect(buildResolvedMcpServer(stdio, 'codex', matrix('codex')).server.headers).toBeUndefined()
    expect(buildResolvedMcpServer(remote, 'codex', matrix('codex')).sections).toEqual([
      'transport',
      'env',
      'headers',
    ])
  })

  it('extracts clickable variable tokens and formats trace layers without mcp/vars internals', () => {
    expect(getMcpVariableTokens('run ${browsers_path} and \\${escaped}')).toEqual([
      { key: 'browsers_path', token: '${browsers_path}', start: 4, end: 20 },
    ])
    expect(formatMcpTraceLayer({ locality: 'synced', layer: 'base' })).toBe('Base')
    expect(formatMcpTraceLayer({ locality: 'synced', layer: 'agent', agent: 'codex' })).toBe(
      'Base / Codex',
    )
    expect(formatMcpTraceLayer({ locality: 'local', layer: 'local' })).toBe('Local')
    expect(formatMcpTraceLayer({ locality: 'local', layer: 'agent', agent: 'opencode' })).toBe(
      'Local / OpenCode',
    )
    expect(formatMcpTraceLayer({ locality: 'builtin', layer: 'runtime', agent: 'codex' })).toBe(
      'Runtime / Codex',
    )
  })
})
