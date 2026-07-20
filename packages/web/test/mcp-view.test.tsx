// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Mcp from '../src/views/Mcp'
import ToastHost from '../src/components/ToastHost'
import { clearToasts } from '../src/hooks/useToast'
import { api } from '../src/lib/api'
import { createMonacoEditorMock } from './monaco-test-utils'
import { deferred } from './deferred'

const monacoEditorMock = createMonacoEditorMock()
const manifestFixture = vi.hoisted(() => ({
  agentsByRepo: new Map<string, Array<'claude-code' | 'codex' | 'opencode'>>(),
}))

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

vi.mock('../src/lib/api', () => ({
  api: {
    project: vi.fn(async () => ({ ok: true })),
    addMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpAgents: vi.fn(async () => ({ ok: true })),
    deleteMcpServer: vi.fn(async () => ({ ok: true })),
    reorderMcpServers: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true, ids })),
    scanMcpImports: vi.fn(
      async ({ sources = ['claude-code', 'codex', 'opencode'] }: { sources?: string[] }) => {
        const requestedSources = new Set(sources)
        const result = {
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
              agents: ['claude-code'],
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
              agents: ['codex'],
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
              agents: ['claude-code'],
              status: 'disabled',
              selectedByDefault: false,
              ignoredFields: [],
              diagnostics: [{ code: 'missing_command', message: 'stdio MCP server 缺少 command' }],
            },
          ],
          existing: { count: 2 },
        }
        return {
          ...result,
          sources: result.sources.filter(({ agent }) => requestedSources.has(agent)),
          items: result.items.filter(({ sourceAgents }) =>
            sourceAgents.some((agent) => requestedSources.has(agent)),
          ),
        }
      },
    ),
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
      previewAgent: 'codex',
      tools: [
        {
          name: 'capture_live_filter',
          description: 'Filter current Reqable live capture records',
          inputSchema: {
            type: 'object',
            required: ['pattern'],
            properties: {
              pattern: {
                type: 'string',
                default: 'mcp',
                description: 'Match this text against each captured request URL.',
              },
              caseSensitive: {
                type: 'boolean',
                description: 'Use case-sensitive text matching.',
              },
              options: {
                type: 'object',
                description: 'Optional result controls.',
                properties: {
                  limit: {
                    type: 'integer',
                    default: 100,
                    description: 'Maximum number of matching records to return.',
                  },
                },
              },
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
    getManifest: vi.fn(async (repoPath: string) => ({
      skills: { sources: [], skills: [] },
      mcp: [
        {
          id: 'playwright',
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp', '--browser-path', '${browsers_path}'],
          env: { PLAYWRIGHT_BROWSERS_PATH: '${browsers_path}' },
          agents: ['codex'],
        },
        {
          id: 'remote-auth',
          type: 'sse',
          url: 'https://example.test/${workspace}/sse',
          env: { REQUEST_TIMEOUT: '15s' },
          headers: { Authorization: 'Bearer ${token}' },
          agents: [],
        },
      ],
      vars: { default: {}, active: {} },
      config: { agents: [...(manifestFixture.agentsByRepo.get(repoPath) ?? ['codex'])] },
      errors: [],
    })),
    vars: {
      getMatrix: vi.fn(async (_repo: string, agent: string) => ({
        ok: true,
        agent,
        builtinKeys: agent === 'default' ? [] : ['LOOM_AGENT'],
        userKeys: ['browsers_path', 'workspace', 'token'],
        snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
        resolution: {
          ok: true,
          values: {
            browsers_path: { type: 'string', value: `/preview/${agent}/browsers` },
            workspace: { type: 'string', value: `repo-${agent}` },
            token: { type: 'secret', value: '••••••••', masked: true },
            ...(agent === 'default'
              ? {}
              : { LOOM_AGENT: { type: 'string' as const, value: agent } }),
          },
          sources: {
            browsers_path:
              agent === 'default'
                ? { locality: 'local', layer: 'local' }
                : { locality: 'local', layer: 'agent', agent },
            workspace: { locality: 'synced', layer: 'base' },
            token: { locality: 'local', layer: 'local' },
          },
          overrideChains: {
            browsers_path:
              agent === 'default'
                ? [
                    { locality: 'synced', layer: 'base' },
                    { locality: 'local', layer: 'local' },
                  ]
                : [
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
  manifestFixture.agentsByRepo.clear()
  vi.clearAllMocks()
  clearToasts()
  monacoEditorMock.reset()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/mcp')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})

function repoWithManifestAgents(
  scenario: string,
  ...agents: Array<'claude-code' | 'codex' | 'opencode'>
) {
  const repoPath = `/tmp/mcp-${scenario}-${agents.join('-') || 'none'}`
  manifestFixture.agentsByRepo.set(repoPath, agents)
  return repoPath
}

function fakeMonacoModel(line: string) {
  return {
    getValueInRange(range: {
      startColumn: number
      endColumn: number
      startLineNumber: number
      endLineNumber: number
    }) {
      expect(range.startLineNumber).toBe(range.endLineNumber)
      return line.slice(range.startColumn - 1, range.endColumn - 1)
    },
  }
}

describe('MCP workbench view', () => {
  it('persists drawer navigation in the URL and restores it from browser history', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 remote-auth' }))
    expect(window.location.search).toBe('?view=detail&server=remote-auth')
    expect(screen.getByRole('heading', { name: 'remote-auth' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '编辑当前 MCP server' }))
    expect(window.location.search).toBe('?view=edit&server=remote-auth')
    expect(screen.getByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    window.history.back()
    await waitFor(() => expect(window.location.search).toBe('?view=detail&server=remote-auth'))
    expect(await screen.findByRole('heading', { name: 'remote-auth' })).toBeDefined()
  })

  it('keeps the raw configuration preview consistent in detail and edit views', async () => {
    render(<Mcp repoPath="/tmp/mcp-preview" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 remote-auth' }))
    expect(await screen.findByText('SERVER DEFINITION')).toBeDefined()
    expect(screen.getByText('原始 Server 配置')).toBeDefined()
    expect(screen.getByText('保留 ${...} 变量引用，显示 Loom 中保存的定义。')).toBeDefined()
    expect(screen.getByText('mcp.yaml · Server 定义')).toBeDefined()
    expect(screen.getByText('未解析')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '编辑当前 MCP server' }))
    expect(await screen.findByRole('heading', { name: '编辑 MCP server' })).toBeDefined()
    expect(screen.getByText('原始 Server 配置')).toBeDefined()
    expect(screen.getByText('mcp.yaml · Server 定义')).toBeDefined()
    expect(screen.queryByText('结构化编辑完整 Server')).toBeNull()
    expect(screen.getByText('ID 已锁定，保存后不可修改')).toBeDefined()
  })

  it('separates the server title and bulk agents into a two-tier inventory toolbar', async () => {
    const repoPath = repoWithManifestAgents('toolbar-agents', 'opencode')
    render(<Mcp repoPath={repoPath} />)

    const workbench = await screen.findByRole('region', { name: 'MCP workbench' })
    const inventory = within(workbench).getByRole('complementary', { name: 'MCP inventory' })

    expect(within(inventory).queryByText(/configured/)).toBeNull()
    const globalAgents = screen.getByRole('region', { name: '全局 MCP agents' })
    expect(inventory.contains(globalAgents)).toBe(true)
    expect(within(inventory).queryByText('全部 servers')).toBeNull()
    expect(within(globalAgents).getByText('批量应用')).toBeDefined()
    expect(
      within(globalAgents).getByRole('group', { name: '批量设置全部 Server agents' }),
    ).toBeDefined()
    expect(
      within(globalAgents)
        .getByRole('button', { name: '全部 MCP servers 应用到 OpenCode：全部未应用' })
        .getAttribute('data-tooltip'),
    ).toBe('OpenCode：全部未应用，点击批量切换')
    expect(within(globalAgents).queryByText(/0\/2/)).toBeNull()

    const toolbar = within(inventory).getByRole('toolbar', { name: 'MCP inventory actions' })
    expect(globalAgents.parentElement).toBe(toolbar.parentElement?.parentElement)
    expect(
      within(toolbar).getByRole('button', { name: '新增 MCP server' }).textContent?.trim(),
    ).toBe('')
    expect(within(toolbar).getByRole('button', { name: 'Import MCP' }).textContent?.trim()).toBe('')
    expect(within(inventory).queryByRole('button', { name: 'All' })).toBeNull()
    expect(within(inventory).queryByRole('button', { name: 'Local' })).toBeNull()
    expect(within(inventory).queryByRole('button', { name: 'Remote' })).toBeNull()

    const add = screen.getByRole('button', { name: 'Add server' })
    const project = screen.getByRole('button', { name: 'Project changes' })
    expect(add.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('shows only configured applicable MCP agent controls', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [
        {
          id: 'agent-matrix',
          type: 'stdio',
          command: 'node',
          args: [],
          env: {},
          agents: [],
        },
      ],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    } as never)

    render(<Mcp repoPath="/tmp/mcp-agent-matrix" />)

    const globalAgents = await screen.findByRole('region', { name: '全局 MCP agents' })
    expect(
      within(globalAgents).queryByRole('button', {
        name: '全部 MCP servers 应用到 Claude Code：全部未应用',
      }),
    ).toBeNull()
    expect(
      within(globalAgents).getByRole('button', {
        name: '全部 MCP servers 应用到 Codex：全部未应用',
      }),
    ).toBeDefined()
    expect(
      within(globalAgents).getByRole('button', {
        name: '全部 MCP servers 应用到 OpenCode：全部未应用',
      }),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'agent-matrix 应用到 Claude Code' })).toBeNull()
  })

  it('keeps RAW, Default, CRUD, and zero-source import when agents are empty', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [{ id: 'empty-scope', type: 'stdio', command: 'node', agents: ['codex'] }],
      vars: { default: {}, active: {} },
      config: { agents: [] },
      errors: [],
    } as never)

    render(<Mcp repoPath="/tmp/mcp-empty" />)

    expect(await screen.findByRole('button', { name: '选择 empty-scope' })).toBeDefined()
    expect(screen.queryByRole('region', { name: '全局 MCP agents' })).toBeNull()
    expect(screen.getByRole('searchbox', { name: '搜索 MCP server' })).toBeDefined()
    expect(screen.queryByRole('group', { name: '批量设置全部 Server agents' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'empty-scope 应用到 Codex' })).toBeNull()
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/tmp/mcp-empty', 'default')
    expect(api.vars.getMatrix).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '选择 empty-scope' }))
    expect(screen.getByRole('button', { name: 'RAW' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Default' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Preview as Codex' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Import MCP' }))
    await waitFor(() =>
      expect(api.scanMcpImports).toHaveBeenCalledWith({ repo: '/tmp/mcp-empty', sources: [] }),
    )
    const importDialog = screen.getByRole('dialog', { name: 'Import MCP servers' })
    expect(within(importDialog).queryByLabelText('MCP import sources')).toBeNull()
    expect(within(importDialog).getByText('未发现可导入的 MCP server')).toBeDefined()
    expect(within(importDialog).queryByRole('checkbox')).toBeNull()
    expect(
      within(importDialog).getByRole<HTMLButtonElement>('button', { name: 'Confirm import' })
        .disabled,
    ).toBe(true)
  })

  it('updates global agent controls without projecting', async () => {
    const repoPath = repoWithManifestAgents('global-agents', 'opencode')
    render(<Mcp repoPath={repoPath} />)

    const globalAgents = await screen.findByRole('region', { name: '全局 MCP agents' })

    fireEvent.click(
      within(globalAgents).getByRole('button', {
        name: '全部 MCP servers 应用到 OpenCode：全部未应用',
      }),
    )

    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalled())
    expect(api.project).not.toHaveBeenCalled()
  })

  it('suggests resolved vars inside the Server JSON editor', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'JSON' }))
    await waitFor(() => expect(monacoEditorMock.providers.length).toBeGreaterThan(0))

    const provider = monacoEditorMock.providers[0] as {
      provideCompletionItems: (model: unknown, position: unknown) => { suggestions: unknown[] }
    }
    const suggestions = provider.provideCompletionItems(fakeMonacoModel('${brow'), {
      lineNumber: 1,
      column: 7,
    }).suggestions

    expect(api.vars.getMatrix).toHaveBeenCalledWith('/tmp/mcp-view', 'codex')
    expect(suggestions).toContainEqual(expect.objectContaining({ label: 'browsers_path' }))
  })

  it('updates bulk agents one server at a time', async () => {
    let releaseFirst!: () => void
    vi.mocked(api.updateMcpAgents).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ ok: true })
        }),
    )

    render(<Mcp repoPath="/tmp/mcp-view" />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: '全部 MCP servers 应用到 Codex：部分已应用',
      }),
    )

    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalledTimes(1))
    releaseFirst()
    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalledTimes(2))
  })

  it('keeps selection while reordering and disables sorting during search', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    const first = await screen.findByLabelText('调整 playwright 顺序')
    const second = screen.getByLabelText('调整 remote-auth 顺序')
    ;[first, second].forEach((element, index) => {
      element.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 100, width: 320, height: 92 })
      const sortableItem = element.parentElement?.parentElement?.parentElement
      if (sortableItem) {
        sortableItem.getBoundingClientRect = () =>
          DOMRect.fromRect({ x: 0, y: index * 100, width: 700, height: 92 })
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '选择 remote-auth' }))
    expect(await screen.findByRole('heading', { name: 'remote-auth' })).toBeDefined()

    first.focus()
    fireEvent.keyDown(first, { key: ' ', code: 'Space' })
    await waitFor(() => expect(first.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    await waitFor(() =>
      expect(api.reorderMcpServers).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        ids: ['remote-auth', 'playwright'],
      }),
    )
    expect(await screen.findByRole('heading', { name: 'remote-auth' })).toBeDefined()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'remote' } })
    expect(screen.getByLabelText('调整 remote-auth 顺序').getAttribute('aria-disabled')).toBe(
      'true',
    )
  })

  it('keeps create/edit in the workbench and saves create without agents', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    expect(screen.queryByRole('dialog', { name: /MCP Server/ })).toBeNull()
    expect(screen.getByRole('heading', { name: '新增 MCP server' })).toBeDefined()

    fireEvent.change(screen.getByLabelText('server id'), { target: { value: 'new-browser-tools' } })
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'npx' } })
    fireEvent.click(screen.getByRole('button', { name: '添加参数' }))
    fireEvent.change(screen.getByLabelText('Argument 1'), {
      target: { value: '@acme/browser-tools' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.addMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        server: expect.not.objectContaining({ agents: expect.anything() }),
      }),
    )
  })

  it('keeps arguments as a lossless ordered string array', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.change(screen.getByLabelText('Argument 2'), {
      target: { value: '--browser config=with spaces' },
    })
    fireEvent.paste(screen.getByLabelText('Argument 3'), {
      clipboardData: {
        getData: () => '--first=value with spaces\n\n--last=${token}\n',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        id: 'playwright',
        server: expect.objectContaining({
          args: [
            '@playwright/mcp',
            '--browser config=with spaces',
            '--first=value with spaces',
            '',
            '--last=${token}',
          ],
          agents: ['codex'],
        }),
      }),
    )
  })

  it('reorders arguments from the drag handle without arrow controls', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    expect(screen.queryByRole('button', { name: /上移 Argument|下移 Argument/ })).toBeNull()

    const first = screen.getByRole('button', { name: '调整 Argument 1 顺序' })
    const second = screen.getByRole('button', { name: '调整 Argument 2 顺序' })
    const third = screen.getByRole('button', { name: '调整 Argument 3 顺序' })
    for (const [index, handle] of [first, second, third].entries()) {
      handle.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 48, width: 34, height: 34 })
      const row = handle.parentElement?.parentElement
      if (row)
        row.getBoundingClientRect = () =>
          DOMRect.fromRect({ x: 0, y: index * 48, width: 480, height: 42 })
    }

    first.focus()
    fireEvent.keyDown(first, { key: ' ', code: 'Space' })
    await waitFor(() => expect(first.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    await waitFor(() =>
      expect(screen.getByLabelText('Argument 1')).toMatchObject({ value: '--browser-path' }),
    )
    expect(screen.getByLabelText('Argument 2')).toMatchObject({ value: '@playwright/mcp' })
  })

  it('round-trips complete Server JSON and blocks invalid source without changing agents', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    const source = screen.getByRole('textbox', { name: '完整 Server JSON' })
    fireEvent.change(source, {
      target: {
        value: JSON.stringify({
          id: 'playwright',
          type: 'stdio',
          command: 'node',
          args: ['--space=value with spaces', '', '${token}'],
          env: { EMPTY: '', TOKEN: '${token}' },
        }),
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: '可视化' }))
    expect(screen.getByLabelText('command')).toMatchObject({ value: 'node' })
    expect(screen.getByLabelText('Argument 1')).toMatchObject({
      value: '--space=value with spaces',
    })
    expect(screen.getByLabelText('Argument 2')).toMatchObject({ value: '' })

    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    fireEvent.change(screen.getByRole('textbox', { name: '完整 Server JSON' }), {
      target: { value: '{' },
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: '可视化' }))
    expect(screen.getByLabelText('command').closest('fieldset')?.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))
    expect(
      within(screen.getByRole('region', { name: 'MCP tools debug' })).getByRole<HTMLButtonElement>(
        'button',
        { name: /保存并连接/ },
      ).disabled,
    ).toBe(true)
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })

  it('rejects locked ids and transport-incompatible fields in Server JSON', async () => {
    render(<Mcp repoPath="/tmp/mcp-strict-json" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    const source = screen.getByRole('textbox', { name: '完整 Server JSON' })

    fireEvent.change(source, {
      target: {
        value: JSON.stringify({ id: 'renamed', type: 'stdio', command: 'npx' }),
      },
    })
    expect(await screen.findByText('已保存的 id 不可修改')).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)

    fireEvent.change(source, {
      target: {
        value: JSON.stringify({
          id: 'playwright',
          type: 'stdio',
          command: 'npx',
          headers: { Authorization: 'Bearer token' },
        }),
      },
    })
    expect(await screen.findByText('stdio 不支持字段: headers')).toBeDefined()
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })

  it('canonicalizes Server JSON after saving trimmed persisted fields', async () => {
    render(<Mcp repoPath="/tmp/mcp-canonical-json" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    const source = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '完整 Server JSON' })
    fireEvent.change(source, {
      target: {
        value: JSON.stringify({ id: 'playwright', type: 'stdio', command: '  node  ' }),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-canonical-json',
        id: 'playwright',
        server: expect.objectContaining({ command: 'node', agents: ['codex'] }),
      }),
    )
    await waitFor(() => expect(JSON.parse(source.value).command).toBe('node'))
  })

  it('rejects duplicate env keys without overwriting values', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: '新增 env 行' }))
    fireEvent.change(screen.getByLabelText('env key 2'), {
      target: { value: 'PLAYWRIGHT_BROWSERS_PATH' },
    })
    fireEvent.change(screen.getByLabelText('env value 2'), { target: { value: 'other' } })

    expect(await screen.findByText(/env 包含重复 key/)).toBeDefined()
    expect(screen.getByLabelText('env key 1').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('env key 2').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(api.updateMcpServer).not.toHaveBeenCalled()
  })

  it('opens a Server row from the keyboard', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    const row = await screen.findByRole('button', { name: '选择 remote-auth' })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'remote-auth' })).toBeDefined()
  })

  it('copies the selected server through the global toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <>
        <ToastHost />
        <Mcp repoPath="/tmp/mcp-view" />
      </>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy server JSON' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual([
      expect.objectContaining({ id: 'playwright', command: 'npx' }),
    ])
    expect(await screen.findByText('已拷贝到剪贴板')).toBeDefined()
  })

  it.each([
    ['unavailable', undefined],
    ['rejected', vi.fn().mockRejectedValue(new Error('permission denied'))],
  ])('reports clipboard %s with a complete error log', async (_label, writeText) => {
    if (writeText) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <>
        <ToastHost />
        <Mcp repoPath="/tmp/mcp-view" />
      </>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy server JSON' }))

    expect(await screen.findByText('复制失败')).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to copy MCP server',
    )
    consoleError.mockRestore()
  })

  it('locks delete submission and closing until the request finishes', async () => {
    const request = deferred<{ ok: true }>()
    vi.mocked(api.deleteMcpServer).mockImplementationOnce(() => request.promise)
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '删除 playwright' }))
    const dialog = await screen.findByRole('dialog', { name: '删除 MCP server' })
    const deleteButton = within(dialog).getByRole('button', { name: '删除' })
    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)

    expect(api.deleteMcpServer).toHaveBeenCalledTimes(1)
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: '删除中...' }).disabled,
    ).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '关闭' }).disabled).toBe(
      true,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: '删除 MCP server' })).toBeDefined()

    request.resolve({ ok: true })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '删除 MCP server' })).toBeNull(),
    )
  })

  it('keeps the delete dialog open after a failed request', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = {
      ok: false,
      error: 'delete_failed',
      message: '删除失败',
    } as const
    vi.mocked(api.deleteMcpServer).mockResolvedValueOnce(result as never)
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '删除 playwright' }))
    const dialog = await screen.findByRole('dialog', { name: '删除 MCP server' })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => expect(api.deleteMcpServer).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog', { name: '删除 MCP server' })).toBeDefined()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '删除' }).disabled).toBe(
      false,
    )
    expect(consoleError).toHaveBeenCalledWith(
      { key: 'mcp:delete:playwright', result, message: result.message },
      'Manifest operation returned ok:false',
    )
    consoleError.mockRestore()
  })

  it('confirms before closing a dirty editor drawer', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })
    const editor = screen.getByRole('complementary', { name: '编辑 Server' })
    fireEvent.click(within(editor).getByRole('button', { name: '返回 Server 列表' }))

    const dialog = await screen.findByRole('dialog', { name: '放弃未保存的更改' })
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    fireEvent.click(within(editor).getByRole('button', { name: '返回 Server 列表' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '放弃未保存的更改' })).getByRole('button', {
        name: '放弃更改',
      }),
    )
    expect(screen.queryByRole('complementary', { name: '编辑 Server' })).toBeNull()
  })

  it('does not add duplicate history entries when browser Back closes a dirty editor', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑当前 MCP server' }))
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })

    window.history.back()
    const dialog = await screen.findByRole('dialog', { name: '放弃未保存的更改' })
    await waitFor(() => expect(window.location.search).toBe('?view=edit&server=playwright'))
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃更改' }))
    await waitFor(() => expect(window.location.search).toBe('?view=detail&server=playwright'))

    window.history.back()
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen.queryByRole('complementary', { name: '编辑 Server' })).toBeNull()
  })

  it('preserves edit agents while letting agent chips project only when requested', async () => {
    const repoPath = repoWithManifestAgents('edit-agents', 'claude-code', 'codex')
    render(<Mcp repoPath={repoPath} />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: repoPath,
        id: 'playwright',
        server: expect.objectContaining({ command: 'node', agents: ['codex'] }),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'playwright 应用到 Claude Code' }))
    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalled())
    expect(api.project).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Project changes' }))
    await waitFor(() => expect(api.project).toHaveBeenCalledWith({ repo: repoPath, scope: 'mcp' }))
  })

  it('uses preview agent for transport/env/headers/settings and variable inspector', async () => {
    const repoPath = repoWithManifestAgents('preview-agents', 'codex', 'opencode')
    render(<Mcp repoPath={repoPath} />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    expect((await screen.findAllByText('${browsers_path}')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    expect(await screen.findByText('Default 解析配置')).toBeDefined()
    expect((await screen.findAllByText('/preview/default/browsers')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    expect((await screen.findAllByText('/preview/codex/browsers')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Preview as OpenCode' }))
    expect((await screen.findAllByText('/preview/opencode/browsers')).length).toBeGreaterThan(0)
    expect(screen.queryByText('HEADERS')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '选择 remote-auth' }))
    expect(await screen.findByText('REQUEST_TIMEOUT')).toBeDefined()
    expect(screen.getByText('Authorization')).toBeDefined()
    expect(screen.getAllByText(/repo-opencode/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    expect(await screen.findByText(/\[mcp_servers\.remote-auth\]/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview as OpenCode' }))
    fireEvent.click(screen.getByRole('button', { name: 'RAW' }))
    fireEvent.click(screen.getAllByRole('button', { name: '查看变量 browsers_path' })[0])
    const dialog = await screen.findByRole('dialog', { name: '变量信息 ${browsers_path}' })
    expect(within(dialog).getByText('Base')).toBeDefined()
    expect(within(dialog).getByText('Local')).toBeDefined()
    expect(within(dialog).queryByText(/MCP env|vars\./)).toBeNull()
  })

  it('shows variable diagnostics in the Default Server preview', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [
        {
          id: 'broken-default',
          type: 'stdio',
          command: 'node',
          args: ['${missing}'],
          agents: [],
        },
      ],
      vars: { default: {}, active: {} },
      config: { agents: [] },
      errors: [],
    } as never)

    render(<Mcp repoPath="/tmp/mcp-default-diagnostics" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 broken-default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    expect(await screen.findByText('1 个问题')).toBeDefined()
    expect(screen.getByText(/MISSING_REFERENCE:.*missing/)).toBeDefined()
  })

  it('imports native MCP entries through a preview dialog without projecting', async () => {
    const repoPath = repoWithManifestAgents('import-agents', 'claude-code', 'codex', 'opencode')
    render(<Mcp repoPath={repoPath} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Import MCP' }))

    const dialog = await screen.findByRole('dialog', { name: 'Import MCP servers' })
    expect(api.scanMcpImports).toHaveBeenCalledWith({
      repo: repoPath,
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
        repo: repoPath,
        sources: ['claude-code', 'codex', 'opencode'],
        keys: ['ready-key', 'renamed-key'],
      }),
    )
    expect(api.project).not.toHaveBeenCalled()
  })

  it('shows stale import preview errors without closing the dialog', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = {
      ok: false,
      error: 'stale_import_preview',
      message: '导入预览已过期，请重新扫描',
    } as const
    vi.mocked(api.applyMcpImports).mockResolvedValueOnce(result as never)
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Import MCP' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import MCP servers' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm import' }))

    expect(await within(dialog).findByText('导入预览已过期，请重新扫描')).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Import MCP servers' })).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      { key: 'mcp:import:apply', result, message: result.message },
      'Manifest operation returned ok:false',
    )
    consoleError.mockRestore()
  })

  it('connects a saved server debug session and calls a selected tool with editable Monaco args', async () => {
    let resolveToolCall!: (value: Awaited<ReturnType<typeof api.callMcpDebugTool>>) => void
    vi.mocked(api.callMcpDebugTool).mockImplementationOnce(
      () => new Promise((resolve) => (resolveToolCall = resolve)),
    )
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    expect((await screen.findByRole('tab', { name: '配置' })).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.queryByRole('region', { name: 'MCP tools debug' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(screen.getByRole('tab', { name: /Tools/ }))
    const panel = await screen.findByRole('region', { name: 'MCP tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))

    await waitFor(() =>
      expect(api.createMcpDebugSession).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        source: 'saved',
        serverId: 'playwright',
        previewAgent: 'codex',
      }),
    )
    await waitFor(() => expect(within(panel).getAllByText('capture_live_filter')).toHaveLength(2))
    expect(within(panel).getAllByText('Filter current Reqable live capture records')).toHaveLength(
      2,
    )

    const toolSearch = within(panel).getByRole('searchbox', { name: '搜索 Tools' })
    fireEvent.change(toolSearch, { target: { value: 'current reqable' } })
    expect(within(panel).getByLabelText('显示 1 / 1 个 Tools')).toBeDefined()
    expect(
      within(panel).getByRole('button', { name: /capture_live_filter.*Filter current Reqable/ }),
    ).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /capture_live_get/ })).toBeNull()

    fireEvent.change(toolSearch, { target: { value: 'missing tool' } })
    expect(within(panel).getByText('没有匹配的 Tools')).toBeDefined()
    expect(within(panel).getByTitle('capture_live_filter')).toBeDefined()
    fireEvent.change(toolSearch, { target: { value: '' } })

    const args = within(panel).getByRole('textbox', { name: 'Tool arguments JSON' })
    expect(args).toMatchObject({ value: expect.stringContaining('"pattern": "mcp"') })
    expect(within(panel).getByTitle('capture_live_filter')).toBeDefined()
    expect(within(panel).getByTitle('Filter current Reqable live capture records')).toBeDefined()
    expect(within(panel).getByRole('button', { name: '重置参数' })).toBeDefined()
    const parametersToggle = within(panel).getByRole('button', { name: /参数说明.*1 必填 · 4 个/ })
    expect(parametersToggle.getAttribute('aria-expanded')).toBe('true')
    expect(
      within(panel).getByText('Match this text against each captured request URL.'),
    ).toBeDefined()
    expect(within(panel).getByText('options.limit')).toBeDefined()
    expect(within(panel).getByText('default: 100')).toBeDefined()
    fireEvent.click(parametersToggle)
    expect(parametersToggle.getAttribute('aria-expanded')).toBe('false')
    expect(
      within(panel).queryByText('Match this text against each captured request URL.'),
    ).toBeNull()
    expect(window.localStorage.getItem('loom:mcp-debug:parameters-expanded')).toBe('false')
    fireEvent.change(args, { target: { value: '{ "pattern": "reqable" }' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Call tool' }))

    await waitFor(() =>
      expect(
        within(panel).getByRole('button', { name: 'Calling MCP tool' }).getAttribute('aria-busy'),
      ).toBe('true'),
    )
    await waitFor(() =>
      expect(api.callMcpDebugTool).toHaveBeenCalledWith('debug-1', {
        toolName: 'capture_live_filter',
        arguments: { pattern: 'reqable' },
      }),
    )
    resolveToolCall({
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
      durationMs: 12,
      calledAt: '2026-07-13T00:00:01.000Z',
      idleExpiresAt: '2026-07-13T00:05:01.000Z',
    })
    expect(await within(panel).findByText(/durationMs/)).toBeDefined()
    expect(panel.querySelectorAll('.hljs-attr').length).toBeGreaterThan(0)

    fireEvent.click(within(panel).getByRole('button', { name: '复制调用结果' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"durationMs": 12')),
    )
    expect(within(panel).getByRole('button', { name: '已复制调用结果' })).toBeDefined()
  })

  it('switches RAW to Default when opening Tools and connects with the default context', async () => {
    render(<Mcp repoPath="/tmp/mcp-default-tools" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    expect(screen.getByRole('button', { name: 'RAW' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))

    const panel = await screen.findByRole('region', { name: 'MCP tools debug' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    )
    expect(within(panel).getByText('使用 Base → Local 变量连接当前 Server。')).toBeDefined()
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))

    await waitFor(() =>
      expect(api.createMcpDebugSession).toHaveBeenCalledWith({
        repo: '/tmp/mcp-default-tools',
        source: 'saved',
        serverId: 'playwright',
        previewAgent: 'default',
      }),
    )
  })

  it('saves an editor definition before connecting Tools and never sends a draft source', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 playwright' }))
    fireEvent.change(screen.getByLabelText(/command/i), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(screen.getByRole('tab', { name: /Tools/ }))
    const panel = await screen.findByRole('region', { name: /MCP (?:Tools 调试|tools debug)/i })
    fireEvent.click(within(panel).getByRole('button', { name: /保存并连接/ }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        id: 'playwright',
        server: expect.objectContaining({
          command: 'node',
          agents: ['codex'],
        }),
      }),
    )
    await waitFor(() =>
      expect(api.createMcpDebugSession).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        source: 'saved',
        serverId: 'playwright',
        previewAgent: 'codex',
      }),
    )
    for (const [request] of vi.mocked(api.createMcpDebugSession).mock.calls) {
      expect(request).not.toMatchObject({ source: 'draft' })
      expect(request).not.toHaveProperty('draft')
    }
    expect(screen.getByRole('heading', { name: '编辑 MCP server' })).toBeDefined()
    expect(screen.getByRole('tab', { name: /Tools/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: '配置' }))
    await waitFor(() => expect(api.disconnectMcpDebugSession).toHaveBeenCalledWith('debug-1'))
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('creates a Server before connecting and stays in Tools', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    fireEvent.change(screen.getByLabelText('server id'), { target: { value: 'new-server' } })
    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'npx' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))
    const panel = screen.getByRole('region', { name: 'MCP tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: /保存并连接/ }))

    await waitFor(() =>
      expect(api.addMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        server: expect.objectContaining({ id: 'new-server', command: 'npx' }),
      }),
    )
    await waitFor(() =>
      expect(api.createMcpDebugSession).toHaveBeenCalledWith({
        repo: '/tmp/mcp-view',
        source: 'saved',
        serverId: 'new-server',
        previewAgent: 'codex',
      }),
    )
    expect(screen.getByRole('tab', { name: 'Tools' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByText('capture_live_filter')).toHaveLength(2)
  })

  it('disconnects an active Tools session when switching to RAW', async () => {
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))
    const panel = screen.getByRole('region', { name: 'MCP tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))
    await waitFor(() => expect(within(panel).getAllByText('capture_live_filter')).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'RAW' }))

    await waitFor(() => expect(api.disconnectMcpDebugSession).toHaveBeenCalledWith('debug-1'))
    expect(
      within(panel).getByRole<HTMLButtonElement>('button', { name: 'Call tool' }).disabled,
    ).toBe(true)
  })

  it('disconnects a stale session when RAW is selected before connect resolves', async () => {
    let resolveSession!: (value: Awaited<ReturnType<typeof api.createMcpDebugSession>>) => void
    vi.mocked(api.createMcpDebugSession).mockImplementationOnce(
      () => new Promise((resolve) => (resolveSession = resolve)),
    )
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))
    const panel = screen.getByRole('region', { name: 'MCP tools debug' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Connect debug session' }))
    await waitFor(() => expect(api.createMcpDebugSession).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'RAW' }))
    resolveSession({
      ok: true,
      sessionId: 'late-session',
      source: 'saved',
      serverFingerprint: 'late-fingerprint',
      previewAgent: 'codex',
      tools: [],
      createdAt: '2026-07-13T00:00:00.000Z',
      idleExpiresAt: '2026-07-13T00:05:00.000Z',
      hardExpiresAt: '2026-07-13T00:30:00.000Z',
    })

    await waitFor(() => expect(api.disconnectMcpDebugSession).toHaveBeenCalledWith('late-session'))
    expect(within(panel).queryByText('capture_live_filter')).toBeNull()
  })

  it('keeps invalid JSON local and does not call the tool API', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Mcp repoPath="/tmp/mcp-view" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 playwright' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview as Codex' }))
    fireEvent.click(await screen.findByRole('tab', { name: /Tools/ }))
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
    expect(consoleError).toHaveBeenCalledWith(
      { err: expect.any(SyntaxError), args: '{', toolName: 'capture_live_filter' },
      'Failed to parse MCP tool arguments',
    )
    consoleError.mockRestore()
  })
})
