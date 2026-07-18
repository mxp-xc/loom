// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { StrictMode, useState, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../src/lib/api'
import ToastHost from '../src/components/ToastHost'
import MarkdownPreview from '../src/components/MarkdownPreview'
import Skills from '../src/views/skills/Skills'
import SkillSourceList from '../src/views/skills/SkillSourceList'
import SkillDetailEditor from '../src/views/skills/SkillDetailEditor'
import AddSkillModal from '../src/views/skills/AddSkillModal'
import EditSourceModal from '../src/views/skills/EditSourceModal'
import Sync from '../src/views/Sync'
import Mcp from '../src/views/Mcp'
import Memory from '../src/views/Memory'
import { useManifestOperations } from '../src/hooks/useManifestOperations'
import { createMonacoEditorMock } from './monaco-test-utils'
import { agentIds } from '../src/lib/agents'

const monacoEditorMock = createMonacoEditorMock()

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true } as const

function TestRouter({ children }: { children: ReactNode }) {
  return <MemoryRouter future={routerFuture}>{children}</MemoryRouter>
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

beforeEach(() => {
  monacoEditorMock.reset()
  window.history.replaceState({}, '', '/mcp')
})

vi.mock('../src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    status: vi.fn(async () => ({ active_repo: 'default', repoPath: '/tmp/r' })),
    project: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => ({ updates: [] })),
    prepareSourceUpdate: vi.fn(async () => ({
      ok: true,
      sessionId: 'update-1',
      pinned_commit: 'bbb',
      changes: { added: [], updated: [], removed: [] },
      resourceBoundaryChanges: [],
    })),
    finalizeSourceUpdate: vi.fn(async () => ({ ok: true, pinned_commit: 'bbb' })),
    syncPull: vi.fn(async () => ({ clean: true, files: [], textConflicts: [] })),
    getSyncSession: vi.fn(async () => ({ ok: true, active: false })),
    syncPush: vi.fn(async () => ({ ok: true })),
    saveSyncConflict: vi.fn(async () => ({ ok: true, clean: true, remaining: [] })),
    abortSyncMerge: vi.fn(async () => ({ ok: true })),
    getSyncRemote: vi.fn(async () => ({ remoteUrl: null })),
    setSyncRemote: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(async () => ({ effective: {}, repo: {}, local: {} })),
    putConfig: vi.fn(async () => ({ ok: true })),
    scanLocalSkills: vi.fn(async () => ({ ok: true, skills: [] })),
    importLocalSkills: vi.fn(async () => ({ ok: true, count: 1 })),
    writeLocalSkills: vi.fn(async () => ({ ok: true, count: 1 })),
    scanSource: vi.fn(async () => ({
      ok: true,
      tree: { commit: 'abc1234', nodes: [], diagnostics: [] },
    })),
    getCachedSourceTree: vi.fn(async () => ({
      ok: true,
      tree: { commit: 'abc1234', nodes: [], diagnostics: [] },
    })),
    getSourceRefs: vi.fn(async () => ({ ok: true, branches: [], tags: [] })),
    refreshSource: vi.fn(async () => ({
      ok: true,
      tree: { commit: 'abc1234', nodes: [], diagnostics: [] },
    })),
    addSource: vi.fn(async () => ({ ok: true })),
    reconcileSource: vi.fn(async () => ({
      ok: true,
      finalized: true,
      changes: { added: [], updated: [], removed: [] },
    })),
    updateSkillAgents: vi.fn(async () => ({ ok: true })),
    updateSourceSkillAgents: vi.fn(async () => ({ ok: true })),
    updateLocalSkillAgents: vi.fn(async () => ({ ok: true })),
    getSkillContent: vi.fn(async () => ({ ok: true, content: '# Skill' })),
    deleteSource: vi.fn(async () => ({ ok: true })),
    deleteLocalSkill: vi.fn(async () => ({ ok: true })),
    saveSkillContent: vi.fn(async () => ({ ok: true })),
    addMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpAgents: vi.fn(async () => ({ ok: true })),
    deleteMcpServer: vi.fn(async () => ({ ok: true })),
    reorderMcpServers: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true, ids })),
    getMemory: vi.fn(async () => ({
      memories: [],
      assignments: {},
      active: null,
      activeContent: '',
    })),
    getMemoryContent: vi.fn(async (_repo: string, name: string) => ({ content: `# ${name}` })),
    updateMemoryAgent: vi.fn(async () => ({ ok: true, assignments: {} })),
    setMemoryActive: vi.fn(async () => ({ ok: true })),
    createMemory: vi.fn(async () => ({ ok: true })),
    renameMemory: vi.fn(async () => ({ ok: true })),
    deleteMemory: vi.fn(async () => ({ ok: true })),
    saveMemoryContent: vi.fn(async () => ({ ok: true })),
    reorderMemories: vi.fn(async ({ names }: { names: string[] }) => ({ ok: true, names })),
    reorderSkillGroups: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true, ids })),
    vars: {
      getMatrix: vi.fn(async () => ({
        ok: true,
        agent: 'codex',
        builtinKeys: [],
        userKeys: [],
        snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
        resolution: {
          ok: true,
          values: {},
          sources: {},
          overrideChains: {},
          dependencies: {},
          diagnostics: [],
        },
      })),
    },
    getManifest: vi.fn(async (repoPath: string) =>
      repoPath === '/tmp/mcp-layout'
        ? {
            skills: { sources: [], skills: [] },
            mcp: [
              {
                id: 'test-mcp',
                type: 'stdio',
                command: 'echo',
                args: ['hello'],
                env: { FOO: 'bar' },
                agents: ['codex'],
              },
              {
                id: 'remote-mcp',
                type: 'http',
                url: 'https://example.test/mcp',
                headers: { Authorization: 'Bearer token' },
                agents: [],
              },
            ],
            vars: { default: {}, active: {} },
            config: { agents: ['claude-code', 'codex', 'opencode'] },
            errors: [],
          }
        : repoPath === '/tmp/skills-layout'
          ? {
              skills: {
                sources: [
                  {
                    url: 'https://github.com/obra/superpowers.git',
                    ref: 'main',
                    type: 'branch',
                    pinned_commit: 'abc123456789',
                    members: [
                      {
                        name: 'systematic-debugging',
                        entry: 'skills/systematic-debugging/SKILL.md',
                        description: 'A disciplined debugging loop for bugs and regressions.',
                        path: 'skills/systematic-debugging/SKILL.md',
                        agents: ['claude-code', 'codex', 'opencode'],
                      },
                    ],
                  },
                ],
                skills: [
                  {
                    id: 'test-qa-skill',
                    path: './assets/skills/test-qa-skill',
                    available: false,
                    agents: ['claude-code', 'codex', 'opencode'],
                  },
                  {
                    id: 'frontend-design',
                    description: 'Design guidance for distinctive front-end UI.',
                    skillFilePath: 'assets/skills/frontend-design/SKILL.md',
                    agents: [],
                  },
                ],
              },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { agents: ['claude-code', 'codex'] },
              errors: [],
            }
          : {
              skills: { sources: [], skills: [] },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { agents: ['claude-code', 'codex'] },
              errors: [],
            },
    ),
  },
}))

const defaultGetManifest = vi.mocked(api.getManifest).getMockImplementation()!
const defaultGetMemory = vi.mocked(api.getMemory).getMockImplementation()!
const defaultGetMemoryContent = vi.mocked(api.getMemoryContent).getMockImplementation()!

function SkillSourceListHarness({
  repoPath,
  manifest,
  showToast = vi.fn(),
  setError = vi.fn(),
  onOpenDetail,
  onOpenScan,
  onOpenEdit,
  expandedGroups,
  onToggleGroup,
  groupOrder,
  onReorderGroups,
}: {
  repoPath: string
  manifest: any
  showToast?: (message: string) => void
  setError?: (error: string) => void
  onOpenDetail: (detail: any) => void
  onOpenScan: (source: any) => void
  onOpenEdit: (source: any) => void
  expandedGroups: Set<string>
  onToggleGroup: (key: string) => void
  groupOrder?: string[]
  onReorderGroups?: (ids: string[]) => Promise<void> | void
}) {
  const operations = useManifestOperations(repoPath, { onError: setError, onToast: showToast })
  return (
    <SkillSourceList
      manifest={manifest}
      visibleAgents={agentIds}
      operations={operations}
      onOpenDetail={onOpenDetail}
      onOpenScan={onOpenScan}
      onOpenEdit={onOpenEdit}
      expandedGroups={expandedGroups}
      onToggleGroup={onToggleGroup}
      groupOrder={groupOrder}
      onReorderGroups={onReorderGroups}
    />
  )
}

function EditSourceSwitchHarness() {
  const [source, setSource] = useState<any>(null)
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setSource({
            name: 'alpha-source',
            url: 'https://example.test/alpha.git',
            ref: 'main',
            type: 'branch',
            pinned_commit: 'abc123456789',
            members: [],
          })
        }
      >
        open alpha
      </button>
      <button
        type="button"
        onClick={() =>
          setSource({
            name: 'beta-source',
            url: 'https://example.test/beta.git',
            ref: 'main',
            type: 'branch',
            pinned_commit: 'def123456789',
            members: [],
          })
        }
      >
        open beta
      </button>
      <EditSourceModal
        repoPath="/tmp/edit-switch"
        source={source}
        showToast={vi.fn()}
        onClose={() => setSource(null)}
        onSaved={() => setSource(null)}
      />
    </>
  )
}

function sourceTreeResponse(names: string[], commit = 'abc123456789') {
  return {
    ok: true as const,
    tree: {
      commit,
      diagnostics: [],
      nodes: names.map((name, index) => ({
        kind: 'bundle' as const,
        name,
        path: name,
        entry: `${name}/SKILL.md`,
        mode: '040000',
        oid: `bundle-${index}`,
      })),
    },
  }
}

describe('MCP view', () => {
  it('renders the workbench and embedded create editor', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    const workbench = await screen.findByRole('region', { name: 'MCP workbench' })
    expect(within(workbench).getByRole('complementary', { name: 'MCP inventory' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'MCP Servers' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Project changes' })).toBeDefined()

    fireEvent.click(screen.getAllByRole('button', { name: 'Add server' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: /MCP Server/ })).toBeNull()
    expect(screen.getByRole('heading', { name: '新增 MCP server' })).toBeDefined()
    expect(screen.getByLabelText('env key 1')).toBeDefined()
    expect(screen.getByRole('tab', { name: 'JSON' })).toBeDefined()
    const envModes = screen.getByRole('tablist', { name: 'env 编辑方式' })
    expect(within(envModes).getByRole('tab', { name: '切换 env 为 key value 编辑' })).toBeDefined()
    expect(within(envModes).getByRole('tab', { name: '切换 env 为 env file 编辑' })).toBeDefined()
    expect(screen.getByText('KEY')).toBeDefined()
    expect(screen.getByText('VALUE')).toBeDefined()
    expect(screen.getByRole('button', { name: '新增 env 行' }).textContent).toContain(
      '添加环境变量',
    )
    expect(screen.getByLabelText('server id').parentElement?.querySelector('svg')).not.toBeNull()
    expect(screen.getByLabelText('command').parentElement?.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('小写字母、数字与连字符。')).toBeDefined()
  })

  it('loads MCP vars and suggests variables inside env files', async () => {
    vi.mocked(api.vars.getMatrix).mockResolvedValue({
      ok: true,
      agent: 'codex',
      builtinKeys: ['API_URL'],
      userKeys: ['API_TOKEN'],
      snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
      resolution: {
        ok: true,
        values: {},
        sources: {},
        overrideChains: {},
        dependencies: {},
        diagnostics: [],
      },
    } as never)

    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 test-mcp' }))
    expect(await screen.findByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/tmp/mcp-layout', 'codex'))
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    await waitFor(() => expect(monacoEditorMock.providers.length).toBeGreaterThan(0))

    const provider = monacoEditorMock.providers[0] as {
      provideCompletionItems: (model: unknown, position: unknown) => { suggestions: unknown[] }
    }
    const suggestions = provider.provideCompletionItems(fakeMonacoModel('${AP'), {
      lineNumber: 1,
      column: 5,
    }).suggestions
    expect(suggestions).toContainEqual(expect.objectContaining({ label: 'API_URL' }))
  })

  it('edits a server in the embedded Monaco file editor', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 test-mcp' }))
    expect(await screen.findByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    const idInput = screen.getByLabelText('server id') as HTMLInputElement
    expect(idInput.value).toBe('test-mcp')
    expect(idInput.disabled).toBe(true)
    expect(screen.getByText('ID 已锁定，保存后不可修改')).toBeDefined()

    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })
    expect(screen.queryByText('agents')).toBeNull()

    fireEvent.change(screen.getByLabelText('env value 1'), { target: { value: 'baz' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-layout',
        id: 'test-mcp',
        server: expect.objectContaining({
          id: 'test-mcp',
          type: 'stdio',
          command: 'node',
          args: ['hello'],
          env: { FOO: 'baz' },
          agents: ['codex'],
        }),
      }),
    )
  })

  it('edits remote MCP headers through the embedded Monaco file editor', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 remote-mcp' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑 remote-mcp' }))
    expect(await screen.findByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    fireEvent.change(screen.getByLabelText('headers value 1'), {
      target: { value: 'Bearer ${API_TOKEN}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-layout',
        id: 'remote-mcp',
        server: expect.objectContaining({
          id: 'remote-mcp',
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${API_TOKEN}' },
        }),
      }),
    )
  })

  it('supports MCP env key value rows with add and delete controls', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 test-mcp' }))
    expect(await screen.findByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    fireEvent.change(screen.getByLabelText('env key 1'), { target: { value: 'FOO' } })
    fireEvent.change(screen.getByLabelText('env value 1'), { target: { value: 'baz' } })
    fireEvent.click(screen.getByRole('button', { name: '新增 env 行' }))
    fireEvent.change(screen.getByLabelText('env key 2'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByLabelText('env value 2'), { target: { value: 'abc 123' } })
    fireEvent.click(screen.getByRole('button', { name: '删除 env 行 1' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-layout',
        id: 'test-mcp',
        server: expect.objectContaining({
          env: { TOKEN: 'abc 123' },
          agents: ['codex'],
        }),
      }),
    )
  })

  it('validates the embedded create editor locally', async () => {
    const callsBefore = vi.mocked(api.addMcpServer).mock.calls.length
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      render(<Mcp repoPath="/tmp/mcp-layout" />)

      await screen.findByRole('region', { name: 'MCP workbench' })
      fireEvent.click(screen.getAllByRole('button', { name: 'Add server' }).at(-1)!)
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      expect(await screen.findByText('id 不能为空')).toBeDefined()
      expect(api.addMcpServer).toHaveBeenCalledTimes(callsBefore)
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to submit MCP server',
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('bulk toggles MCP server agents without projecting', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: '全部 MCP servers 应用到 Codex：部分已应用',
      }),
    )

    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalledTimes(2))
    expect(api.project).not.toHaveBeenCalled()
    expect(api.updateMcpAgents).toHaveBeenCalledWith({
      repo: '/tmp/mcp-layout',
      id: 'test-mcp',
      agents: ['codex'],
    })
    expect(api.updateMcpAgents).toHaveBeenCalledWith({
      repo: '/tmp/mcp-layout',
      id: 'remote-mcp',
      agents: ['codex'],
    })
  })

  it('updates MCP bulk agents one server at a time', async () => {
    let releaseFirst!: () => void
    const callsBefore = vi.mocked(api.updateMcpAgents).mock.calls.length
    vi.mocked(api.updateMcpAgents).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ ok: true })
        }) as never,
    )

    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: '全部 MCP servers 应用到 Codex：部分已应用',
      }),
    )

    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalledTimes(callsBefore + 1))
    releaseFirst()
    await waitFor(() => expect(api.updateMcpAgents).toHaveBeenCalledTimes(callsBefore + 2))
    vi.mocked(api.updateMcpAgents).mockResolvedValue({ ok: true } as never)
  })

  it('keeps selection while reordering to the end and disables sorting while searching', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    const first = await screen.findByLabelText('调整 test-mcp 顺序')
    const second = screen.getByLabelText('调整 remote-mcp 顺序')
    ;[first, second].forEach((element, index) => {
      element.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 100, width: 320, height: 92 })
      const sortableItem = element.parentElement?.parentElement?.parentElement
      if (sortableItem) {
        sortableItem.getBoundingClientRect = () =>
          DOMRect.fromRect({ x: 0, y: index * 100, width: 700, height: 92 })
      }
    })
    fireEvent.click(screen.getAllByRole('button', { name: '选择 remote-mcp' })[0])
    expect(await screen.findByRole('heading', { name: 'remote-mcp' })).toBeDefined()

    first.focus()
    fireEvent.keyDown(first, { key: ' ', code: 'Space' })
    await waitFor(() => expect(first.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    await waitFor(() =>
      expect(api.reorderMcpServers).toHaveBeenCalledWith({
        repo: '/tmp/mcp-layout',
        ids: ['remote-mcp', 'test-mcp'],
      }),
    )
    expect(await screen.findByRole('heading', { name: 'remote-mcp' })).toBeDefined()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'remote' } })
    expect(screen.getByLabelText('调整 remote-mcp 顺序').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('Skill detail modal', () => {
  it('keeps location metadata without projected links when agents are empty', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({
      ok: true,
      content: '# Source skill',
    } as never)

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-empty-agents"
        agents={[]}
        detail={{
          skillId: 'source-skill',
          source: 'https://example.test/skills.git',
          path: 'source-skill/SKILL.md',
          agents: ['codex'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'source-skill' })
    expect(within(dialog).getByText('Location')).toBeDefined()
    expect(within(dialog).getByText('https://example.test/skills.git')).toBeDefined()
    expect(within(dialog).getByText('source-skill/SKILL.md')).toBeDefined()
    expect(within(dialog).queryByText('Projected links')).toBeNull()
  })

  it('matches the approved Edit Skill workbench structure', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({
      ok: true,
      content: '# Production skill',
    } as never)

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-workbench"
        agents={agentIds}
        detail={{
          skillId: 'production-skill',
          path: '/skills/production-skill/SKILL.md',
          agents: ['codex'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'production-skill' })
    expect(within(dialog).getByText('Local skill')).toBeDefined()
    expect(
      within(dialog).getByRole('heading', { level: 1, name: 'production-skill' }),
    ).toBeDefined()
    expect(within(dialog).getByTestId('skill-metadata-pane')).toBeDefined()
    expect(within(dialog).getByTestId('skill-document-pane')).toBeDefined()
    expect(within(dialog).getByTestId('skills-workbench')).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'Details' })).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'SKILL.md' })).toBeDefined()
    expect(within(dialog).getByText('Location')).toBeDefined()
    expect(within(dialog).getByText('Projected links')).toBeDefined()
    expect(within(dialog).getByText('1 of 3')).toBeDefined()
    expect(within(dialog).getByText('Claude Code')).toBeDefined()
    expect(within(dialog).getByText('Codex')).toBeDefined()
    expect(within(dialog).getByText('OpenCode')).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'Preview' })).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'Source' })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDefined()
    expect(
      within(dialog).getByRole('button', { name: 'Save SKILL.md' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('reserves the SKILL.md content frame while content is loading', async () => {
    let resolveContent!: (value: { ok: true; content: string }) => void
    vi.mocked(api.getSkillContent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContent = resolve
        }) as never,
    )

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-layout"
        agents={agentIds}
        detail={{
          skillId: 'superpowers/receiving-code-review',
          source: 'https://github.com/obra/superpowers.git',
          agents: ['codex'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', {
      name: 'superpowers/receiving-code-review',
    })
    expect(dialog.getAttribute('style')).toContain('1180px')
    const contentFrame = within(dialog).getByTestId('skill-detail-content-frame')
    expect(contentFrame).toBeDefined()
    expect(within(dialog).getByText('Loading SKILL.md')).toBeDefined()

    await act(async () => {
      resolveContent({ ok: true, content: '# Loaded skill' })
    })

    const loadedHeading = await within(dialog).findByText('Loaded skill')
    const previewPanel = loadedHeading.closest('.md-preview') as HTMLElement
    expect(contentFrame.contains(previewPanel)).toBe(true)
    const copyButton = within(dialog).getByRole('button', { name: '复制 SKILL.md' })
    expect(within(dialog).getByTestId('skill-document-pane').contains(copyButton)).toBe(true)
    expect(within(dialog).queryByRole('button', { name: 'Save SKILL.md' })).toBeNull()
  })

  it('keeps source skills read-only in the Source pane', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({
      ok: true,
      content: '# Managed by source',
    } as never)

    render(
      <SkillDetailEditor
        repoPath="/tmp/source-skill"
        agents={agentIds}
        detail={{
          skillId: 'source-skill',
          source: 'https://github.com/example/skills.git',
          path: 'skills/source-skill/SKILL.md',
          agents: ['codex', 'opencode'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'source-skill' })
    expect(within(dialog).getByText('Read only')).toBeDefined()
    expect(within(dialog).getByText('2 of 3')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Source' }))
    expect(within(dialog).getByText('# Managed by source')).toBeDefined()
    expect(within(dialog).queryByRole('textbox', { name: 'SKILL.md 内容' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Save SKILL.md' })).toBeNull()
  })

  it('opens an empty local skill directly into the source editor', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({ ok: true, content: '' } as never)

    render(
      <SkillDetailEditor
        repoPath="/tmp/empty-local-skill"
        agents={agentIds}
        detail={{ skillId: 'empty-local-skill', path: './skills/empty', agents: [] }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'empty-local-skill' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Start editing' }))
    expect(within(dialog).getByRole('textbox', { name: 'SKILL.md 内容' })).toBeDefined()
  })
})

describe('Memory view', () => {
  afterEach(() => {
    vi.mocked(api.getManifest).mockReset().mockImplementation(defaultGetManifest)
    vi.mocked(api.getMemory).mockReset().mockImplementation(defaultGetMemory)
    vi.mocked(api.getMemoryContent).mockReset().mockImplementation(defaultGetMemoryContent)
  })

  it('uses the approved dropdown manager and preview-first workbench layout', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    } as never)
    vi.mocked(api.getMemory).mockResolvedValueOnce({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'review-rules', agents: ['opencode'] },
      ],
      assignments: { codex: 'v1', opencode: 'review-rules' },
      active: null,
      activeContent: '',
    } as never)
    vi.mocked(api.getMemoryContent).mockResolvedValueOnce({ content: '# Active memory' })

    render(<Memory repoPath="/tmp/memory-layout-approved" />)

    const layout = await screen.findByTestId('memory-layout')
    expect(layout).toBeDefined()
    expect(screen.getByRole('tab', { name: '所见' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'v1', level: 1 })).toBeDefined()
    expect(screen.getByLabelText('Memory 状态').textContent).toContain('1 个 Agent')
    expect(screen.getByRole('article').textContent).toContain('Active memory')
    expect(screen.getByRole('button', { name: '管理 Memory' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    const menu = screen.getByRole('menu', { name: 'Memory 列表' })
    expect(within(menu).getByRole('menuitem', { name: '新建 Memory' })).toBeDefined()
    expect(within(menu).getByRole('button', { name: '删除 v1' })).toBeDefined()
    expect(within(menu).getByRole('button', { name: '删除 review-rules' })).toBeDefined()
    expect(within(menu).getByRole('button', { name: 'v1 已投影到 Codex' })).toBeDefined()
  })

  it('hides preserved assignments for agents outside the configured scope', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex'] },
      errors: [],
    } as never)
    vi.mocked(api.getMemory).mockResolvedValueOnce({
      memories: [{ name: 'v1', agents: ['codex', 'opencode'] }],
      assignments: { codex: 'v1', opencode: 'v1' },
      active: null,
      activeContent: '',
    } as never)
    vi.mocked(api.getMemoryContent).mockResolvedValueOnce({ content: '# Scoped memory' })

    render(<Memory repoPath="/tmp/memory-configured-scope" />)

    expect(await screen.findByRole('heading', { name: 'v1', level: 1 })).toBeDefined()
    expect(screen.getByLabelText('Memory 状态').textContent).toContain('1 个 Agent')
    expect(document.querySelector('[data-agent="codex"]')).not.toBeNull()
    expect(document.querySelector('[data-agent="opencode"]')).toBeNull()
  })

  it('ignores stale content when memory selections resolve out of order', async () => {
    let resolveV2!: (value: { content: string }) => void
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'v2', agents: [] },
        { name: 'v3', agents: [] },
      ],
      assignments: { codex: 'v1' },
      active: null,
      activeContent: '',
    } as never)
    vi.mocked(api.getMemoryContent).mockImplementation(async (_repo, name) => {
      if (name === 'v2') return new Promise((resolve) => (resolveV2 = resolve))
      return { content: `# ${name}` }
    })

    render(<Memory repoPath="/tmp/memory-selection-race" />)
    await screen.findByRole('button', { name: /Memory.*v1/ })

    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'v2' }))
    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'v3' }))
    await screen.findByRole('heading', { name: 'v3' })

    await act(async () => {
      resolveV2({ content: '# stale v2' })
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /Memory.*v3/ })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'stale v2' })).toBeNull()
  })

  it('asks before discarding an unsaved draft when switching memories', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'v2', agents: [] },
      ],
      assignments: { codex: 'v1' },
      active: null,
      activeContent: '',
    } as never)
    vi.mocked(api.getMemoryContent).mockImplementation(async (_repo, name) => ({
      content: `# ${name}`,
    }))

    render(<Memory repoPath="/tmp/memory-unsaved-switch" />)
    await screen.findByRole('button', { name: /Memory.*v1/ })
    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    const source = screen.getByRole('textbox', { name: 'Memory 内容' })
    fireEvent.change(source, { target: { value: '# Edited draft' } })
    await screen.findByRole('button', { name: '保存' })

    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'v2' }))
    const dialog = await screen.findByRole('dialog', { name: '放弃未保存更改' })
    expect((source as HTMLTextAreaElement).value).toBe('# Edited draft')
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(screen.getByRole('button', { name: /Memory.*v1/ })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'v2' }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: '放弃未保存更改' })).getByRole('button', {
        name: '放弃并切换',
      }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /Memory.*v2/ })).toBeDefined())
    expect(
      (screen.getByRole('textbox', { name: 'Memory 内容' }) as HTMLTextAreaElement).value,
    ).toBe('# v2')
  })

  it('assigns an unoccupied agent and reconciles projection immediately', async () => {
    vi.mocked(api.getManifest).mockResolvedValue({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    } as never)
    vi.mocked(api.getMemory)
      .mockResolvedValueOnce({
        memories: [{ name: 'v1', agents: ['codex'] }],
        assignments: { codex: 'v1' },
        active: null,
        activeContent: '',
      } as never)
      .mockResolvedValueOnce({
        memories: [{ name: 'v1', agents: ['codex', 'opencode'] }],
        assignments: { codex: 'v1', opencode: 'v1' },
        active: null,
        activeContent: '',
      } as never)
    vi.mocked(api.getMemoryContent).mockResolvedValue({ content: '# v1' })

    render(<Memory repoPath="/tmp/memory-agents" />)

    fireEvent.click(await screen.findByRole('button', { name: 'v1 投影到 OpenCode' }))

    await waitFor(() =>
      expect(api.updateMemoryAgent).toHaveBeenCalledWith({
        repo: '/tmp/memory-agents',
        agent: 'opencode',
        name: 'v1',
      }),
    )
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/memory-agents', scope: 'memory' })
  })

  it('confirms before moving an occupied agent to another memory', async () => {
    vi.mocked(api.updateMemoryAgent).mockClear()
    vi.mocked(api.getManifest).mockResolvedValue({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    } as never)
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'v2', agents: ['opencode'] },
      ],
      assignments: { codex: 'v1', opencode: 'v2' },
      active: null,
      activeContent: '',
    } as never)
    vi.mocked(api.getMemoryContent).mockResolvedValue({ content: '# memory' })

    render(<Memory repoPath="/tmp/memory-conflict" />)

    fireEvent.click(await screen.findByRole('button', { name: 'v1 投影到 OpenCode' }))
    const dialog = await screen.findByRole('dialog', { name: '切换 OpenCode 的 Memory' })
    expect(dialog.textContent).toContain('v2')
    expect(dialog.textContent).toContain('v1')
    expect(api.updateMemoryAgent).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认切换' }))

    await waitFor(() =>
      expect(api.updateMemoryAgent).toHaveBeenCalledWith({
        repo: '/tmp/memory-conflict',
        agent: 'opencode',
        name: 'v1',
      }),
    )
  })

  it('deletes a specific memory from the dropdown', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'v2', agents: [] },
      ],
      assignments: { codex: 'v1' },
      active: null,
      activeContent: '',
    } as never)
    vi.mocked(api.getMemoryContent).mockResolvedValue({ content: '# memory' })

    render(<Memory repoPath="/tmp/memory-actions" />)

    fireEvent.click(await screen.findByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: '删除 v2' }))
    const dialog = await screen.findByRole('dialog', { name: '删除 Memory' })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith('/tmp/memory-actions', 'v2'))
  })
})

describe('Skills view', () => {
  it('shows machine-local source unavailability as a non-blocking warning', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: {
        sources: [
          {
            name: 'plm-harness',
            url: 'git@gitcode.com:HarnessPlatform/Marketplace.git',
            ref: 'main',
            members: [],
            availability: {
              available: false,
              reason: 'cache-unavailable',
              message: 'Source cache unavailable: git@gitcode.com:HarnessPlatform/Marketplace.git',
            },
          },
        ],
        skills: [],
      },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex'] },
      errors: [],
    } as never)

    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-source-unavailable" />
      </TestRouter>,
    )

    const warning = await screen.findByRole('status', { name: '部分 Source 在当前机器不可用' })
    expect(warning.textContent).toContain('plm-harness')
    expect(warning.textContent).toContain('现有投影已保留')
    expect(screen.queryByText('部分 Skills 配置无法读取')).toBeNull()
  })

  it('renders unambiguous page actions without the legacy footer guidance', async () => {
    render(
      <TestRouter>
        <Skills repoPath="/tmp/r" />
      </TestRouter>,
    )
    const projectButton = await screen.findByRole('button', { name: '投影' })
    expect(projectButton.querySelector('.lucide-send')).not.toBeNull()
    const addButton = screen.getByRole('button', { name: '添加 Skill 或 Source' })
    expect(addButton.textContent).toContain('添加')
    expect(addButton.querySelector('.lucide-plus')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Add skill' })).toBeNull()
    expect(screen.queryByText(/source 级操作/)).toBeNull()
  })

  it('keeps content and source management without agent controls when agents are empty', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: {
        sources: [],
        skills: [{ id: 'kept-skill', path: './assets/skills/kept-skill', agents: ['codex'] }],
      },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: [] },
      errors: [],
    } as never)

    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-empty-agents" />
      </TestRouter>,
    )

    expect(await screen.findByRole('button', { name: '添加 Skill 或 Source' })).toBeDefined()
    expect(screen.getByRole('button', { name: '投影' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }))
    expect(screen.getAllByText('kept-skill').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-agent-chip="true"]')).toBeNull()
  })

  it('clears stale project errors after a successful project mutation refreshes manifest', async () => {
    const repoPath = '/tmp/skills-project-error-clear'
    const getManifestCallsBefore = vi.mocked(api.getManifest).mock.calls.length
    const projectCallsBefore = vi.mocked(api.project).mock.calls.length
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.project).mockResolvedValueOnce({
      ok: false,
      message: '投影失败: stale yaml',
    } as never)

    try {
      render(
        <TestRouter>
          <Skills repoPath={repoPath} />
          <ToastHost />
        </TestRouter>,
      )

      await screen.findByText('还没有配置任何 Skill')
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 1))

      fireEvent.click(screen.getByRole('button', { name: '投影' }))

      expect(await screen.findByText('Skills 操作失败')).toBeDefined()
      expect(screen.getByText('投影失败: stale yaml')).toBeDefined()
      await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 1))

      fireEvent.click(screen.getByRole('button', { name: '关闭“Skills 操作失败”' }))

      fireEvent.click(screen.getByRole('button', { name: '投影' }))

      await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 2))
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 2))
      await waitFor(() => expect(screen.queryByText('Skills 操作失败')).toBeNull())
    } finally {
      consoleError.mockRestore()
    }
  })

  it('defaults every group to collapsed and supports bulk and individual toggles', async () => {
    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    const expandAll = await screen.findByRole('button', { name: '全部展开' })
    expect(screen.getByText('批量设置 · 应用于全部 skills')).toBeDefined()
    expect(screen.queryByRole('link', { name: '在 Settings 中修改 agents' })).toBeNull()
    expect(screen.queryByText('systematic-debugging')).toBeNull()
    expect(screen.queryByText('test-qa-skill')).toBeNull()

    fireEvent.click(expandAll)
    expect(screen.getByRole('button', { name: '全部收起' })).toBeDefined()
    expect(screen.getByText('systematic-debugging')).toBeDefined()

    const sourceRow = screen.getByTestId('source-skill-systematic-debugging')
    const sourceBundleIcon = screen
      .getByTestId('source-bundle-icon-systematic-debugging')
      .querySelector('svg')
    expect(sourceBundleIcon).not.toBeNull()
    expect(sourceBundleIcon?.getAttribute('width')).toBe('12')
    expect(within(sourceRow).getByText('skills/systematic-debugging')).toBeDefined()
    expect(within(sourceRow).queryByText('skills/systematic-debugging/SKILL.md')).toBeNull()
    expect(
      within(sourceRow).getByText('A disciplined debugging loop for bugs and regressions.'),
    ).toBeDefined()
    const sourceFileLink = within(sourceRow).getByRole('link', {
      name: '在仓库中打开 systematic-debugging 的 SKILL.md',
    })
    expect(sourceFileLink.getAttribute('href')).toBe(
      'https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md',
    )

    const localRow = screen.getByTestId('local-skill-test-qa-skill')
    const localBundleIcon = screen
      .getByTestId('local-bundle-icon-test-qa-skill')
      .querySelector('svg')
    expect(localBundleIcon).not.toBeNull()
    expect(localBundleIcon?.getAttribute('width')).toBe('12')
    const localGroupHead = screen.getByTestId('skill-group-head-local')
    expect(within(localGroupHead).getByText('assets/skills')).toBeDefined()
    expect(within(localRow).getByText('ref')).toBeDefined()
    expect(screen.getByTestId('local-skill-path-test-qa-skill').textContent?.trim()).toBe(
      'test-qa-skill',
    )
    expect(within(localRow).queryByText('assets/skills/test-qa-skill')).toBeNull()
    expect(within(localRow).queryByText('assets/skills/test-qa-skill/SKILL.md')).toBeNull()
    expect(within(localRow).queryByText('本地路径')).toBeNull()
    expect(within(localRow).queryByText('projected')).toBeNull()

    expect(within(localRow).queryByText('OC')).toBeNull()
    expect(within(localRow).getByText('路径不存在')).toBeDefined()
    expect(within(localRow).queryByRole('button', { name: 'test-qa-skill' })).toBeNull()

    const frontendRow = screen.getByTestId('local-skill-frontend-design')
    expect(screen.getByTestId('local-skill-path-frontend-design').textContent?.trim()).toBe(
      'frontend-design',
    )
    expect(within(frontendRow).queryByText('assets/skills/frontend-design')).toBeNull()
    expect(
      within(frontendRow).getByText('Design guidance for distinctive front-end UI.'),
    ).toBeDefined()
    expect(
      within(frontendRow).queryByRole('button', {
        name: '打开 frontend-design 的文件夹',
      }),
    ).toBeNull()
    fireEvent.click(within(frontendRow).getByRole('button', { name: 'Codex' }))
    await waitFor(() =>
      expect(api.updateLocalSkillAgents).toHaveBeenCalledWith({
        repo: '/tmp/skills-layout',
        id: 'frontend-design',
        agents: ['codex'],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '折叠 superpowers' }))
    expect(screen.queryByText('systematic-debugging')).toBeNull()
    expect(screen.getByTestId('local-skill-test-qa-skill')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '全部收起' }))
    expect(screen.getByRole('button', { name: '全部展开' })).toBeDefined()
    expect(screen.queryByText('test-qa-skill')).toBeNull()
  })

  it('projects skills after an individual agent chip is toggled', async () => {
    const projectCallsBefore = vi.mocked(api.project).mock.calls.length
    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '全部展开' }))
    const frontendRow = screen.getByTestId('local-skill-frontend-design')
    fireEvent.click(within(frontendRow).getByRole('button', { name: 'Codex' }))

    await waitFor(() =>
      expect(api.updateLocalSkillAgents).toHaveBeenCalledWith({
        repo: '/tmp/skills-layout',
        id: 'frontend-design',
        agents: ['codex'],
      }),
    )
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 1))
    expect(api.project).toHaveBeenLastCalledWith({ repo: '/tmp/skills-layout', scope: 'skills' })
  })

  it('supports source-level bulk projection chips in the source header', async () => {
    const projectCallsBefore = vi.mocked(api.project).mock.calls.length
    const updateCallsBefore = vi.mocked(api.updateSkillAgents).mock.calls.length
    const sourceUpdateCallsBefore = vi.mocked(api.updateSourceSkillAgents).mock.calls.length
    const manifest = {
      skills: {
        sources: [
          {
            name: 'openai-skills',
            url: 'https://github.com/obra/superpowers.git',
            ref: 'v6.1.1',
            type: 'tag',
            members: [
              { name: 'brainstorming', entry: 'brainstorming/SKILL.md', agents: ['codex'] },
              { name: 'executing-plans', entry: 'executing-plans/SKILL.md', agents: [] },
              { name: 'disabled-skill', entry: 'disabled-skill/SKILL.md', agents: [] },
            ],
          },
        ],
        skills: [{ id: 'local-only', agents: [] }],
      },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code', 'codex', 'opencode'] },
      errors: [],
    }

    render(
      <TestRouter>
        <SkillSourceListHarness
          repoPath="/tmp/skills-layout"
          manifest={manifest}
          onOpenDetail={vi.fn()}
          onOpenScan={vi.fn()}
          onOpenEdit={vi.fn()}
          expandedGroups={new Set(['https://github.com/obra/superpowers.git-v6.1.1'])}
          onToggleGroup={vi.fn()}
        />
      </TestRouter>,
    )

    const sourceBulkCodex = screen.getByRole('button', {
      name: 'openai-skills Codex：部分已选择',
    })
    expect(sourceBulkCodex).toBeDefined()
    fireEvent.click(sourceBulkCodex)

    await waitFor(() =>
      expect(api.updateSourceSkillAgents).toHaveBeenCalledTimes(sourceUpdateCallsBefore + 1),
    )
    expect(api.updateSourceSkillAgents).toHaveBeenLastCalledWith({
      repo: '/tmp/skills-layout',
      sourceUrl: 'https://github.com/obra/superpowers.git',
      updates: [
        { memberEntry: 'brainstorming/SKILL.md', agents: ['codex'] },
        { memberEntry: 'executing-plans/SKILL.md', agents: ['codex'] },
        { memberEntry: 'disabled-skill/SKILL.md', agents: ['codex'] },
      ],
    })
    expect(api.updateSkillAgents).toHaveBeenCalledTimes(updateCallsBefore)
    expect(api.updateLocalSkillAgents).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-only' }),
    )
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 1))
    expect(api.project).toHaveBeenLastCalledWith({ repo: '/tmp/skills-layout', scope: 'skills' })
  })

  it('updates skill bulk agents one item at a time', async () => {
    let releaseFirst!: () => void
    const sourceCallsBefore = vi.mocked(api.updateSkillAgents).mock.calls.length
    const localCallsBefore = vi.mocked(api.updateLocalSkillAgents).mock.calls.length
    vi.mocked(api.updateSkillAgents).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ ok: true })
        }) as never,
    )

    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Codex：部分已选择' }))

    await waitFor(() => expect(api.updateSkillAgents).toHaveBeenCalledTimes(sourceCallsBefore + 1))
    expect(api.updateLocalSkillAgents).toHaveBeenCalledTimes(localCallsBefore)

    releaseFirst()
    await waitFor(() =>
      expect(api.updateLocalSkillAgents).toHaveBeenCalledTimes(localCallsBefore + 2),
    )
    vi.mocked(api.updateSkillAgents).mockResolvedValue({ ok: true } as never)
  })
})

describe('Add Skill modal', () => {
  it('uses the responsive workbench shell for local skills and sources', async () => {
    render(<AddSkillModal open repoPath="/tmp/add-workbench" onClose={vi.fn()} />)

    const dialog = await screen.findByRole('dialog', { name: 'Add Skill or Source' })
    expect(within(dialog).getByTestId('skills-workbench')).toBeDefined()
    expect(within(dialog).getByTestId('skills-config-pane')).toBeDefined()
    expect(within(dialog).getByTestId('skills-results-pane')).toBeDefined()
    expect(within(dialog).getByText('Add')).toBeDefined()
    expect(within(dialog).getByRole('heading', { name: 'Skills' })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Scan directory' })).toBeDefined()

    const localMode = within(dialog).getByRole('button', { name: 'Local skill' })
    const sourceMode = within(dialog).getByRole('button', { name: 'Source' })
    expect(localMode.getAttribute('aria-pressed')).toBe('true')
    expect(sourceMode.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(sourceMode)
    expect(localMode.getAttribute('aria-pressed')).toBe('false')
    expect(sourceMode.getAttribute('aria-pressed')).toBe('true')
    expect(within(dialog).getByRole('heading', { name: 'New source' })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Refresh repository tree' })).toBeDefined()
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Repository ref' })).toBeDefined()
  })

  it('closes the repository ref dropdown before closing the modal on Escape', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main', 'release/6.1'],
      tags: [],
    } as never)
    render(<AddSkillModal open repoPath="/tmp/add-dropdown-escape" onClose={onClose} />)

    const dialog = await screen.findByRole('dialog', { name: 'Add Skill or Source' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }))
    const url = within(dialog).getByPlaceholderText('https://host.example/org/repo.git')
    fireEvent.change(url, { target: { value: 'https://example.test/skills.git' } })
    const trigger = await within(dialog).findByRole('button', { name: 'Repository ref' })
    fireEvent.click(trigger)
    const option = await within(dialog).findByRole('option', { name: 'main' })
    fireEvent.keyDown(option, { key: 'Escape' })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Add Skill or Source' })).toBeDefined()
  })

  it('ignores refs returned for an earlier repository URL', async () => {
    let resolveFirst!: (value: unknown) => void
    vi.mocked(api.getSourceRefs)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }) as never,
      )
      .mockResolvedValueOnce({ ok: true, branches: ['repo-b'], tags: [] } as never)

    render(<AddSkillModal open repoPath="/tmp/add-refs-race" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    const url = screen.getByPlaceholderText('https://host.example/org/repo.git')

    fireEvent.change(url, { target: { value: 'https://example.test/repo-a.git' } })
    const refButton = screen.getByRole('button', { name: 'Repository ref' })
    fireEvent.click(refButton)
    fireEvent.keyDown(refButton, { key: 'Escape' })
    fireEvent.change(url, { target: { value: 'https://example.test/repo-b.git' } })
    fireEvent.click(refButton)

    await waitFor(() => expect(refButton.textContent).toContain('repo-b'))

    resolveFirst({ ok: true, branches: ['repo-a'], tags: [] })
    await act(async () => await Promise.resolve())

    expect(refButton.textContent).toContain('repo-b')
    expect(refButton.textContent).not.toContain('repo-a')
  })

  it('loads refs again when Add Source is reopened while refs are pending', async () => {
    vi.mocked(api.getSourceRefs)
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            // Keep the first editing session pending.
          }) as never,
      )
      .mockResolvedValueOnce({ ok: true, branches: ['main'], tags: [] } as never)
    const refsCallCount = vi.mocked(api.getSourceRefs).mock.calls.length
    const onClose = vi.fn()
    const rendered = render(
      <AddSkillModal open repoPath="/tmp/add-refs-reopen" onClose={onClose} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://example.test/pending.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Repository ref' }))
    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount + 1))

    rendered.rerender(
      <AddSkillModal open={false} repoPath="/tmp/add-refs-reopen" onClose={onClose} />,
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add Skill or Source' })).toBeNull(),
    )
    rendered.rerender(<AddSkillModal open repoPath="/tmp/add-refs-reopen" onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://example.test/pending.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Repository ref' }))

    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount + 2))
    expect(await screen.findByRole('option', { name: 'main' })).toBeDefined()
  })

  it('does not load refs when the Add Source URL loses focus', async () => {
    const refsCallCount = vi.mocked(api.getSourceRefs).mock.calls.length
    render(<AddSkillModal open repoPath="/tmp/add-refs-lazy" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    const url = screen.getByPlaceholderText('https://host.example/org/repo.git')
    fireEvent.change(url, { target: { value: 'https://example.test/lazy.git' } })
    fireEvent.blur(url)
    fireEvent.click(screen.getByRole('button', { name: 'branch' }))
    await act(async () => await Promise.resolve())

    expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount)
    expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('lazy')
  })

  it('ignores a source scan returned after its repository configuration changed', async () => {
    let resolveScan!: (value: unknown) => void
    vi.mocked(api.scanSource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        }) as never,
    )

    render(<AddSkillModal open repoPath="/tmp/add-scan-race" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    const url = screen.getByPlaceholderText('https://host.example/org/repo.git')
    fireEvent.change(url, { target: { value: 'https://example.test/repo-a.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))
    fireEvent.change(url, { target: { value: 'https://example.test/repo-b.git' } })

    resolveScan({
      ok: true,
      tree: {
        commit: 'stale123',
        diagnostics: [],
        nodes: [
          {
            kind: 'bundle',
            name: 'stale',
            path: 'stale',
            entry: 'stale/SKILL.md',
            mode: '040000',
            oid: 'stale-bundle',
          },
        ],
      },
    })
    await act(async () => await Promise.resolve())

    expect(screen.queryByRole('checkbox', { name: 'Select stale' })).toBeNull()
  })

  it('scans ~/.agents/skills when opened', async () => {
    render(<AddSkillModal open repoPath="/tmp/r" onClose={vi.fn()} />)
    await waitFor(() =>
      expect(api.scanLocalSkills).toHaveBeenCalledWith('~/.agents/skills', '/tmp/r'),
    )
  })

  it('filters local skill scan results through the shared selectable list', async () => {
    vi.mocked(api.scanLocalSkills).mockResolvedValueOnce({
      ok: true,
      skills: [
        { name: 'alpha-skill', path: '/skills/alpha/SKILL.md' },
        { name: 'beta-skill', path: '/skills/beta/SKILL.md' },
      ],
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-local-filter" onClose={vi.fn()} />)

    await screen.findByText('alpha-skill')
    fireEvent.click(screen.getByRole('checkbox', { name: 'alpha-skill' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'beta' },
    })

    expect(screen.queryByText('alpha-skill')).toBeNull()
    expect(screen.getByText('beta-skill')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '添加 Local Skill' }))

    await waitFor(() =>
      expect(api.importLocalSkills).toHaveBeenCalledWith({
        repo: '/tmp/add-local-filter',
        skills: [{ name: 'beta-skill', path: '/skills/beta/SKILL.md' }],
        mode: 'ref',
      }),
    )
  })

  it('selects discovered bundles without exposing agent controls in Add Source', async () => {
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      tree: {
        commit: 'abc123456789',
        diagnostics: [],
        nodes: [
          {
            kind: 'bundle',
            name: 'fresh',
            path: 'fresh',
            entry: 'fresh/SKILL.md',
            description: 'Fresh skill description',
            mode: '040000',
            oid: 'bundle-1',
          },
        ],
      },
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-disabled" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://example.test/source.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))

    await screen.findByRole('checkbox', { name: 'Select fresh' })
    expect(screen.getByText('Fresh skill description')).toBeDefined()
    expect(screen.getByTitle('fresh/SKILL.md').textContent).toBe('fresh')
    expect(
      (screen.getByRole('checkbox', { name: 'Select fresh' }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.queryByText('Projection agents')).toBeNull()
  })

  it('clears an Add Source scan error when the repository configuration changes', async () => {
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: false,
      message: 'repository tree unavailable',
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-error" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    const url = screen.getByPlaceholderText('https://host.example/org/repo.git')
    fireEvent.change(url, {
      target: { value: 'https://example.test/source.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))

    expect(await screen.findByText('repository tree unavailable')).toBeDefined()
    expect(screen.getAllByText('repository tree unavailable')).toHaveLength(1)

    fireEvent.change(url, {
      target: { value: 'https://example.test/other.git' },
    })

    expect(screen.queryByText('repository tree unavailable')).toBeNull()
  })

  it('scans a source after switching ref type and atomically adds the tree selection', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: ['v1.0.1'],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      tree: {
        commit: 'def5678',
        diagnostics: [],
        nodes: [
          {
            kind: 'bundle',
            name: 'tdd',
            path: 'skills/engineering/tdd',
            entry: 'skills/engineering/tdd/SKILL.md',
            mode: '040000',
            oid: 'bundle-2',
          },
        ],
      },
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-ref-scan" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://github.com/mattpocock/skills' },
    })
    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('skills'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'tag' }))
    await waitFor(() =>
      expect(api.getSourceRefs).toHaveBeenCalledWith('https://github.com/mattpocock/skills'),
    )

    expect(
      await screen.findByRole('checkbox', { name: 'Select skills/engineering/tdd' }),
    ).toBeDefined()
    expect(api.scanSource).toHaveBeenCalledWith({
      name: 'skills',
      url: 'https://github.com/mattpocock/skills',
      type: 'tag',
      ref: 'v1.0.1',
    })

    fireEvent.click(screen.getByRole('button', { name: '添加 Source' }))

    await waitFor(() =>
      expect(api.addSource).toHaveBeenCalledWith({
        repo: '/tmp/add-source-ref-scan',
        name: 'skills',
        url: 'https://github.com/mattpocock/skills',
        type: 'tag',
        ref: 'v1.0.1',
        members: [{ name: 'tdd', entry: 'skills/engineering/tdd/SKILL.md' }],
        resources: { include: [], exclude: [] },
      }),
    )
  })

  it('keeps a scanned root bundle aligned with an edited Add Source name', async () => {
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      tree: {
        commit: 'root-commit',
        diagnostics: [],
        nodes: [
          {
            kind: 'bundle',
            name: 'root-skill',
            path: '',
            entry: 'SKILL.md',
            mode: '040000',
            oid: 'root-bundle',
          },
        ],
      },
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-root-source" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://example.test/my_skills.git' },
    })
    const sourceName = screen.getByLabelText('source name')
    fireEvent.change(sourceName, { target: { value: 'root-skill' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))
    await screen.findByRole('checkbox', { name: 'Select SKILL.md' })

    fireEvent.change(sourceName, { target: { value: 'renamed-root' } })
    fireEvent.click(screen.getByRole('button', { name: '添加 Source' }))

    await waitFor(() =>
      expect(api.addSource).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'renamed-root',
          members: [{ name: 'renamed-root', entry: 'SKILL.md' }],
        }),
      ),
    )
  })

  it('keeps an Add Source default-branch scan pinned to HEAD after refs load', async () => {
    vi.mocked(api.scanSource).mockResolvedValueOnce(sourceTreeResponse(['fresh']) as never)
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['trunk'],
      tags: [],
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-head" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://example.test/default-branch.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))
    await screen.findByRole('checkbox', { name: 'Select fresh' })

    const refButton = screen.getByRole('button', { name: 'Repository ref' })
    fireEvent.click(refButton)
    await screen.findByRole('option', { name: 'trunk' })
    await waitFor(() => expect(refButton.textContent).toContain('HEAD'))
    fireEvent.keyDown(refButton, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '添加 Source' }))

    await waitFor(() =>
      expect(api.addSource).toHaveBeenCalledWith({
        repo: '/tmp/add-source-head',
        name: 'default-branch',
        url: 'https://example.test/default-branch.git',
        ref: 'HEAD',
        type: 'branch',
        members: [{ name: 'fresh', entry: 'fresh/SKILL.md' }],
        resources: { include: [], exclude: [] },
      }),
    )
  })

  it('does not overwrite a manually edited Add Source name after URL changes', async () => {
    render(<AddSkillModal open repoPath="/tmp/add-source-name" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByLabelText('source name'), {
      target: { value: 'custom-skills' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://github.com/org/repo-one' },
    })
    await act(async () => await Promise.resolve())

    expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('custom-skills')
  })

  it('refreshes the Add Source default name when URL changes before manual name edits', async () => {
    render(<AddSkillModal open repoPath="/tmp/add-source-name-refresh" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://github.com/org/repo-one' },
    })
    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('repo-one'),
    )

    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://github.com/org/repo-two' },
    })

    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('repo-two'),
    )
  })

  it('keeps the source modal open when the atomic source write fails', async () => {
    const onClose = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const getManifestCallsBefore = vi.mocked(api.getManifest).mock.calls.length
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      tree: {
        commit: 'abc1234',
        diagnostics: [],
        nodes: [
          {
            kind: 'bundle',
            name: 'alpha',
            path: 'alpha',
            entry: 'alpha/SKILL.md',
            mode: '040000',
            oid: 'bundle-3',
          },
        ],
      },
    } as never)
    vi.mocked(api.addSource).mockResolvedValueOnce({
      ok: false,
      message: 'source write failed',
    } as never)

    try {
      render(<AddSkillModal open repoPath="/tmp/r" onClose={onClose} />)

      const dialog = await screen.findByRole('dialog', { name: 'Add Skill or Source' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }))
      fireEvent.change(within(dialog).getByPlaceholderText('https://host.example/org/repo.git'), {
        target: { value: 'https://example.test/skills.git' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh repository tree' }))
      expect(await within(dialog).findByRole('checkbox', { name: 'Select alpha' })).toBeDefined()

      fireEvent.click(within(dialog).getByRole('button', { name: '添加 Source' }))

      expect((await within(dialog).findAllByText(/source write failed/)).length).toBeGreaterThan(0)
      expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore)
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog', { name: 'Add Skill or Source' })).toBeDefined()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:add',
          result: expect.objectContaining({ ok: false }),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('Skill source updates', () => {
  it('shows a spinning icon while checking a source update', async () => {
    let releaseCheck!: () => void
    vi.mocked(api.update).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve({ updates: [] })
        }) as never,
    )

    render(
      <SkillSourceListHarness
        repoPath="/tmp/check-source"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'main',
                  members: [],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set()}
        onToggleGroup={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '检查更新 source superpowers' }))

    const button = await screen.findByRole('button', { name: '检查更新 source superpowers' })
    expect(button.querySelector('.animate-spin')).not.toBeNull()

    releaseCheck()
    await waitFor(() => expect(button.querySelector('.animate-spin')).toBeNull())
  })

  it('opens local skill detail when clicking blank space in the local skill row', () => {
    const onOpenDetail = vi.fn()
    render(
      <SkillSourceListHarness
        repoPath="/tmp/local-detail"
        manifest={
          {
            skills: {
              sources: [],
              skills: [{ id: 'frontend-design', agents: ['codex'] }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: ['codex'] },
            errors: [],
          } as never
        }
        onOpenDetail={onOpenDetail}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(['local'])}
        onToggleGroup={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('local-skill-frontend-design'))

    expect(onOpenDetail).toHaveBeenCalledWith({
      skillId: 'frontend-design',
      path: undefined,
      agents: ['codex'],
    })
  })

  it('copies the SKILL.md preview content from the detail modal', async () => {
    const content =
      '---\nname: test-qa-skill\ndescription: Preview description\n---\n# test-qa-skill\nBody'
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({ ok: true, content })
    const showToast = vi.fn()

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-layout"
        agents={agentIds}
        detail={{
          skillId: 'test-qa-skill',
          path: './assets/skills/test-qa-skill',
          agents: ['codex'],
        }}
        showToast={showToast}
        onClose={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'test-qa-skill' })
    await within(dialog).findByText('Preview description')
    expect(within(dialog).queryByText(/name: test-qa-skill/)).toBeNull()
    expect(within(dialog).queryByText(/description: Preview description/)).toBeNull()
    expect(within(dialog).queryByText('metadata')).toBeNull()
    expect(within(dialog).getByText('name')).toBeDefined()
    expect(
      within(dialog).getAllByRole('heading', { level: 1, name: 'test-qa-skill' }).length,
    ).toBeGreaterThan(0)
    fireEvent.click(within(dialog).getByRole('button', { name: '复制 SKILL.md' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(content))
    expect(showToast).toHaveBeenCalledWith('已复制 SKILL.md')
  })

  it('refreshes the manifest after saving local SKILL.md content', async () => {
    const original = '---\nname: frontend-design\ndescription: Old description\n---\n# Skill'
    const updated = '---\nname: frontend-design\ndescription: Updated description\n---\n# Skill'
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({ ok: true, content: original })
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: {
        sources: [],
        skills: [{ id: 'frontend-design', description: 'Updated description' }],
      },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex'] },
      errors: [],
    } as never)
    const showToast = vi.fn()

    render(
      <SkillDetailEditor
        repoPath="/tmp/skill-save-refresh"
        agents={agentIds}
        detail={{
          skillId: 'frontend-design',
          path: './assets/skills/frontend-design',
          agents: ['codex'],
        }}
        showToast={showToast}
        onClose={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'frontend-design' })
    fireEvent.click(await within(dialog).findByRole('tab', { name: 'Source' }))
    const skillEditor = within(dialog).getByRole('textbox', { name: 'SKILL.md 内容' })
    expect(
      monacoEditorMock.props.some(
        (props) => props.language === 'markdown' && props.height === '100%',
      ),
    ).toBe(true)
    fireEvent.change(skillEditor, { target: { value: updated } })
    expect(within(dialog).getByText('Unsaved')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save SKILL.md' }))

    await waitFor(() =>
      expect(api.saveSkillContent).toHaveBeenCalledWith({
        repo: '/tmp/skill-save-refresh',
        skillId: 'frontend-design',
        localPath: './assets/skills/frontend-design',
        content: updated,
      }),
    )
    await waitFor(() => expect(api.getManifest).toHaveBeenCalledWith('/tmp/skill-save-refresh'))
    expect(showToast).toHaveBeenCalledWith('已保存')
    expect(within(dialog).getByText('Saved')).toBeDefined()
  })

  it('logs the full object when editable Markdown save fails', async () => {
    const err = new Error('save denied')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      render(
        <MarkdownPreview
          content="# Frontend design"
          editable
          onSave={vi.fn().mockRejectedValue(err)}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: '编辑' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'SKILL.md 内容' }), {
        target: { value: '# Changed' },
      })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))

      expect(await screen.findByText('save denied')).toBeDefined()
      expect(consoleError).toHaveBeenCalledWith({ err }, 'Failed to save Markdown source')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('opens source member detail with the configured source member skill id', () => {
    const onOpenDetail = vi.fn()
    render(
      <SkillSourceListHarness
        repoPath="/tmp/detail-source"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'main',
                  members: [
                    {
                      name: 'systematic-debugging',
                      entry: 'skills/engineering/systematic-debugging/SKILL.md',
                      agents: ['codex'],
                      path: 'skills/engineering/systematic-debugging/SKILL.md',
                    },
                  ],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: ['codex'], skill_naming: 'hyphen' },
            errors: [],
          } as never
        }
        onOpenDetail={onOpenDetail}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(['https://github.com/obra/superpowers.git-main'])}
        onToggleGroup={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('systematic-debugging'))

    expect(onOpenDetail).toHaveBeenCalledWith({
      skillId: 'superpowers-systematic-debugging',
      source: 'https://github.com/obra/superpowers.git',
      path: 'skills/engineering/systematic-debugging/SKILL.md',
      agents: ['codex'],
    })
  })

  it('keeps an expanded source list stable when invalid manifest members have no entry', () => {
    render(
      <SkillSourceListHarness
        repoPath="/tmp/invalid-source-member"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'v6.1.1',
                  members: [{ name: 'brainstorming', agents: [] }],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: ['codex'] },
            errors: ['source[0].members.0.entry: Required'],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(['https://github.com/obra/superpowers.git-v6.1.1'])}
        onToggleGroup={vi.fn()}
      />,
    )

    expect(screen.getByTestId('source-skill-brainstorming')).toBeDefined()
    expect(screen.getByTestId('source-skill-path-brainstorming').textContent).toBe(
      'skills/brainstorming',
    )
  })

  it('shows saved source resources separately and toggles them without collapsing skills', () => {
    render(
      <SkillSourceListHarness
        repoPath="/tmp/source-resources"
        manifest={
          {
            skills: {
              sources: [
                {
                  name: 'plm-harness',
                  url: 'git@gitcode.com:HarnessPlatform/Marketplace.git',
                  ref: 'main',
                  members: [
                    {
                      name: 'so-apply',
                      entry: 'plugins/plm-harness/skills/so-apply/SKILL.md',
                      agents: [],
                    },
                  ],
                  resources: {
                    include: [
                      { path: 'plugins/plm-harness/_shared', kind: 'directory' },
                      { path: 'plugins/plm-harness/README.md', kind: 'file' },
                    ],
                    exclude: [{ path: 'plugins/plm-harness/_shared/private', kind: 'directory' }],
                  },
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(['git@gitcode.com:HarnessPlatform/Marketplace.git-main'])}
        onToggleGroup={vi.fn()}
      />,
    )

    expect(screen.getByTestId('source-resource-include-plugins/plm-harness/_shared')).toBeDefined()
    expect(screen.getByText('plugins/plm-harness/README.md')).toBeDefined()
    expect(screen.getByText('excluded · directory')).toBeDefined()
    expect(screen.getByTestId('source-skill-path-so-apply').textContent).toBe(
      'plugins/plm-harness/skills/so-apply',
    )
    fireEvent.click(screen.getByRole('button', { name: '隐藏 plm-harness resources' }))

    expect(screen.queryByText('plugins/plm-harness/_shared')).toBeNull()
    expect(screen.getByTestId('source-skill-so-apply')).toBeDefined()
    expect(screen.getByRole('button', { name: '显示 plm-harness resources' })).toBeDefined()
  })

  it('uses persisted DOM group order and never starts sorting from a member row', () => {
    const onReorderGroups = vi.fn()
    render(
      <SkillSourceListHarness
        repoPath="/tmp/group-sort-scope"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://example.test/source',
                  ref: 'main',
                  members: [{ name: 'member', entry: 'member/SKILL.md', agents: [] }],
                },
              ],
              skills: [{ id: 'local-skill', agents: [] }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(['https://example.test/source-main'])}
        onToggleGroup={vi.fn()}
        groupOrder={['local', 'source:https://example.test/source']}
        onReorderGroups={onReorderGroups}
      />,
    )

    const localGroup = screen.getByTestId('skill-group-head-local').parentElement?.parentElement
    const sourceGroup = screen.getByTestId('skill-group-head-source').parentElement?.parentElement
    expect(localGroup?.compareDocumentPosition(sourceGroup!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    const member = screen.getByTestId('source-skill-member')
    fireEvent.mouseDown(member, { clientX: 20, clientY: 20 })
    fireEvent.mouseMove(document, { clientX: 40, clientY: 40 })
    fireEvent.mouseUp(document)
    expect(onReorderGroups).not.toHaveBeenCalled()
  })

  it('does not start group sorting from spacing outside the group header', () => {
    render(
      <SkillSourceListHarness
        repoPath="/tmp/group-sort-gap"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://example.test/source',
                  ref: 'main',
                  members: [],
                },
              ],
              skills: [{ id: 'local-skill', agents: [] }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set()}
        onToggleGroup={vi.fn()}
      />,
    )

    const sourceGroup = screen.getByLabelText('调整 source:https://example.test/source 顺序')
    act(() => {
      fireEvent.mouseDown(sourceGroup, { clientX: 100, clientY: 100 })
      fireEvent.mouseMove(document, { clientX: 112, clientY: 100 })
    })

    expect(sourceGroup.getAttribute('data-dragging')).toBeNull()
    act(() => fireEvent.mouseUp(document))
  })

  it('keeps the complete source header visible in the group drag overlay', async () => {
    render(
      <SkillSourceListHarness
        repoPath="/tmp/group-sort-overlay"
        manifest={
          {
            skills: {
              sources: [
                {
                  name: 'mxp-xc',
                  url: 'https://github.com/mxp-xc/agents',
                  ref: 'main',
                  type: 'branch',
                  members: [],
                },
              ],
              skills: [{ id: 'local-skill', agents: [] }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set()}
        onToggleGroup={vi.fn()}
      />,
    )

    const sourceGroup = screen.getByLabelText('调整 source:https://github.com/mxp-xc/agents 顺序')
    const sourceHeader = screen.getByTestId('skill-group-head-mxp-xc')
    sourceGroup.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 100, width: 700, height: 52 })
    sourceHeader.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 100, width: 700, height: 52 })

    act(() => {
      fireEvent.mouseDown(sourceHeader, { clientX: 100, clientY: 120 })
      fireEvent.mouseMove(document, { clientX: 112, clientY: 120 })
    })

    await waitFor(() => expect(sourceGroup.getAttribute('data-dragging')).toBe('true'))
    expect(document.body.dataset.skillGroupDragging).toBe('true')
    const overlay = document.querySelector('[class*="group-overlay"]')
    expect(overlay?.textContent).toContain('mxp-xc')
    expect(overlay?.textContent).toContain('branch')
    expect(overlay?.textContent).toContain('https://github.com/mxp-xc/agents')
    expect(overlay?.textContent).toContain('@ main')
    await act(async () => {
      fireEvent.mouseUp(document)
      await new Promise((resolve) => window.setTimeout(resolve, 200))
    })
    expect(document.body.dataset.skillGroupDragging).toBeUndefined()
  })

  it('renders source members in the same sorted order used by scan', () => {
    render(
      <SkillSourceListHarness
        repoPath="/tmp/source-order"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'main',
                  members: [
                    { name: 'writing-plans', entry: 'writing-plans/SKILL.md', agents: [] },
                    { name: 'brainstorming', entry: 'brainstorming/SKILL.md', agents: [] },
                    { name: 'executing-plans', entry: 'executing-plans/SKILL.md', agents: [] },
                  ],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: ['opencode'] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(['https://github.com/obra/superpowers.git-main'])}
        onToggleGroup={vi.fn()}
      />,
    )

    const names = screen
      .getAllByTestId(/^source-skill-(?!path-)/)
      .map((row) => row.getAttribute('data-testid')?.replace('source-skill-', ''))
    expect(names).toEqual(['brainstorming', 'executing-plans', 'writing-plans'])
  })

  it('toggles from the group header but not from links or actions', () => {
    const onToggleGroup = vi.fn()
    const onOpenEdit = vi.fn()
    render(
      <SkillSourceListHarness
        repoPath="/tmp/header-click"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'main',
                  members: [],
                },
              ],
              skills: [{ id: 'local-skill' }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: ['claude-code'] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={onOpenEdit}
        expandedGroups={new Set()}
        onToggleGroup={onToggleGroup}
      />,
    )

    const expandLocal = screen.getByRole('button', { name: '展开 local skills' })
    fireEvent.click(screen.getByTestId('skill-group-head-local'))
    expect(onToggleGroup).toHaveBeenLastCalledWith('local')

    const expand = screen.getByRole('button', { name: '展开 superpowers' })
    fireEvent.click(screen.getByTestId('skill-group-head-superpowers'))
    expect(onToggleGroup).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('link'))
    fireEvent.click(screen.getByRole('button', { name: '编辑 source superpowers' }))
    expect(onToggleGroup).toHaveBeenCalledTimes(2)
    expect(onOpenEdit).toHaveBeenCalledTimes(1)
  })

  it('maps SSH sources and forge-specific member links without changing row interactions', () => {
    const onToggleGroup = vi.fn()
    const onOpenDetail = vi.fn()
    const sources = [
      {
        name: 'marketplace',
        url: 'git@gitcode.com:HarnessPlatform/Marketplace.git',
        ref: 'main',
        members: [{ name: 'so-debug', path: 'skills/so-debug/SKILL.md' }],
      },
      {
        name: 'generic',
        url: 'git@forge.example:team/generic.git',
        ref: 'feature/new-ui',
        members: [{ name: 'generic-tool', path: 'nested/generic-tool/SKILL.md' }],
      },
      {
        name: 'invalid',
        url: '/local/source',
        ref: 'main',
        members: [{ name: 'invalid-tool', path: 'skills/invalid-tool/SKILL.md' }],
      },
    ]
    render(
      <SkillSourceListHarness
        repoPath="/tmp/source-web-links"
        manifest={
          {
            skills: { sources, skills: [] },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={onOpenDetail}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set(sources.map((source) => `${source.url}-${source.ref}`))}
        onToggleGroup={onToggleGroup}
      />,
    )

    const marketplaceHead = screen.getByTestId('skill-group-head-marketplace')
    expect(
      within(marketplaceHead)
        .getByRole('link', { name: 'git@gitcode.com:HarnessPlatform/Marketplace.git' })
        .getAttribute('href'),
    ).toBe('https://gitcode.com/HarnessPlatform/Marketplace')

    const gitcodeMemberLink = within(screen.getByTestId('source-skill-so-debug')).getByRole(
      'link',
      { name: '在仓库中打开 so-debug 的 SKILL.md' },
    )
    expect(gitcodeMemberLink.getAttribute('href')).toBe(
      'https://gitcode.com/HarnessPlatform/Marketplace/blob/main/skills/so-debug/SKILL.md',
    )
    expect(
      within(screen.getByTestId('source-skill-generic-tool'))
        .getByRole('link', { name: '在仓库中打开 generic-tool 的 SKILL.md' })
        .getAttribute('href'),
    ).toBe('https://forge.example/team/generic/blob/feature/new-ui/nested/generic-tool/SKILL.md')

    const invalidHead = screen.getByTestId('skill-group-head-invalid')
    expect(within(invalidHead).queryByRole('link')).toBeNull()
    expect(within(invalidHead).getByText('/local/source').tagName).toBe('SPAN')
    expect(within(screen.getByTestId('source-skill-invalid-tool')).queryByRole('link')).toBeNull()

    fireEvent.click(gitcodeMemberLink)
    expect(onOpenDetail).not.toHaveBeenCalled()
    expect(onToggleGroup).not.toHaveBeenCalled()
  })

  it('updates a tag source to the latest tag returned by Check', async () => {
    vi.mocked(api.update).mockResolvedValueOnce({
      updates: [
        {
          hasUpdate: true,
          latestTag: 'v6.1.1',
          latestCommit: 'bbb',
        },
      ],
    } as never)

    render(
      <SkillSourceListHarness
        repoPath="/tmp/tag-update"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'v6.0.3',
                  type: 'tag',
                  pinned_commit: 'bbb',
                  members: [],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        showToast={vi.fn()}
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set()}
        onToggleGroup={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '检查更新 source superpowers' }))
    fireEvent.click(await screen.findByRole('button', { name: '更新 source superpowers' }))

    await waitFor(() =>
      expect(api.prepareSourceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ newRef: 'v6.1.1' }),
      ),
    )
  })

  it('requires confirmation before deleting a source', async () => {
    render(
      <SkillSourceListHarness
        repoPath="/tmp/delete-source"
        manifest={
          {
            skills: {
              sources: [
                {
                  url: 'https://github.com/obra/superpowers.git',
                  ref: 'main',
                  members: [],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { agents: [] },
            errors: [],
          } as never
        }
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set()}
        onToggleGroup={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '删除 source superpowers' }))
    expect(api.deleteSource).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: '删除 source' })
    expect(within(dialog).getByText(/superpowers/)).toBeDefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() =>
      expect(api.deleteSource).toHaveBeenCalledWith({
        repo: '/tmp/delete-source',
        url: 'https://github.com/obra/superpowers.git',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除 source' })).toBeNull())
  })
  it('loads Edit Source into the shared SourceTree selector', async () => {
    const refsCallCount = vi.mocked(api.getSourceRefs).mock.calls.length
    const scanCallCount = vi.mocked(api.scanSource).mock.calls.length
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(
      sourceTreeResponse(['brainstorming', 'systematic-debugging']) as never,
    )

    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '编辑 source superpowers' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Source · superpowers' })
    await within(dialog).findByRole('checkbox', { name: 'Select brainstorming' })

    expect(within(dialog).getByTestId('skills-config-pane')).toBeDefined()
    expect(within(dialog).getByTestId('skills-results-pane')).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Refresh repository tree' })).toBeDefined()
    expect(within(dialog).queryByText('Membership is up to date')).toBeNull()

    expect(dialog.className).toContain('dialog')
    expect(within(dialog).getByRole('tab', { name: 'Bundles' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(within(dialog).queryByText('Projection agents')).toBeNull()
    expect(api.getCachedSourceTree).toHaveBeenCalledWith({
      repo: '/tmp/skills-layout',
      url: 'https://github.com/obra/superpowers.git',
      pinned_commit: 'abc123456789',
    })
    expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount)
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount)
  })

  it('previews an Edit Source bundle without losing its selection', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(
      sourceTreeResponse(['brainstorming', 'systematic-debugging']) as never,
    )
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({
      ok: true,
      content: '# Preview skill',
    } as never)

    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '编辑 source superpowers' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Source · superpowers' })
    const checkbox = await within(dialog).findByRole('checkbox', { name: 'Select brainstorming' })
    fireEvent.click(checkbox)
    expect(within(dialog).queryByRole('region', { name: 'Preview brainstorming' })).toBeNull()

    const bundleLink = within(dialog).getByRole('link', { name: 'brainstorming' })
    const bundleRow = bundleLink.closest('[role="listitem"]')
    expect(bundleRow).not.toBeNull()
    fireEvent.click(bundleRow!)

    expect(
      await within(dialog).findByRole('region', { name: 'Preview brainstorming' }),
    ).toBeDefined()
    expect(await within(dialog).findByRole('heading', { name: 'Preview skill' })).toBeDefined()
    expect(api.getSkillContent).toHaveBeenCalledWith(
      '/tmp/skills-layout',
      'superpowers-brainstorming',
      'https://github.com/obra/superpowers.git',
      'brainstorming/SKILL.md',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(
      (await within(dialog).findByRole('checkbox', {
        name: 'Select brainstorming',
      })) as HTMLInputElement,
    ).toHaveProperty('checked', true)
  })

  it('keeps the locked repository URL scrolled to its beginning when focused', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    const url = within(dialog).getByDisplayValue(
      'https://example.test/alpha.git',
    ) as HTMLInputElement
    url.scrollLeft = 120
    url.setSelectionRange(url.value.length, url.value.length)

    fireEvent.focus(url)

    expect(url.scrollLeft).toBe(0)
    expect(url.selectionStart).toBe(0)
  })

  it('opens the Edit Source ref menu immediately while refs are loading', async () => {
    let resolveRefs!: (value: unknown) => void
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefs = resolve
        }) as never,
    )

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })

    const refButton = within(dialog).getByRole('button', { name: 'Repository ref' })
    fireEvent.click(refButton)

    const listbox = within(dialog).getByRole('listbox', { name: 'Repository ref' })
    expect(refButton.getAttribute('aria-expanded')).toBe('true')
    expect((refButton as HTMLButtonElement).disabled).toBe(false)
    expect(listbox.getAttribute('aria-busy')).toBe('true')
    const loadingStatus = within(listbox).getByRole('status')
    expect(loadingStatus.textContent).toBe('Loading refs…')
    expect(loadingStatus.querySelector('svg')).not.toBeNull()

    await act(async () => {
      resolveRefs({ ok: true, branches: ['main', 'release'], tags: [] })
      await Promise.resolve()
    })

    expect(await within(listbox).findByRole('option', { name: 'release' })).toBeDefined()
    expect(within(listbox).queryByRole('status')).toBeNull()
  })

  it('loads Edit Source refs on first dropdown open and scans only after another ref is selected', async () => {
    const refsCallCount = vi.mocked(api.getSourceRefs).mock.calls.length
    const scanCallCount = vi.mocked(api.scanSource).mock.calls.length
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main', 'release'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce(sourceTreeResponse(['release-skill']) as never)

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })

    expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount)
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount)
    fireEvent.click(within(dialog).getByRole('button', { name: 'branch' }))
    expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Repository ref' }))
    await within(dialog).findByRole('option', { name: 'release' })
    expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount + 1)
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount)

    fireEvent.click(within(dialog).getByRole('option', { name: 'main' }))
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Repository ref' }))
    const release = await within(dialog).findByRole('option', { name: 'release' })

    fireEvent.click(release)

    await waitFor(() =>
      expect(api.scanSource).toHaveBeenCalledWith({
        name: 'alpha-source',
        url: 'https://example.test/alpha.git',
        ref: 'release',
        type: 'branch',
      }),
    )
    expect(
      await within(dialog).findByRole('checkbox', { name: 'Select release-skill' }),
    ).toBeDefined()
  })

  it('keeps the latest Edit Source ref scan when the previous ref is still pending', async () => {
    let resolveRelease!: (value: unknown) => void
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main', 'release', 'next'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRelease = resolve
          }) as never,
      )
      .mockResolvedValueOnce(sourceTreeResponse(['next-skill'], 'next-commit') as never)

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })

    const refButton = within(dialog).getByRole('button', { name: 'Repository ref' })
    fireEvent.click(refButton)
    fireEvent.click(await within(dialog).findByRole('option', { name: 'release' }))
    fireEvent.click(refButton)
    fireEvent.click(await within(dialog).findByRole('option', { name: 'next' }))

    expect(await within(dialog).findByRole('checkbox', { name: 'Select next-skill' })).toBeDefined()
    await act(async () => {
      resolveRelease(sourceTreeResponse(['release-skill'], 'release-commit'))
      await Promise.resolve()
    })
    expect(within(dialog).queryByRole('checkbox', { name: 'Select release-skill' })).toBeNull()
    expect(within(dialog).getByRole('checkbox', { name: 'Select next-skill' })).toBeDefined()
  })

  it('applies Edit Source refs using the type currently selected by the user', async () => {
    let resolveRefs!: (value: unknown) => void
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefs = resolve
        }) as never,
    )
    vi.mocked(api.scanSource).mockResolvedValueOnce(
      sourceTreeResponse(['tag-skill'], 'tag-commit') as never,
    )

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })
    const scanCallCount = vi.mocked(api.scanSource).mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: 'tag' }))

    expect(within(dialog).getByText('Loading commit…')).toBeDefined()
    expect(within(dialog).getByText('Reading repository tree')).toBeDefined()

    await waitFor(() =>
      expect(api.getSourceRefs).toHaveBeenCalledWith('https://example.test/alpha.git'),
    )
    await act(async () => {
      resolveRefs({ ok: true, branches: ['main'], tags: ['v1.0.0'] })
      await Promise.resolve()
    })

    const refButton = within(dialog).getByRole('button', { name: 'Repository ref' })
    await waitFor(() => expect(refButton.textContent).toContain('v1.0.0'))
    expect(refButton.textContent).not.toContain('main')
    await waitFor(() =>
      expect(api.scanSource).toHaveBeenCalledWith({
        name: 'alpha-source',
        url: 'https://example.test/alpha.git',
        ref: 'v1.0.0',
        type: 'tag',
      }),
    )
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount + 1)
    expect(await within(dialog).findByRole('checkbox', { name: 'Select tag-skill' })).toBeDefined()
    expect(within(dialog).getByText('tag-com')).toBeDefined()
  })

  it('ignores an Edit Source scan returned after the selected type changed', async () => {
    let resolveScan!: (value: unknown) => void
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: ['v1.0.0'],
    } as never)
    vi.mocked(api.scanSource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        }) as never,
    )

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'tag' }))
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Repository ref' }).textContent).toContain(
        'v1.0.0',
      ),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh repository tree' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'branch' }))

    resolveScan(sourceTreeResponse(['stale']))
    await act(async () => await Promise.resolve())

    expect(within(dialog).queryByRole('checkbox', { name: 'Select stale' })).toBeNull()
  })

  it('shows an Edit Source scan error only in the results pane', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: false,
      message: 'repository tree unavailable',
    } as never)

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh repository tree' }))

    expect(await within(dialog).findAllByText('repository tree unavailable')).toHaveLength(1)
    expect(within(dialog).getByRole('alert')).toBeDefined()
  })

  it('Edit Source saves member entries and resources without a scan pattern', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select alpha' }))
    fireEvent.change(within(dialog).getByLabelText('source name'), {
      target: { value: 'renamed-alpha' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /保存/ }))

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith({
        repo: '/tmp/edit-switch',
        url: 'https://example.test/alpha.git',
        name: 'renamed-alpha',
        ref: 'main',
        type: 'branch',
        expected_commit: 'abc123456789',
        members: [{ name: 'alpha', entry: 'alpha/SKILL.md' }],
        resources: { include: [], exclude: [] },
      }),
    )
  })

  it('keeps a cached root bundle aligned with an edited source name', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce({
      ok: true,
      tree: {
        commit: 'abc123456789',
        diagnostics: [],
        nodes: [
          {
            kind: 'bundle',
            name: 'alpha-source',
            path: '',
            entry: 'SKILL.md',
            mode: '040000',
            oid: 'root-bundle',
          },
        ],
      },
    } as never)

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    const rootBundle = await within(dialog).findByRole('checkbox', { name: 'Select SKILL.md' })
    fireEvent.click(rootBundle)
    fireEvent.change(within(dialog).getByLabelText('source name'), {
      target: { value: 'renamed-root' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /保存/ }))

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'renamed-root',
          members: [{ name: 'renamed-root', entry: 'SKILL.md' }],
        }),
      ),
    )
  })

  it('saves Edit Source against the actively refreshed tree commit', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce(
      sourceTreeResponse(['alpha'], 'refreshed-commit') as never,
    )

    render(<EditSourceSwitchHarness />)
    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh repository tree' }))
    await waitFor(() => expect(within(dialog).getByText('refresh')).toBeDefined())
    fireEvent.click(within(dialog).getByRole('button', { name: /保存/ }))

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith(
        expect.objectContaining({ expected_commit: 'refreshed-commit' }),
      ),
    )
  })

  it('Edit Source can save an empty desired selection', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })

    const save = (await within(dialog).findByRole('button', {
      name: '保存 (0)',
    })) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith({
        repo: '/tmp/edit-switch',
        url: 'https://example.test/alpha.git',
        name: 'alpha-source',
        ref: 'main',
        type: 'branch',
        expected_commit: 'abc123456789',
        members: [],
        resources: { include: [], exclude: [] },
      }),
    )
  })

  it('keeps bundle selection while filtering Edit Source contents', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValueOnce(
      sourceTreeResponse(['alpha', 'beta']) as never,
    )

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    await within(dialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search source contents' }), {
      target: { value: 'alpha' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select alpha' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search source contents' }), {
      target: { value: 'beta' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select beta' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /保存/ }))

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith({
        repo: '/tmp/edit-switch',
        url: 'https://example.test/alpha.git',
        name: 'alpha-source',
        ref: 'main',
        type: 'branch',
        expected_commit: 'abc123456789',
        members: [
          { name: 'alpha', entry: 'alpha/SKILL.md' },
          { name: 'beta', entry: 'beta/SKILL.md' },
        ],
        resources: { include: [], exclude: [] },
      }),
    )
  })

  it('does not show stale Edit Source errors after switching source', async () => {
    let rejectAlphaRefs!: (error: Error) => void
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.getCachedSourceTree).mockResolvedValue(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectAlphaRefs = reject
          }) as never,
      )
      .mockResolvedValueOnce({
        ok: true,
        branches: ['main'],
        tags: [],
      } as never)
    vi.mocked(api.scanSource).mockResolvedValue({ ok: true, members: [] } as never)

    try {
      render(<EditSourceSwitchHarness />)

      const openAlpha = screen.getByRole('button', { name: 'open alpha' })
      const openBeta = screen.getByRole('button', { name: 'open beta' })

      fireEvent.click(openAlpha)
      let dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
      await within(dialog).findByRole('checkbox', { name: 'Select alpha' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Repository ref' }))
      await waitFor(() => expect(rejectAlphaRefs).toBeTypeOf('function'))

      fireEvent.click(openBeta)
      dialog = await screen.findByRole('dialog', { name: 'Edit Source · beta-source' })
      await within(dialog).findByRole('checkbox', { name: 'Select alpha' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Repository ref' }))
      await waitFor(() =>
        expect(api.getSourceRefs).toHaveBeenCalledWith('https://example.test/beta.git'),
      )

      await act(async () => {
        rejectAlphaRefs(new Error('alpha refs failed'))
        await Promise.resolve()
      })

      expect(screen.queryByText('alpha refs failed')).toBeNull()
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'source:refs:https://example.test/alpha.git',
          err: expect.any(Error),
        }),
        expect.any(String),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('starts a fresh cached tree read after closing and reopening the same source', async () => {
    let resolveFirstTree!: (value: ReturnType<typeof sourceTreeResponse>) => void
    vi.mocked(api.getCachedSourceTree)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstTree = resolve as typeof resolveFirstTree
          }) as never,
      )
      .mockResolvedValueOnce(sourceTreeResponse(['alpha']) as never)
    const treeCallCount = vi.mocked(api.getCachedSourceTree).mock.calls.length
    const scanCallCount = vi.mocked(api.scanSource).mock.calls.length

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const firstDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    expect(api.getCachedSourceTree).toHaveBeenCalledTimes(treeCallCount + 1)
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount)

    fireEvent.click(within(firstDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Source/ })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const secondDialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    await waitFor(() => expect(api.getCachedSourceTree).toHaveBeenCalledTimes(treeCallCount + 2))
    await within(secondDialog).findByRole('checkbox', { name: 'Select alpha' })
    expect(within(secondDialog).queryByText('扫描失败')).toBeNull()

    await act(async () => {
      resolveFirstTree(sourceTreeResponse(['stale']))
      await Promise.resolve()
    })
    expect(within(secondDialog).queryByText('扫描失败')).toBeNull()
    expect(within(secondDialog).queryByRole('checkbox', { name: 'Select stale' })).toBeNull()
  })

  it('reads the initial cached tree once during a StrictMode effect replay', async () => {
    let resolveTree!: (value: ReturnType<typeof sourceTreeResponse>) => void
    vi.mocked(api.getCachedSourceTree).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTree = resolve as typeof resolveTree
        }) as never,
    )
    const treeCallCount = vi.mocked(api.getCachedSourceTree).mock.calls.length

    render(
      <StrictMode>
        <EditSourceSwitchHarness />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    await waitFor(() => expect(api.getCachedSourceTree).toHaveBeenCalledTimes(treeCallCount + 1))
    await act(async () => {
      resolveTree(sourceTreeResponse(['alpha']))
      await Promise.resolve()
    })

    expect(await within(dialog).findByRole('checkbox', { name: 'Select alpha' })).toBeDefined()
    expect(api.getCachedSourceTree).toHaveBeenCalledTimes(treeCallCount + 1)
  })

  it('loads refs again when Edit Source is reopened while refs are pending', async () => {
    vi.mocked(api.getCachedSourceTree).mockResolvedValue(sourceTreeResponse(['alpha']) as never)
    vi.mocked(api.getSourceRefs)
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            // Keep the first refs request pending so the reopen path would be skipped if deduped.
          }) as never,
      )
      .mockResolvedValueOnce({
        ok: true,
        branches: ['main'],
        tags: ['v1.0.0'],
      } as never)
    const refsCallCount = vi.mocked(api.getSourceRefs).mock.calls.length

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const firstDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(firstDialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Repository ref' }))
    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount + 1))

    fireEvent.click(within(firstDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Source/ })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const secondDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(secondDialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Repository ref' }))

    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount + 2))
    expect(await within(secondDialog).findByRole('option', { name: 'main' })).toBeDefined()
  })
})

describe('Sync view', () => {
  it('renders pull and push buttons', async () => {
    render(
      <TestRouter>
        <Sync repoPath="/tmp/r" />
      </TestRouter>,
    )
    expect(screen.getByRole('button', { name: '拉取' })).toBeDefined()
    expect(screen.getByRole('button', { name: '上传' })).toBeDefined()
    await waitFor(() => expect(api.getSyncRemote).toHaveBeenCalledWith('/tmp/r'))
  })

  it('restores an isolated conflict session after page reload', async () => {
    vi.mocked(api.getSyncSession).mockResolvedValueOnce({
      ok: true,
      active: true,
      clean: false,
      sessionId: 'restored-session',
      conflicts: [
        {
          path: 'skills.yaml',
          base: 'value: base\n',
          ours: 'value: local\n',
          theirs: 'value: remote\n',
          result: '<<<<<<< HEAD\nvalue: local\n=======\nvalue: remote\n>>>>>>> remote\n',
          binary: false,
        },
      ],
    })

    render(
      <TestRouter>
        <Sync repoPath="/tmp/restored" />
      </TestRouter>,
    )

    expect(await screen.findByText('skills.yaml')).toBeDefined()
    expect(api.getSyncSession).toHaveBeenCalledWith('/tmp/restored')
  })

  it('renders native Git conflicts and aborts the merge', async () => {
    vi.mocked(api.getSyncRemote).mockResolvedValueOnce({
      remoteUrl: 'https://example.test/repo.git',
    })
    vi.mocked(api.syncPull).mockResolvedValueOnce({
      ok: true,
      clean: false,
      sessionId: 'session-1',
      conflicts: [
        {
          path: 'skills.yaml',
          base: 'value: base\n',
          ours: 'value: local\n',
          theirs: 'value: remote\n',
          result: '<<<<<<< HEAD\nvalue: local\n=======\nvalue: remote\n>>>>>>> FETCH_HEAD\n',
          binary: false,
        },
      ],
    })

    render(
      <TestRouter>
        <Sync repoPath="/tmp/r" />
      </TestRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '拉取' }))

    expect(await screen.findByText('skills.yaml')).toBeDefined()
    expect(screen.getAllByText('LOCAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('REMOTE').length).toBeGreaterThan(0)
    expect(screen.queryByText('[object Object]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '放弃合并' }))
    await waitFor(() => expect(api.abortSyncMerge).toHaveBeenCalledWith('session-1'))
  })

  it('surfaces Monaco decoration failures while keeping the conflict open', async () => {
    const err = new Error('decorations failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    monacoEditorMock.deltaDecorations.mockImplementation(() => {
      throw err
    })
    vi.mocked(api.getSyncRemote).mockResolvedValueOnce({
      remoteUrl: 'https://example.test/repo.git',
    })
    vi.mocked(api.syncPull).mockResolvedValueOnce({
      ok: true,
      clean: false,
      sessionId: 'session-decoration-error',
      conflicts: [
        {
          path: 'skills.yaml',
          base: 'value: base\n',
          ours: 'value: local\n',
          theirs: 'value: remote\n',
          result: '<<<<<<< HEAD\nvalue: local\n=======\nvalue: remote\n>>>>>>> FETCH_HEAD\n',
          binary: false,
        },
      ],
    })

    try {
      render(
        <TestRouter>
          <Sync repoPath="/tmp/r" />
        </TestRouter>,
      )
      fireEvent.click(await screen.findByRole('button', { name: '拉取' }))

      expect((await screen.findByRole('alert')).textContent).toContain('冲突高亮加载失败')
      expect(screen.getByText('skills.yaml')).toBeDefined()
      expect(consoleError).toHaveBeenCalledWith(
        { err },
        'Failed to update Monaco conflict decorations',
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('refines conflicts and applies or ignores each side change', async () => {
    vi.mocked(api.getSyncRemote).mockResolvedValueOnce({
      remoteUrl: 'https://example.test/repo.git',
    })
    vi.mocked(api.syncPull).mockResolvedValueOnce({
      ok: true,
      clean: false,
      sessionId: 'session-2',
      conflicts: [
        {
          path: 'config.yaml',
          base: 'profile: local\nagents:\n  - claude-code\nprojection:\n  strategy: link\n',
          ours: 'profile: local\nagents:\n  - claude-code\n  - codex\n  - opencode\nprojection:\n  strategy: link\n',
          theirs:
            'profile: local\nagents: []\nprojection:\n  strategy: link\nproxy:\n  http: http://127.0.0.1:7890\n  https: http://127.0.0.1:7890\n',
          result: 'unused Git marker result',
          binary: false,
        },
      ],
    })

    render(
      <TestRouter>
        <Sync repoPath="/tmp/r" />
      </TestRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '拉取' }))

    expect(await screen.findByText('config.yaml')).toBeDefined()
    expect(screen.getAllByText('LOCAL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('RESULT').length).toBeGreaterThan(0)
    expect(screen.getAllByText('REMOTE').length).toBeGreaterThan(0)
    const localPane = screen.getByRole('textbox', { name: 'Sync LOCAL' }) as HTMLTextAreaElement
    const resultPane = screen.getByRole('textbox', { name: 'Sync RESULT' }) as HTMLTextAreaElement
    const remotePane = screen.getByRole('textbox', { name: 'Sync REMOTE' }) as HTMLTextAreaElement
    expect(localPane.value).toContain('opencode')
    expect(resultPane.value).toContain('proxy:')
    expect(remotePane.value).toContain('proxy:')
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()
    expect(document.querySelectorAll('.merge-block-action[aria-label$="应用到结果"]')).toHaveLength(
      2,
    )
    expect(document.querySelectorAll('.merge-block-action[aria-label$="忽略变更"]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '保留两者' })).toBeDefined()
    expect(screen.getByRole('button', { name: '保留本地' })).toBeDefined()
    expect(screen.getByRole('button', { name: '保留远程' })).toBeDefined()

    const localApply = document.querySelector(
      '.merge-block-action[aria-label="本地变更 1：应用到结果"]',
    ) as HTMLButtonElement
    expect(localApply).not.toBeNull()
    expect(localApply.closest('.merge-action-rail')).not.toBeNull()
    const localActionCellText = localApply.closest('.merge-block-actions')?.textContent ?? ''
    expect(localActionCellText).toContain('→')
    expect(localActionCellText).toContain('×')
    expect(localActionCellText.indexOf('×')).toBeLessThan(localActionCellText.indexOf('→'))
    expect(localActionCellText).not.toMatch(/\d/)

    const remoteApply = document.querySelector(
      '.merge-block-action[aria-label="远程变更 1：应用到结果"]',
    ) as HTMLButtonElement
    expect(remoteApply).not.toBeNull()
    expect(remoteApply.closest('.merge-action-rail')).not.toBeNull()
    const remoteActionCellText = remoteApply.closest('.merge-block-actions')?.textContent ?? ''
    expect(remoteActionCellText).toContain('←')
    expect(remoteActionCellText).toContain('×')
    expect(remoteActionCellText).not.toMatch(/\d/)

    fireEvent.change(resultPane, {
      target: { value: `# manually edited\n${resultPane.value.replace('profile: local\n', '')}` },
    })
    expect(resultPane.value).toMatch(/^# manually edited\nagents:/)

    fireEvent.click(localApply)
    expect(resultPane.value).toMatch(
      /^# manually edited\nagents:\n  - claude-code\n  - codex\n  - opencode\nprojection:/,
    )
    expect(resultPane.value).toContain('opencode')
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()

    const undoLocalApply = document.querySelector(
      '.merge-block-action[aria-label="本地变更 1：撤回应用"]',
    ) as HTMLButtonElement
    expect(undoLocalApply).not.toBeNull()
    expect(undoLocalApply.disabled).toBe(false)
    fireEvent.click(undoLocalApply)
    expect(resultPane.value).not.toContain('opencode')
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '保留远程' }))
    expect(screen.getByText('0 个待处理冲突')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '保留两者' }))
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()
    expect(resultPane.value).toContain('proxy:')

    fireEvent.click(
      document.querySelector(
        '.merge-block-action[aria-label="本地变更 1：应用到结果"]',
      ) as HTMLButtonElement,
    )
    fireEvent.click(
      document.querySelector(
        '.merge-block-action[aria-label="远程变更 1：忽略变更"]',
      ) as HTMLButtonElement,
    )
    fireEvent.click(screen.getByRole('button', { name: '保存并完成合并' }))

    await waitFor(() =>
      expect(api.saveSyncConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-2',
          path: 'config.yaml',
          result: expect.stringMatching(/agents:[\s\S]*opencode[\s\S]*proxy:/),
        }),
      ),
    )
  })

  it('explains that multiple conflict files are resolved one at a time', async () => {
    vi.mocked(api.getSyncRemote).mockResolvedValueOnce({
      remoteUrl: 'https://example.test/repo.git',
    })
    vi.mocked(api.syncPull).mockResolvedValueOnce({
      ok: true,
      clean: false,
      sessionId: 'session-3',
      conflicts: [
        {
          path: 'config.yaml',
          base: 'value: base\n',
          ours: 'value: local\n',
          theirs: 'value: remote\n',
          result: null,
          binary: false,
        },
        {
          path: 'agents.yaml',
          base: 'enabled: false\n',
          ours: 'enabled: local\n',
          theirs: 'enabled: remote\n',
          result: null,
          binary: false,
        },
      ],
    })

    render(
      <TestRouter>
        <Sync repoPath="/tmp/r" />
      </TestRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '拉取' }))

    expect(
      await screen.findByText('Git 检测到 2 个冲突文件，当前显示第 1/2 个，保存后继续下一个'),
    ).toBeDefined()
    expect(screen.getByText('文件 1/2')).toBeDefined()
    expect(screen.getByText('config.yaml')).toBeDefined()
    expect(screen.queryByText('agents.yaml')).toBeNull()
  })
})
