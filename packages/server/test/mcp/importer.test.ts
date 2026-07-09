import { beforeEach, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { applyMcpImports, scanMcpImports, type McpImportScanResult } from '../../src/mcp/importer'
import type { IFileSystem } from '../../src/ports/fs'

const files: Record<string, string> = {}

const fs = {
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
} as Partial<IFileSystem> as IFileSystem

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(files)) delete files[key]
  vi.stubEnv('HOME', '/home/tester')
  vi.stubEnv('USERPROFILE', '/home/tester')
  vi.stubEnv('CODEX_HOME', '/home/tester/.codex')
  vi.stubEnv('OPENCODE_CONFIG_DIR', '/home/tester/.config/opencode')
})

describe('scanMcpImports', () => {
  it('merges same definitions by source targets and renames conflicting definitions', async () => {
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: {
        browser: {
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp'],
          description: 'ignored by loom',
        },
      },
    })
    files['/home/tester/.codex/config.toml'] =
      '[mcp_servers.browser]\n' +
      'transport = "http"\n' +
      'url = "https://codex.example/mcp"\n' +
      'description = "ignored by loom"\n'
    files['/home/tester/.config/opencode/opencode.json'] = JSON.stringify({
      mcp: {
        browser: {
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp'],
        },
      },
    })

    const result = await scanMcpImports({ fs, repoPath: '/repo', logger })

    expect(result.ok).toBe(true)
    expect(result.sources.map((source) => [source.agent, source.status])).toEqual([
      ['claude-code', 'ready'],
      ['codex', 'ready'],
      ['opencode', 'ready'],
    ])
    expect(simplifyItems(result)).toEqual([
      {
        id: 'browser',
        finalId: 'browser',
        sourceAgents: ['claude-code', 'opencode'],
        targets: ['claude-code', 'opencode'],
        status: 'ready',
        selectedByDefault: true,
        type: 'stdio',
        command: 'npx',
        url: undefined,
      },
      {
        id: 'browser',
        finalId: 'browser-cx',
        sourceAgents: ['codex'],
        targets: ['codex'],
        status: 'renamed',
        selectedByDefault: true,
        type: 'http',
        command: undefined,
        url: 'https://codex.example/mcp',
      },
    ])
    expect(result.items[0].ignoredFields).toContain('mcpServers.browser.description')
    expect(result.items[1].ignoredFields).toContain('mcp_servers.browser.description')
  })

  it('keeps existing desired entries and reports missing or broken sources without aborting scan', async () => {
    files['/repo/mcp.yaml'] = yaml.dump([
      { id: 'browser', type: 'stdio', command: 'npx', targets: ['codex'] },
      { id: 'remote', type: 'http', url: 'https://existing.example/mcp' },
    ])
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: {
        browser: { type: 'stdio', command: 'npx' },
        remote: { type: 'sse', url: 'https://claude.example/sse' },
      },
    })
    files['/home/tester/.codex/config.toml'] = 'not = [valid'

    const result = await scanMcpImports({ fs, repoPath: '/repo', logger })

    expect(result.sources.map((source) => [source.agent, source.status])).toEqual([
      ['claude-code', 'ready'],
      ['codex', 'parse_failed'],
      ['opencode', 'missing_file'],
    ])
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), source: 'codex' }),
      'MCP import scan failed',
    )
    expect(simplifyItems(result)).toEqual([
      {
        id: 'browser',
        finalId: 'browser',
        sourceAgents: ['claude-code'],
        targets: ['claude-code'],
        status: 'ready',
        selectedByDefault: true,
        type: 'stdio',
        command: 'npx',
        url: undefined,
      },
      {
        id: 'remote',
        finalId: 'remote-cc',
        sourceAgents: ['claude-code'],
        targets: ['claude-code'],
        status: 'renamed',
        selectedByDefault: true,
        type: 'sse',
        command: undefined,
        url: 'https://claude.example/sse',
      },
    ])
  })

  it('disables entries with unsupported transports or missing required connection fields', async () => {
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: {
        websocket: { type: 'ws', url: 'wss://example.test' },
        noCommand: { type: 'stdio' },
      },
    })

    const result = await scanMcpImports({
      fs,
      repoPath: '/repo',
      sources: ['claude-code'],
      logger,
    })

    expect(result.items).toHaveLength(2)
    expect(result.items.every((item) => item.status === 'disabled')).toBe(true)
    expect(result.items.every((item) => item.selectedByDefault === false)).toBe(true)
    expect(result.items.flatMap((item) => item.diagnostics.map((diag) => diag.code))).toEqual([
      'unsupported_transport',
      'missing_command',
    ])
  })
})

describe('applyMcpImports', () => {
  it('writes selected import keys into mcp.yaml without modifying agent-native files', async () => {
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: { browser: { type: 'stdio', command: 'npx' } },
    })
    const nativeBefore = files['/home/tester/.claude.json']
    const scan = await scanMcpImports({
      fs,
      repoPath: '/repo',
      sources: ['claude-code'],
      logger,
    })

    const result = await applyMcpImports({
      fs,
      repoPath: '/repo',
      sources: ['claude-code'],
      keys: [scan.items[0].key],
      logger,
    })

    expect(result).toMatchObject({ ok: true, imported: 1, renamed: 0, ignoredFields: 0 })
    expect(files['/home/tester/.claude.json']).toBe(nativeBefore)
    expect(yaml.load(files['/repo/mcp.yaml'])).toEqual([
      { id: 'browser', type: 'stdio', command: 'npx', targets: ['claude-code'] },
    ])
  })

  it('returns stale_import_preview when selected keys no longer match the latest scan', async () => {
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: { browser: { type: 'stdio', command: 'npx' } },
    })
    const scan = await scanMcpImports({
      fs,
      repoPath: '/repo',
      sources: ['claude-code'],
      logger,
    })
    files['/home/tester/.claude.json'] = JSON.stringify({
      mcpServers: { browser: { type: 'stdio', command: 'node' } },
    })

    const result = await applyMcpImports({
      fs,
      repoPath: '/repo',
      sources: ['claude-code'],
      keys: [scan.items[0].key],
      logger,
    })

    expect(result).toEqual({
      ok: false,
      error: 'stale_import_preview',
      message: '导入预览已过期，请重新扫描',
    })
    expect(files['/repo/mcp.yaml']).toBeUndefined()
  })
})

function simplifyItems(result: McpImportScanResult) {
  return result.items.map((item) => ({
    id: item.id,
    finalId: item.finalId,
    sourceAgents: item.sourceAgents,
    targets: item.targets,
    status: item.status,
    selectedByDefault: item.selectedByDefault,
    type: item.server?.type,
    command: item.server?.command,
    url: item.server?.url,
  }))
}
