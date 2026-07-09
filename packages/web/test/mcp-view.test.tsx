// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Mcp from '../src/views/Mcp'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', () => ({
  api: {
    project: vi.fn(async () => ({ ok: true })),
    addMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpTargets: vi.fn(async () => ({ ok: true })),
    deleteMcpServer: vi.fn(async () => ({ ok: true })),
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
})

describe('MCP workbench view', () => {
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
})
