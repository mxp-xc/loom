// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Mcp from '../src/views/Mcp'
import { api } from '../src/lib/api'
import { createMonacoEditorMock } from './monaco-test-utils'

const monacoEditorMock = createMonacoEditorMock()

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

vi.mock('../src/lib/api', () => ({
  api: {
    project: vi.fn(async () => ({ ok: true })),
    addMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpTargets: vi.fn(async () => ({ ok: true })),
    deleteMcpServer: vi.fn(async () => ({ ok: true })),
    scanMcpImports: vi.fn(async () => ({
      ok: true,
      sources: [
        { agent: 'claude-code', status: 'ready', diagnostics: [] },
        { agent: 'codex', status: 'ready', diagnostics: [] },
        { agent: 'opencode', status: 'missing_file', diagnostics: [] },
      ],
      items: [
        {
          key: 'ready-key',
          id: 'browser',
          finalId: 'browser',
          server: { id: 'browser', type: 'stdio', command: 'npx' },
          sourceAgents: ['claude-code'],
          targets: ['claude-code'],
          status: 'ready',
          selectedByDefault: true,
          ignoredFields: [],
          diagnostics: [],
        },
        {
          key: 'renamed-key',
          id: 'browser',
          finalId: 'browser-cx',
          server: { id: 'browser-cx', type: 'http', url: 'https://codex.example/mcp' },
          sourceAgents: ['codex'],
          targets: ['codex'],
          status: 'renamed',
          selectedByDefault: true,
          ignoredFields: ['mcp_servers.browser.description'],
          diagnostics: [],
        },
        {
          key: 'disabled-key',
          id: 'broken',
          finalId: 'broken',
          sourceAgents: ['claude-code'],
          targets: ['claude-code'],
          status: 'disabled',
          selectedByDefault: false,
          ignoredFields: [],
          diagnostics: [{ code: 'missing_command', message: 'stdio MCP server 缺少 command' }],
        },
      ],
      existing: { count: 2 },
    })),
    applyMcpImports: vi.fn(async () => ({
      ok: true,
      imported: 2,
      renamed: 1,
      ignoredFields: 1,
      entries: [],
    })),
    createMcpDebugSession: vi.fn(async () => ({
      ok: true,
      sessionId: 'debug-1',
      source: 'saved',
      serverFingerprint: 'fingerprint-1',
      previewTarget: 'codex',
      tools: [
        {
          name: 'capture_live_filter',
          description: 'Filter current Reqable live capture records',
          inputSchema: {
            type: 'object',
            required: ['pattern'],
            properties: {
              pattern: { type: 'string', default: 'mcp' },
              caseSensitive: { type: 'boolean' },
            },
          },
        },
      ],
      createdAt: '2026-07-13T00:00:00.000Z',
      idleExpiresAt: '2026-07-13T00:05:00.000Z',
      hardExpiresAt: '2026-07-13T00:30:00.000Z',
    })),
    callMcpDebugTool: vi.fn(async () => ({
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
      durationMs: 12,
      calledAt: '2026-07-13T00:00:01.000Z',
      idleExpiresAt: '2026-07-13T00:05:01.000Z',
    })),
    disconnectMcpDebugSession: vi.fn(async () => ({ ok: true })),
    getManifest: vi.fn(async () => ({
      skills: { sources: [], skills: [] },
      mcp: [
        {
          id: 'playwright',
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp', '--browser-path', '${browsers_path}'],
          env: { PLAYWRIGHT_BROWSERS_PATH: '${browsers_path}' },
          targets: ['codex'],
        },
        {
          id: 'remote-auth',
          type: 'sse',
          url: 'https://example.test/${workspace}/sse',
          env: { REQUEST_TIMEOUT: '15s' },
          headers: { Authorization: 'Bearer ${token}' },
          targets: [],
        },
      ],
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code', 'codex', 'opencode'] },
      errors: [],
    })),
    vars: {
      getMatrix: vi.fn(async (_repo: string, agent: string) => ({
        ok: true,
        agent,
        builtinKeys: ['LOOM_AGENT'],
        userKeys: ['browsers_path', 'workspace', 'token'],
        snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
        resolution: {
          ok: true,
          values: {
            browsers_path: { type: 'string', value: `/preview/${agent}/browsers` },
            workspace: { type: 'string', value: `repo-${agent}` },
            token: { type: 'secret', value: '••••••••', masked: true },
            LOOM_AGENT: { type: 'string', value: agent },
          },
          sources: {
            browsers_path: { locality: 'local', layer: 'agent', agent },
            workspace: { locality: 'synced', layer: 'base' },
            token: { locality: 'local', layer: 'local' },
          },
          overrideChains: {
            browsers_path: [
              { locality: 'synced', layer: 'base' },
              { locality: 'synced', layer: 'agent', agent },
              { locality: 'local', layer: 'local' },
              { locality: 'local', layer: 'agent', agent },
            ],
            workspace: [{ locality: 'synced', layer: 'base' }],
            token: [{ locality: 'local', layer: 'local' }],
          },
          dependencies: {},
          diagnostics: [],
        },
      })),
    },
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  monacoEditorMock.reset()
})

describe('MCP workbench view', () => {
  it('keeps global targets and icon-only actions inside inventory', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    const workbench = await screen.findByRole('region', { name: 'MCP workbench' })
    const inventory = within(workbench).getByRole('complementary', { name: 'MCP inventory' })

    expect(within(inventory).queryByText(/configured/)).toBeNull()
    expect(
      inventory.contains(within(inventory).getByRole('region', { name: '全局 MCP targets' })),
    ).toBe(true)
    expect(within(inventory).queryByText('全部 servers')).toBeNull()
    expect(
      within(inventory)
        .getByRole('button', { name: '全部 MCP servers 应用到 OC' })
        .getAttribute('data-tooltip'),
    ).toBe('应用到 OC')

    const toolbar = within(inventory).getByRole('toolbar', { name: 'MCP inventory actions' })
    expect(within(toolbar).getByRole('button', { name: 'Add server' }).textContent?.trim()).toBe('')
    expect(within(toolbar).getByRole('button', { name: 'Import MCP' }).textContent?.trim()).toBe('')
    const projectButton = within(toolbar).getByRole('button', { name: 'Project changes' })
    expect(projectButton.textContent?.trim()).toBe('')
    expect(projectButton.querySelector('.lucide-send')).not.toBeNull()
  })

  it('renders global target controls inside inventory without projecting', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    const workbench = screen.getByRole('region', { name: 'MCP workbench' })
    const inventory = within(workbench).getByRole('complementary', { name: 'MCP inventory' })
    const globalTargets = within(inventory).getByRole('region', { name: '全局 MCP targets' })

    expect(inventory.contains(globalTargets)).toBe(true)

    fireEvent.click(
      within(globalTargets).getByRole('button', { name: '全部 MCP servers 应用到 OC' }),
    )

    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalled())
    expect(api.project).not.toHaveBeenCalled()
  })

  it('keeps create/edit in the workbench and saves create without targets', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    expect(screen.queryByRole('dialog', { name: /MCP Server/ })).toBeNull()
    expect(screen.getByRole('heading', { name: '新增 MCP server' })).toBeDefined()

    fireEvent.change(screen.getByLabelText('server id'), { target: { value: 'new-browser-tools' } })
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText('args'), { target: { value: '@acme/browser-tools' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() =>
      expect(api.addMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        server: expect.not.objectContaining({ targets: expect.anything() }),
      }),
    )
  })

  it('preserves edit targets while letting target chips project only when requested', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        id: 'playwright',
        server: expect.objectContaining({ command: 'node', targets: ['codex'] }),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'playwright 应用到 CC' }))
    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalled())
    expect(api.project).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Project changes' }))
    await waitFor(() =>
      expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/mcp-view', scope: 'mcp' }),
    )
  })

  it('uses preview target for transport/env/headers/settings and variable inspector', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    expect(await screen.findByText('/preview/codex/browsers')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Preview as OC' }))
    expect(await screen.findByText('/preview/opencode/browsers')).toBeDefined()
    expect(screen.queryByText('HEADERS')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '选择 remote-auth' }))
    expect(await screen.findByText('REQUEST_TIMEOUT')).toBeDefined()
    expect(screen.getByText('Authorization')).toBeDefined()
    expect(screen.getAllByText(/repo-opencode/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Preview as CX' }))
    expect(await screen.findByText(/\[mcp_servers\.remote-auth\]/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview as OC' }))
    fireEvent.click(screen.getByRole('button', { name: '查看变量 browsers_path' }))
    const dialog = await screen.findByRole('dialog', { name: '变量信息 ${browsers_path}' })
    expect(within(dialog).getByText('Base')).toBeDefined()
    expect(within(dialog).getByText('Local / OpenCode')).toBeDefined()
    expect(within(dialog).queryByText(/MCP env|vars\./)).toBeNull()
  })

  it('imports native MCP entries through a preview dialog without projecting', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Import MCP' }))

    const dialog = await screen.findByRole('dialog', { name: 'Import MCP servers' })
    expect(api.scanMcpImports).toHaveBeenCalledWith({
      repo: '/tmp/mcp-view',
      sources: ['claude-code', 'codex', 'opencode'],
    })
    expect(within(dialog).getByText('browser-cx')).toBeDefined()
    expect(within(dialog).getByText('mcp_servers.browser.description')).toBeDefined()
    expect(within(dialog).getByText('stdio MCP server 缺少 command')).toBeDefined()
    expect(
      within(dialog).getByRole<HTMLInputElement>('checkbox', { name: '导入 broken' }).disabled,
    ).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm import' }))

    await waitFor(() =>
      expect(api.applyMcpImports).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        sources: ['claude-code', 'codex', 'opencode'],
        keys: ['ready-key', 'renamed-key'],
      }),
    )
    expect(api.project).not.toHaveBeenCalled()
  })

  it('shows stale import preview errors without closing the dialog', async () => {
    vi.mocked(api.applyMcpImports).mockResolvedValueOnce({
      ok: false,
      error: 'stale_import_preview',
      message: '导入预览已过期，请重新扫描',
    } as never)
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Import MCP' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import MCP servers' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm import' }))

    expect(await within(dialog).findByText('导入预览已过期，请重新扫描')).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Import MCP servers' })).toBeDefined()
  })

  it('connects a saved server debug session and calls a selected tool with editable Monaco args', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    expect((await screen.findByRole('tab', { name: '配置' })).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.queryByRole('region', { name: 'MCP tools debug' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Tools 调试' }))
    const panel = await screen.findByRole('region', { name: 'MCP tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))

    await waitFor(() =>
      expect(api.createMcpDebugSession).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        source: 'saved',
        serverId: 'playwright',
        previewTarget: 'codex',
      }),
    )
    await waitFor(() => expect(within(panel).getByText('capture_live_filter')).toBeDefined())

    const args = within(panel).getByRole('textbox', { name: 'Tool arguments JSON' })
    expect(args).toMatchObject({ value: expect.stringContaining('"pattern": "mcp"') })
    expect(within(panel).getByText('参数')).toBeDefined()
    expect(within(panel).getByRole('button', { name: '重置参数' })).toBeDefined()
    fireEvent.change(args, { target: { value: '{ "pattern": "reqable" }' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Call tool' }))

    await waitFor(() =>
      expect(api.callMcpDebugTool).toHaveBeenCalledWith('debug-1', {
        toolName: 'capture_live_filter',
        arguments: { pattern: 'reqable' },
      }),
    )
    expect(await within(panel).findByText(/durationMs/)).toBeDefined()
  })

  it('tests editor drafts and marks the debug session stale when draft fields change', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    const panel = await screen.findByRole('region', { name: 'MCP draft tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))

    await waitFor(() =>
      expect(api.createMcpDebugSession).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        source: 'draft',
        draft: expect.objectContaining({
          id: 'playwright',
          type: 'stdio',
          command: 'npx',
        }),
        previewTarget: 'codex',
      }),
    )

    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })
    expect(await within(panel).findByText('stale')).toBeDefined()
    expect(within(panel).getByRole('button', { name: 'Reconnect debug session' })).toBeDefined()
    await waitFor(() => expect(api.disconnectMcpDebugSession).toHaveBeenCalledWith('debug-1'))
  })

  it('keeps invalid JSON local and does not call the tool API', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Tools 调试' }))
    const panel = await screen.findByRole('region', { name: 'MCP tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))
    await waitFor(() =>
      expect(within(panel).getAllByText('capture_live_filter').length).toBeGreaterThan(0),
    )

    fireEvent.change(within(panel).getByRole('textbox', { name: 'Tool arguments JSON' }), {
      target: { value: '{' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Call tool' }))

    expect(api.callMcpDebugTool).not.toHaveBeenCalled()
    expect(await within(panel).findByText('参数 JSON 无法解析')).toBeDefined()
  })
})
