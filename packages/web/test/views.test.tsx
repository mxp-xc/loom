// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
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
import MemberScanModal from '../src/views/skills/MemberScanModal'
import Sync from '../src/views/Sync'
import Mcp from '../src/views/Mcp'
import Memory from '../src/views/Memory'
import { useManifestOperations } from '../src/hooks/useManifestOperations'
import { createMonacoEditorMock } from './monaco-test-utils'

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
    scanSource: vi.fn(async () => ({ ok: true, members: [] })),
    getSourceRefs: vi.fn(async () => ({ ok: true, branches: [], tags: [] })),
    refreshSource: vi.fn(async () => ({ ok: true, members: [] })),
    addSource: vi.fn(async () => ({ ok: true })),
    setSourceMembers: vi.fn(async () => ({ ok: true })),
    updateSourceMeta: vi.fn(async () => ({ ok: true })),
    reconcileSource: vi.fn(async () => ({
      ok: true,
      finalized: true,
      changes: { added: [], updated: [], removed: [] },
    })),
    updateSkillTargets: vi.fn(async () => ({ ok: true })),
    updateSourceSkillTargets: vi.fn(async () => ({ ok: true })),
    updateLocalSkillTargets: vi.fn(async () => ({ ok: true })),
    getSkillContent: vi.fn(async () => ({ ok: true, content: '# Skill' })),
    deleteSource: vi.fn(async () => ({ ok: true })),
    deleteLocalSkill: vi.fn(async () => ({ ok: true })),
    saveSkillContent: vi.fn(async () => ({ ok: true })),
    addMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpServer: vi.fn(async () => ({ ok: true })),
    updateMcpTargets: vi.fn(async () => ({ ok: true })),
    deleteMcpServer: vi.fn(async () => ({ ok: true })),
    reorderMcpServers: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true, ids })),
    getMemory: vi.fn(async () => ({ memories: [], active: null, activeContent: '' })),
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
                targets: ['codex'],
              },
              {
                id: 'remote-mcp',
                type: 'http',
                url: 'https://example.test/mcp',
                headers: { Authorization: 'Bearer token' },
                targets: [],
              },
            ],
            vars: { default: {}, active: {} },
            config: { targets: ['claude-code', 'codex', 'opencode'] },
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
                    members: [
                      {
                        name: 'systematic-debugging',
                        description: 'A disciplined debugging loop for bugs and regressions.',
                        path: 'skills/systematic-debugging/SKILL.md',
                        targets: ['claude-code', 'codex', 'opencode'],
                      },
                    ],
                  },
                ],
                skills: [
                  {
                    id: 'test-qa-skill',
                    path: './assets/skills/test-qa-skill',
                    available: false,
                    targets: ['claude-code', 'codex', 'opencode'],
                  },
                  {
                    id: 'frontend-design',
                    description: 'Design guidance for distinctive front-end UI.',
                    skillFilePath: 'assets/skills/frontend-design/SKILL.md',
                    targets: [],
                  },
                ],
              },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { targets: ['claude-code', 'codex'] },
              errors: [],
            }
          : {
              skills: { sources: [], skills: [] },
              mcp: [],
              vars: { default: {}, active: {} },
              config: { targets: ['claude-code', 'codex'] },
              errors: [],
            },
    ),
  },
}))

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
            scan: 'skills/engineering/**/SKILL.md',
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

function MemberScanModalHarness({ source, repoPath }: { source: any; repoPath: string }) {
  const operations = useManifestOperations(repoPath)
  return (
    <MemberScanModal
      source={source}
      operations={operations}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
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
    expect(screen.getByLabelText('env file')).toBeDefined()
    expect(
      monacoEditorMock.props.some(
        (props) => props.language === 'plaintext' && props.height === '150px',
      ),
    ).toBe(true)
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

    fireEvent.change(screen.getByLabelText('command'), { target: { value: 'node' } })
    expect(screen.queryByText('targets')).toBeNull()

    const envEditor = screen.getByRole('textbox', { name: 'env file' })
    expect(
      monacoEditorMock.props.some(
        (props) =>
          props.language === 'plaintext' && props.height === '150px' && props.value === 'FOO=bar',
      ),
    ).toBe(true)
    fireEvent.change(envEditor, {
      target: { value: 'FOO=baz' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

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
          targets: ['codex'],
        }),
      }),
    )
  })

  it('edits remote MCP headers through the embedded Monaco file editor', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '选择 remote-mcp' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑 remote-mcp' }))
    expect(await screen.findByRole('heading', { name: '编辑 MCP server' })).toBeDefined()

    const headersEditor = screen.getByRole('textbox', { name: 'headers file' })
    expect(
      monacoEditorMock.props.some(
        (props) =>
          props.language === 'plaintext' &&
          props.height === '150px' &&
          props.value === 'Authorization=Bearer token',
      ),
    ).toBe(true)
    fireEvent.change(headersEditor, {
      target: { value: 'Authorization=Bearer ${API_TOKEN}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

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

    fireEvent.click(screen.getByRole('button', { name: '切换 env 为 key value 编辑' }))
    fireEvent.change(screen.getByLabelText('env key 1'), { target: { value: 'FOO' } })
    fireEvent.change(screen.getByLabelText('env value 1'), { target: { value: 'baz' } })
    fireEvent.click(screen.getByRole('button', { name: '新增 env 行' }))
    fireEvent.change(screen.getByLabelText('env key 2'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByLabelText('env value 2'), { target: { value: 'abc 123' } })
    fireEvent.click(screen.getByRole('button', { name: '删除 env 行 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() =>
      expect(api.updateMcpServer).toHaveBeenCalledWith({
        repo: '/tmp/mcp-layout',
        id: 'test-mcp',
        server: expect.objectContaining({
          env: { TOKEN: 'abc 123' },
          targets: ['codex'],
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
      fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

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

  it('bulk toggles MCP server targets without projecting', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '全部 MCP servers 应用到 CX' }))

    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(2))
    expect(api.project).not.toHaveBeenCalled()
    expect(api.updateMcpTargets).toHaveBeenCalledWith({
      repo: '/tmp/mcp-layout',
      id: 'test-mcp',
      targets: ['codex'],
    })
    expect(api.updateMcpTargets).toHaveBeenCalledWith({
      repo: '/tmp/mcp-layout',
      id: 'remote-mcp',
      targets: ['codex'],
    })
  })

  it('updates MCP bulk targets one server at a time', async () => {
    let releaseFirst!: () => void
    const callsBefore = vi.mocked(api.updateMcpTargets).mock.calls.length
    vi.mocked(api.updateMcpTargets).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ ok: true })
        }) as never,
    )

    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '全部 MCP servers 应用到 CX' }))

    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(callsBefore + 1))
    releaseFirst()
    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(callsBefore + 2))
    vi.mocked(api.updateMcpTargets).mockResolvedValue({ ok: true } as never)
  })

  it('keeps selection while reordering to the end and disables sorting while filtered', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    const first = await screen.findByLabelText('调整 test-mcp 顺序')
    const second = screen.getByLabelText('调整 remote-mcp 顺序')
    ;[first, second].forEach((element, index) => {
      element.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 100, width: 320, height: 92 })
    })
    fireEvent.click(screen.getAllByRole('button', { name: '选择 remote-mcp' })[0])

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
    expect(
      screen.getAllByRole('button', { name: '选择 remote-mcp' })[0].getAttribute('data-selected'),
    ).toBe('true')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'remote' } })
    expect(screen.getByLabelText('调整 remote-mcp 顺序').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('Skill detail modal', () => {
  it('matches the approved Edit Skill workbench structure', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValueOnce({
      ok: true,
      content: '# Production skill',
    } as never)

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-workbench"
        detail={{
          skillId: 'production-skill',
          path: '/skills/production-skill/SKILL.md',
          targets: ['codex'],
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
        detail={{
          skillId: 'superpowers/receiving-code-review',
          source: 'https://github.com/obra/superpowers.git',
          targets: ['codex'],
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
        detail={{
          skillId: 'source-skill',
          source: 'https://github.com/example/skills.git',
          path: 'skills/source-skill/SKILL.md',
          targets: ['codex', 'opencode'],
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
        detail={{ skillId: 'empty-local-skill', path: './skills/empty', targets: [] }}
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
  it('uses the approved compact rail and preview-first workbench layout', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex', 'opencode'] },
      errors: [],
    } as never)
    vi.mocked(api.getMemory).mockResolvedValueOnce({
      memories: [{ name: 'v1' }, { name: 'review-rules' }],
      active: 'v1',
      activeContent: '# Active memory',
    } as never)

    render(<Memory repoPath="/tmp/memory-layout-approved" />)

    const layout = await screen.findByTestId('memory-layout')
    expect(layout.getAttribute('data-layout')).toBe('compact-workbench')

    const railHeader = screen.getByTestId('memory-rail-header')
    const projectButton = screen.getByRole('button', { name: '投影 memory' })
    const createButton = screen.getByRole('button', { name: '新建 memory' })
    expect(railHeader.contains(projectButton)).toBe(true)
    expect(railHeader.contains(createButton)).toBe(true)
    expect(projectButton.querySelector('.lucide-send')).not.toBeNull()
    expect(projectButton.className).toContain('border-[var(--border)]')
    expect(createButton.className).toContain('border-[var(--border)]')
    expect(projectButton.style.width).toBe('32px')
    expect(projectButton.style.height).toBe('32px')
    expect(createButton.style.width).toBe('32px')
    expect(createButton.style.height).toBe('32px')
    expect(
      within(railHeader)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['新建 memory', '投影 memory'])

    expect(railHeader.textContent).not.toContain('2 份')
    expect(screen.getByRole('tab', { name: '所见编辑' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '所见编辑',
      '源码',
      '解析预览',
    ])
    expect(screen.queryByText('Markdown')).toBeNull()
    expect(screen.getByRole('article').textContent).toContain('Active memory')
    expect(screen.getByRole('button', { name: '复制 Memory 原始内容' })).toBeDefined()
    const targetPanel = screen.getByTestId('memory-targets')
    expect(within(targetPanel).queryByRole('button', { name: 'CC' })).toBeNull()
    expect(within(targetPanel).getByRole('button', { name: 'CX' })).toBeDefined()
    expect(within(targetPanel).getByRole('button', { name: 'OC' })).toBeDefined()
  })

  it('toggles Memory projection targets and reconciles projection immediately', async () => {
    vi.mocked(api.getManifest)
      .mockResolvedValueOnce({
        skills: { sources: [], skills: [] },
        mcp: [],
        vars: { default: {}, active: {} },
        config: { targets: ['codex', 'opencode'] },
        errors: [],
      } as never)
      .mockResolvedValueOnce({
        skills: { sources: [], skills: [] },
        mcp: [],
        vars: { default: {}, active: {} },
        config: { targets: ['codex'] },
        errors: [],
      } as never)
    vi.mocked(api.getMemory).mockResolvedValueOnce({
      memories: [{ name: 'v1' }],
      active: 'v1',
      activeContent: '# v1',
    } as never)

    render(<Memory repoPath="/tmp/memory-targets" />)

    const targetsPanel = await screen.findByText('投影目标')
    const panel = screen.getByTestId('memory-targets')
    expect(panel.contains(targetsPanel)).toBe(true)
    fireEvent.click(within(panel).getByRole('button', { name: 'OC' }))

    await waitFor(() =>
      expect(api.putConfig).toHaveBeenCalledWith({
        repo: '/tmp/memory-targets',
        level: 'repo',
        field: 'targets',
        value: ['codex'],
      }),
    )
    await waitFor(() =>
      expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/memory-targets', scope: 'memory' }),
    )
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'OC' })).toBeNull())
  })

  it('uses the active status dot as the only memory activation control', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [{ name: 'v1' }],
      active: 'v1',
      activeContent: '# v1',
    } as never)

    render(<Memory repoPath="/tmp/memory-actions" />)

    await screen.findAllByText('v1')
    const row = screen.getByTestId('memory-row-v1')

    const activeDot = within(row).getByRole('button', { name: '取消激活 memory v1' })
    const rename = within(row).getByRole('button', { name: '重命名 memory v1' })
    const remove = within(row).getByRole('button', { name: '删除 memory v1' })

    expect(activeDot.getAttribute('aria-pressed')).toBe('true')
    expect(activeDot.getAttribute('data-state')).toBe('active')
    expect(activeDot.getAttribute('data-tooltip')).toBe('已激活，点击取消')
    expect(within(row).queryByRole('button', { name: '激活 memory v1' })).toBeNull()
    expect(rename.getAttribute('data-tooltip')).toBe('重命名')
    expect(remove.getAttribute('data-tooltip')).toBe('删除')

    fireEvent.click(activeDot)
    await waitFor(() =>
      expect(api.setMemoryActive).toHaveBeenCalledWith({
        repo: '/tmp/memory-actions',
        name: null,
      }),
    )
  })

  it('shows Memory feedback through the app-level toast host', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [{ name: 'v1' }],
      active: 'v1',
      activeContent: '# v1',
    } as never)
    vi.mocked(api.project).mockResolvedValueOnce({ ok: true } as never)

    render(
      <>
        <ToastHost />
        <Memory repoPath="/tmp/memory-feedback" />
      </>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '投影 memory' }))

    await waitFor(() =>
      expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/memory-feedback', scope: 'memory' }),
    )
    expect(await screen.findByText('投影完成')).toBeDefined()
  })

  it('keeps active selection and editor draft while moving a memory to the end', async () => {
    vi.mocked(api.getMemory).mockResolvedValueOnce({
      memories: [{ name: 'v1' }, { name: 'v2' }],
      active: 'v1',
      activeContent: '# v1',
    } as never)
    render(<Memory repoPath="/tmp/memory-order" />)

    fireEvent.click(await screen.findByRole('tab', { name: '源码' }))
    const editor = await screen.findByRole('textbox', { name: 'Memory 内容' })
    fireEvent.change(editor, { target: { value: '# unsaved draft' } })
    const first = screen.getByLabelText('调整 v1 顺序')
    const second = screen.getByLabelText('调整 v2 顺序')
    ;[first, second].forEach((element, index) => {
      element.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 44, width: 260, height: 40 })
    })

    first.focus()
    fireEvent.keyDown(first, { key: ' ', code: 'Space' })
    await waitFor(() => expect(first.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    await waitFor(() =>
      expect(api.reorderMemories).toHaveBeenCalledWith({
        repo: '/tmp/memory-order',
        names: ['v2', 'v1'],
      }),
    )
    expect(
      (screen.getByRole('textbox', { name: 'Memory 内容' }) as HTMLTextAreaElement).value,
    ).toBe('# unsaved draft')
    expect(screen.getByRole('button', { name: '取消激活 memory v1' })).toBeDefined()
  })
})

describe('Skills view', () => {
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
    expect(screen.queryByText('systematic-debugging')).toBeNull()
    expect(screen.queryByText('test-qa-skill')).toBeNull()

    fireEvent.click(expandAll)
    expect(screen.getByRole('button', { name: '全部收起' })).toBeDefined()
    expect(screen.getByText('systematic-debugging')).toBeDefined()

    const sourceRow = screen.getByTestId('source-skill-systematic-debugging')
    expect(within(sourceRow).getByText('skills/systematic-debugging')).toBeDefined()
    expect(within(sourceRow).queryByText('skills/systematic-debugging/SKILL.md')).toBeNull()
    expect(
      within(sourceRow).getByText('A disciplined debugging loop for bugs and regressions.'),
    ).toBeDefined()
    const sourceFileLink = within(sourceRow).getByRole('link', {
      name: '在 GitHub 打开 systematic-debugging 的 SKILL.md',
    })
    expect(sourceFileLink.getAttribute('href')).toBe(
      'https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md',
    )

    const localRow = screen.getByTestId('local-skill-test-qa-skill')
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
    fireEvent.click(within(frontendRow).getByRole('button', { name: 'CX' }))
    await waitFor(() =>
      expect(api.updateLocalSkillTargets).toHaveBeenCalledWith({
        repo: '/tmp/skills-layout',
        id: 'frontend-design',
        targets: ['codex'],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '折叠 superpowers' }))
    expect(screen.queryByText('systematic-debugging')).toBeNull()
    expect(screen.getByTestId('local-skill-test-qa-skill')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '全部收起' }))
    expect(screen.getByRole('button', { name: '全部展开' })).toBeDefined()
    expect(screen.queryByText('test-qa-skill')).toBeNull()
  })

  it('projects skills after an individual target chip is toggled', async () => {
    const projectCallsBefore = vi.mocked(api.project).mock.calls.length
    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '全部展开' }))
    const frontendRow = screen.getByTestId('local-skill-frontend-design')
    fireEvent.click(within(frontendRow).getByRole('button', { name: 'CX' }))

    await waitFor(() =>
      expect(api.updateLocalSkillTargets).toHaveBeenCalledWith({
        repo: '/tmp/skills-layout',
        id: 'frontend-design',
        targets: ['codex'],
      }),
    )
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 1))
    expect(api.project).toHaveBeenLastCalledWith({ repo: '/tmp/skills-layout', scope: 'skills' })
  })

  it('supports source-level bulk projection chips in the source header', async () => {
    const projectCallsBefore = vi.mocked(api.project).mock.calls.length
    const updateCallsBefore = vi.mocked(api.updateSkillTargets).mock.calls.length
    const sourceUpdateCallsBefore = vi.mocked(api.updateSourceSkillTargets).mock.calls.length
    const manifest = {
      skills: {
        sources: [
          {
            name: 'openai-skills',
            url: 'https://github.com/obra/superpowers.git',
            ref: 'v6.1.1',
            type: 'tag',
            members: [
              { name: 'brainstorming', targets: ['codex'] },
              { name: 'executing-plans', targets: [] },
              { name: 'disabled-skill', enabled: false, targets: [] },
            ],
          },
        ],
        skills: [{ id: 'local-only', targets: [] }],
      },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code', 'codex', 'opencode'] },
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
      name: 'openai-skills CX：部分已选择',
    })
    expect(sourceBulkCodex).toBeDefined()
    fireEvent.click(sourceBulkCodex)

    await waitFor(() =>
      expect(api.updateSourceSkillTargets).toHaveBeenCalledTimes(sourceUpdateCallsBefore + 1),
    )
    expect(api.updateSourceSkillTargets).toHaveBeenLastCalledWith({
      repo: '/tmp/skills-layout',
      sourceUrl: 'https://github.com/obra/superpowers.git',
      updates: [
        { memberName: 'brainstorming', targets: ['codex'] },
        { memberName: 'executing-plans', targets: ['codex'] },
      ],
    })
    expect(api.updateSkillTargets).toHaveBeenCalledTimes(updateCallsBefore)
    expect(api.updateLocalSkillTargets).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-only' }),
    )
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 1))
    expect(api.project).toHaveBeenLastCalledWith({ repo: '/tmp/skills-layout', scope: 'skills' })
  })

  it('updates skill bulk targets one item at a time', async () => {
    let releaseFirst!: () => void
    const sourceCallsBefore = vi.mocked(api.updateSkillTargets).mock.calls.length
    const localCallsBefore = vi.mocked(api.updateLocalSkillTargets).mock.calls.length
    vi.mocked(api.updateSkillTargets).mockImplementationOnce(
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

    fireEvent.click(await screen.findByRole('button', { name: 'CX：部分已选择' }))

    await waitFor(() => expect(api.updateSkillTargets).toHaveBeenCalledTimes(sourceCallsBefore + 1))
    expect(api.updateLocalSkillTargets).toHaveBeenCalledTimes(localCallsBefore)

    releaseFirst()
    await waitFor(() =>
      expect(api.updateLocalSkillTargets).toHaveBeenCalledTimes(localCallsBefore + 2),
    )
    vi.mocked(api.updateSkillTargets).mockResolvedValue({ ok: true } as never)
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
    expect(within(dialog).getByRole('heading', { name: 'Source' })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Scan repository' })).toBeDefined()
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
    const url = within(dialog).getByPlaceholderText('https://github.com/org/repo')
    fireEvent.change(url, { target: { value: 'https://example.test/skills.git' } })
    fireEvent.blur(url)
    const trigger = await within(dialog).findByRole('button', { name: 'Repository ref' })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    const option = within(dialog).getByRole('option', { name: 'main' })
    fireEvent.keyDown(option, { key: 'Escape' })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Add Skill or Source' })).toBeDefined()
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

  it('keeps installed source members disabled in Add Source scan results', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      members: [
        {
          name: 'fresh',
          description: 'Fresh skill description',
          path: 'fresh/SKILL.md',
          installed: false,
        },
        { name: 'installed', description: '', path: 'installed/SKILL.md', installed: true },
      ],
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-disabled" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://example.test/source.git' },
    })
    fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))
    fireEvent.click(screen.getByRole('button', { name: 'Scan repository' }))

    await screen.findByText('fresh')
    expect(screen.getByText('Fresh skill description')).toBeDefined()
    expect(screen.getByText('fresh/SKILL.md')).toBeDefined()
    expect(within(screen.getByTestId('skill-result-fresh')).getByText('new')).toBeDefined()
    const installed = screen.getByRole('checkbox', { name: 'installed' })
    expect((installed as HTMLInputElement).disabled).toBe(true)
  })

  it('scans and adds a source using the selected ref/type and scan pattern', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: ['v1.0.1'],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      members: [{ name: 'tdd', description: '', path: 'skills/engineering/tdd/SKILL.md' }],
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-ref-scan" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://github.com/mattpocock/skills' },
    })
    fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))
    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('skills'),
    )
    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'tag' }))
    fireEvent.change(screen.getByLabelText('scan pattern'), {
      target: { value: 'skills/engineering/**/SKILL.md' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Scan repository' }))

    expect(await screen.findByText('tdd')).toBeDefined()
    expect(api.scanSource).toHaveBeenCalledWith({
      url: 'https://github.com/mattpocock/skills',
      type: 'tag',
      ref: 'v1.0.1',
      scan: 'skills/engineering/**/SKILL.md',
    })

    fireEvent.click(screen.getByRole('button', { name: '添加 Source' }))

    await waitFor(() =>
      expect(api.addSource).toHaveBeenCalledWith({
        repo: '/tmp/add-source-ref-scan',
        name: 'skills',
        url: 'https://github.com/mattpocock/skills',
        type: 'tag',
        ref: 'v1.0.1',
        scan: 'skills/engineering/**/SKILL.md',
      }),
    )
  })

  it('does not overwrite a manually edited Add Source name after URL changes', async () => {
    render(<AddSkillModal open repoPath="/tmp/add-source-name" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByLabelText('source name'), {
      target: { value: 'custom-skills' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://github.com/org/repo-one' },
    })
    fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))
    await waitFor(() =>
      expect(api.getSourceRefs).toHaveBeenCalledWith('https://github.com/org/repo-one'),
    )

    expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('custom-skills')
  })

  it('refreshes the Add Source default name when URL changes before manual name edits', async () => {
    render(<AddSkillModal open repoPath="/tmp/add-source-name-refresh" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://github.com/org/repo-one' },
    })
    fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))
    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('repo-one'),
    )

    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://github.com/org/repo-two' },
    })
    fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))

    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('repo-two'),
    )
  })

  it('keeps the source modal open when members fail after source creation', async () => {
    const onClose = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const getManifestCallsBefore = vi.mocked(api.getManifest).mock.calls.length
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      members: [{ name: 'alpha', path: 'alpha/SKILL.md' }],
    } as never)
    vi.mocked(api.addSource).mockResolvedValueOnce({ ok: true } as never)
    vi.mocked(api.setSourceMembers).mockResolvedValueOnce({
      ok: false,
      message: 'members write failed',
    } as never)

    try {
      render(<AddSkillModal open repoPath="/tmp/r" onClose={onClose} />)

      const dialog = await screen.findByRole('dialog', { name: 'Add Skill or Source' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }))
      fireEvent.change(within(dialog).getByPlaceholderText('https://github.com/org/repo'), {
        target: { value: 'https://example.test/skills.git' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Scan repository' }))
      expect(await within(dialog).findByText('alpha')).toBeDefined()

      fireEvent.click(within(dialog).getByRole('button', { name: '添加 Source' }))

      expect(await within(dialog).findByText(/members write failed/)).toBeDefined()
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 1))
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
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
            config: { targets: [] },
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
              skills: [{ id: 'frontend-design', targets: ['codex'] }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { targets: ['codex'] },
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
      targets: ['codex'],
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
        detail={{
          skillId: 'test-qa-skill',
          path: './assets/skills/test-qa-skill',
          targets: ['codex'],
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
      config: { targets: ['codex'] },
      errors: [],
    } as never)
    const showToast = vi.fn()

    render(
      <SkillDetailEditor
        repoPath="/tmp/skill-save-refresh"
        detail={{
          skillId: 'frontend-design',
          path: './assets/skills/frontend-design',
          targets: ['codex'],
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
                      targets: ['codex'],
                      path: 'skills/engineering/systematic-debugging/SKILL.md',
                    },
                  ],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { targets: ['codex'], skill_naming: 'hyphen' },
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
      targets: ['codex'],
    })
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
                  members: [{ name: 'member', targets: [] }],
                },
              ],
              skills: [{ id: 'local-skill', targets: [] }],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { targets: [] },
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
                    { name: 'writing-plans', targets: [] },
                    { name: 'brainstorming', targets: [] },
                    { name: 'executing-plans', targets: [] },
                  ],
                },
              ],
              skills: [],
            },
            mcp: [],
            vars: { default: {}, active: {} },
            config: { targets: ['opencode'] },
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
            config: { targets: ['claude-code'] },
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
            config: { targets: [] },
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
            config: { targets: [] },
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
  it('lets Edit Source select all and clear all scanned members', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      members: [
        { name: 'brainstorming', path: 'brainstorming/SKILL.md' },
        { name: 'systematic-debugging', path: 'systematic-debugging/SKILL.md' },
      ],
    } as never)

    render(
      <TestRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </TestRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: '编辑 source superpowers' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Source · superpowers' })
    await within(dialog).findByText('brainstorming')

    expect(within(dialog).getByTestId('skills-config-pane')).toBeDefined()
    expect(within(dialog).getByTestId('skills-results-pane')).toBeDefined()
    expect(within(dialog).getByRole('button', { name: 'Scan members' })).toBeDefined()
    expect(within(dialog).queryByText('Membership is up to date')).toBeNull()

    expect(dialog.className).toContain('dialog')
    expect(
      within(dialog).getByRole('list', { name: 'Edit Source · superpowers' }).parentElement
        ?.className,
    ).toContain('skillList')
    expect(within(dialog).getByRole('button', { name: 'Scan members' }).className).toContain(
      'scanButton',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: '全选' }))
    expect(within(dialog).getByTestId('skill-selection-summary').textContent).toBe(
      '2 found · 2 selected',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: '全不选' }))
    expect(within(dialog).getByTestId('skill-selection-summary').textContent).toBe(
      '2 found · 0 selected',
    )
  })

  it('Edit Source scans and saves with the source scan pattern', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      members: [{ name: 'alpha', path: 'skills/engineering/alpha/SKILL.md', installed: false }],
    } as never)

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByText('open alpha'))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(dialog).findByText('alpha')

    expect(api.scanSource).toHaveBeenCalledWith({
      url: 'https://example.test/alpha.git',
      ref: 'main',
      type: 'branch',
      scan: 'skills/engineering/**/SKILL.md',
    })
    fireEvent.change(within(dialog).getByLabelText('scan pattern'), {
      target: { value: '' },
    })
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
        scan: '',
        members: [],
        previousMembers: [],
      }),
    )
  })

  it('keeps hidden selected source members while filtering Edit Source members', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
      ok: true,
      branches: ['main'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource).mockResolvedValueOnce({
      ok: true,
      members: [
        { name: 'alpha', path: 'alpha/SKILL.md', installed: false },
        { name: 'beta', path: 'beta/SKILL.md', installed: false },
      ],
    } as never)

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    fireEvent.change(within(dialog).getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'alpha' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'alpha' }))
    fireEvent.change(within(dialog).getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'beta' },
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'beta' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /保存/ }))

    await waitFor(() =>
      expect(api.reconcileSource).toHaveBeenCalledWith({
        repo: '/tmp/edit-switch',
        url: 'https://example.test/alpha.git',
        name: 'alpha-source',
        ref: 'main',
        type: 'branch',
        scan: 'skills/engineering/**/SKILL.md',
        members: [
          { name: 'alpha', path: 'alpha/SKILL.md' },
          { name: 'beta', path: 'beta/SKILL.md' },
        ],
        previousMembers: [],
      }),
    )
  })

  it('selects and clears all scanned members in MemberScanModal through the shared list', async () => {
    const source = {
      url: 'https://example.test/source.git',
      ref: 'main',
      members: [{ name: 'alpha', targets: ['codex'] }],
    } as any
    vi.mocked(api.refreshSource).mockResolvedValueOnce({
      ok: true,
      members: [
        { name: 'alpha', path: 'alpha/SKILL.md' },
        { name: 'beta', path: 'beta/SKILL.md' },
      ],
    } as never)

    render(<MemberScanModalHarness source={source} repoPath="/tmp/member-scan-shared-list" />)

    const dialog = await screen.findByRole('dialog', { name: 'Scan · source' })
    expect(within(dialog).getByText('已选 1 / 2')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: '全选' }))
    expect(within(dialog).getByText('已选 2 / 2')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: '全不选' }))
    expect(within(dialog).getByText('已选 0 / 2')).toBeDefined()
  })

  it('does not show stale Edit Source errors after switching source', async () => {
    let rejectAlphaRefs!: (error: Error) => void
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
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
      expect(await screen.findByRole('dialog', { name: /Edit Source/ })).toBeDefined()

      fireEvent.click(openBeta)
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

  it('starts a fresh Edit Source scan after closing and reopening the same source', async () => {
    let resolveFirstScan!: (value: { ok: true; members: [] }) => void
    vi.mocked(api.getSourceRefs).mockResolvedValue({
      ok: true,
      branches: ['main'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstScan = resolve as typeof resolveFirstScan
          }) as never,
      )
      .mockResolvedValueOnce({ ok: true, members: [] } as never)
    const scanCallCount = vi.mocked(api.scanSource).mock.calls.length

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const firstDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount + 1)

    fireEvent.click(within(firstDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Source/ })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const secondDialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    await waitFor(() => expect(api.scanSource).toHaveBeenCalledTimes(scanCallCount + 2))
    expect(within(secondDialog).queryByText('扫描失败')).toBeNull()

    await act(async () => {
      resolveFirstScan({ ok: true, members: [] })
      await Promise.resolve()
    })
    expect(within(secondDialog).queryByText('扫描失败')).toBeNull()
  })

  it('does not show scan failure when an Edit Source auto-scan is already pending', async () => {
    vi.mocked(api.getSourceRefs).mockResolvedValue({
      ok: true,
      branches: ['main'],
      tags: [],
    } as never)
    vi.mocked(api.scanSource).mockImplementation(
      () =>
        new Promise(() => {
          // Keep the first scan pending so the second auto-scan is skipped by the operation guard.
        }) as never,
    )

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    fireEvent.click(screen.getByText('open alpha'))

    await waitFor(() =>
      expect(
        (within(dialog).getByRole('button', { name: 'Scan members' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    )
    expect(within(dialog).queryByText('扫描失败')).toBeNull()
  })

  it('loads refs again when Edit Source is reopened while refs are pending', async () => {
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
    vi.mocked(api.scanSource).mockResolvedValue({ ok: true, members: [] } as never)
    const refsCallCount = vi.mocked(api.getSourceRefs).mock.calls.length

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    fireEvent.click(screen.getByText('open alpha'))

    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(refsCallCount + 2))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Repository ref' }))
    expect(within(dialog).getByRole('option', { name: 'main' })).toBeDefined()
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
          base: 'profile: local\ntargets:\n  - claude-code\nprojection:\n  strategy: link\n',
          ours: 'profile: local\ntargets:\n  - claude-code\n  - codex\n  - opencode\nprojection:\n  strategy: link\n',
          theirs:
            'profile: local\ntargets: []\nprojection:\n  strategy: link\nproxy:\n  http: http://127.0.0.1:7890\n  https: http://127.0.0.1:7890\n',
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
    expect(resultPane.value).toMatch(/^# manually edited\ntargets:/)

    fireEvent.click(localApply)
    expect(resultPane.value).toMatch(
      /^# manually edited\ntargets:\n  - claude-code\n  - codex\n  - opencode\nprojection:/,
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
          result: expect.stringMatching(/targets:[\s\S]*opencode[\s\S]*proxy:/),
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
