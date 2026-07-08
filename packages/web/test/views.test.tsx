// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../src/lib/api'
import ToastHost from '../src/components/ToastHost'
import Skills from '../src/views/skills/Skills'
import SkillSourceList from '../src/views/skills/SkillSourceList'
import SkillDetailEditor from '../src/views/skills/SkillDetailEditor'
import AddSkillModal from '../src/views/skills/AddSkillModal'
import EditSourceModal from '../src/views/skills/EditSourceModal'
import MemberScanModal from '../src/views/skills/MemberScanModal'
import SkillDetailEditor from '../src/views/skills/SkillDetailEditor'
import Sync from '../src/views/Sync'
import Mcp from '../src/views/Mcp'
import Memory from '../src/views/Memory'
import { useManifestOperations } from '../src/hooks/useManifestOperations'

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true } as const

function TestRouter({ children }: { children: ReactNode }) {
  return <MemoryRouter future={routerFuture}>{children}</MemoryRouter>
}

vi.mock('../src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    status: vi.fn(async () => ({ active_repo: 'default', repoPath: '/tmp/r' })),
    project: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => ({ updates: [] })),
    performUpdate: vi.fn(async () => ({ pinned_commit: 'bbb' })),
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
    getMemory: vi.fn(async () => ({ memories: [], active: null, activeContent: '' })),
    setMemoryActive: vi.fn(async () => ({ ok: true })),
    createMemory: vi.fn(async () => ({ ok: true })),
    renameMemory: vi.fn(async () => ({ ok: true })),
    deleteMemory: vi.fn(async () => ({ ok: true })),
    saveMemoryContent: vi.fn(async () => ({ ok: true })),
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
            url: 'https://example.test/alpha.git',
            ref: 'main',
            type: 'branch',
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
  it('edits a server in a modal using the create-style form', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 MCP Server test-mcp' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑 MCP Server' })

    const idInput = within(dialog).getByLabelText('id') as HTMLInputElement
    expect(idInput.value).toBe('test-mcp')
    expect(idInput.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('command'), { target: { value: 'node' } })
    expect(within(dialog).queryByText('targets')).toBeNull()
    expect(within(dialog).queryByLabelText('env（JSON）')).toBeNull()

    fireEvent.change(within(dialog).getByLabelText('env file'), {
      target: { value: 'FOO=baz' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }))

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

  it('supports MCP env key value rows with add and delete controls', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 MCP Server test-mcp' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑 MCP Server' })

    fireEvent.click(within(dialog).getByRole('button', { name: '切换 env 为 key value 编辑' }))
    fireEvent.change(within(dialog).getByLabelText('env key 1'), { target: { value: 'FOO' } })
    fireEvent.change(within(dialog).getByLabelText('env value 1'), { target: { value: 'baz' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新增 env 行' }))
    fireEvent.change(within(dialog).getByLabelText('env key 2'), { target: { value: 'TOKEN' } })
    fireEvent.change(within(dialog).getByLabelText('env value 2'), { target: { value: 'abc 123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除 env 行 1' }))

    fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }))

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

  it('omits targets from the Add MCP Server modal', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP Server' })

    expect(within(dialog).queryByText('targets')).toBeNull()
    expect(within(dialog).queryByLabelText('env（JSON）')).toBeNull()
    expect(within(dialog).getByLabelText('env file')).toBeDefined()
  })

  it('shows local validation errors in the Add MCP Server modal', async () => {
    const callsBefore = vi.mocked(api.addMcpServer).mock.calls.length
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      render(<Mcp repoPath="/tmp/mcp-layout" />)

      fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
      const dialog = await screen.findByRole('dialog', { name: 'Add MCP Server' })

      fireEvent.click(within(dialog).getByRole('button', { name: '添加 MCP Server' }))

      expect(await within(dialog).findByText('id 不能为空')).toBeDefined()
      expect(api.addMcpServer).toHaveBeenCalledTimes(callsBefore)
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to submit MCP server',
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('bulk toggles MCP server targets with mixed state feedback', async () => {
    render(<Mcp repoPath="/tmp/mcp-layout" />)

    const codexBulk = await screen.findByRole('button', {
      name: 'CX：部分 MCP servers 已选择',
    })
    expect(codexBulk.getAttribute('data-tooltip')).toBe('CX：部分已选择')

    fireEvent.click(codexBulk)

    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(2))
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

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'CX：部分 MCP servers 已选择',
      }),
    )

    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(callsBefore + 1))
    releaseFirst()
    await waitFor(() => expect(api.updateMcpTargets).toHaveBeenCalledTimes(callsBefore + 2))
    vi.mocked(api.updateMcpTargets).mockResolvedValue({ ok: true } as never)
  })
})

describe('Skill detail modal', () => {
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
    expect(dialog.getAttribute('style')).toContain('960px')
    const contentFrame = within(dialog).getByTestId('skill-detail-content-frame')
    expect(contentFrame).toBeDefined()
    expect(within(dialog).getByText('加载 SKILL.md…')).toBeDefined()

    await act(async () => {
      resolveContent({ ok: true, content: '# Loaded skill' })
    })

    const loadedHeading = await within(dialog).findByText('Loaded skill')
    const previewPanel = loadedHeading.closest('.md-preview') as HTMLElement
    expect(previewPanel.style.height).toBe('var(--skill-detail-panel-height)')
    expect(previewPanel.style.maxHeight).toBe('')
    const copyButton = within(dialog).getByRole('button', { name: '复制 SKILL.md' })
    expect(contentFrame.contains(copyButton)).toBe(true)
  })
})

describe('Memory view', () => {
  it('keeps projection target chips informational instead of editing global Settings targets', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex', 'opencode'] },
      errors: [],
    } as never)
    vi.mocked(api.getMemory).mockResolvedValueOnce({
      memories: [{ name: 'v1' }],
      active: 'v1',
      activeContent: '# v1',
    } as never)

    render(<Memory repoPath="/tmp/memory-targets" />)

    const targetsPanel = await screen.findByText('投影目标')
    const panel = targetsPanel.closest('.mem-global-targets') as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: 'OC' }))

    expect(api.putConfig).not.toHaveBeenCalled()
    expect(within(panel).getByRole('button', { name: 'OC' })).toBeDefined()
  })

  it('uses the active status dot as the only memory activation control', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [{ name: 'v1' }],
      active: 'v1',
      activeContent: '# v1',
    } as never)

    render(<Memory repoPath="/tmp/memory-actions" />)

    const names = await screen.findAllByText('v1')
    const row = names.find((item) => item.closest('.mem-item'))?.closest('.mem-item') as HTMLElement
    expect(row).not.toBeNull()

    const activeDot = within(row).getByRole('button', { name: '取消激活 memory v1' })
    const rename = within(row).getByRole('button', { name: '重命名 memory v1' })
    const remove = within(row).getByRole('button', { name: '删除 memory v1' })

    expect(activeDot.classList.contains('mem-active-dot')).toBe(true)
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
})

describe('Skills view', () => {
  it('renders heading and project button', async () => {
    render(
      <TestRouter>
        <Skills repoPath="/tmp/r" />
      </TestRouter>,
    )
    expect(await screen.findByText('投影', { exact: false })).toBeDefined()
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
        </TestRouter>,
      )

      await screen.findByText('还没有配置任何 Skill')
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 1))

      fireEvent.click(screen.getByRole('button', { name: '投影' }))

      expect(await screen.findByText('投影失败: stale yaml')).toBeDefined()
      await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 1))

      fireEvent.click(screen.getByRole('button', { name: '投影' }))

      await waitFor(() => expect(api.project).toHaveBeenCalledTimes(projectCallsBefore + 2))
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 2))
      await waitFor(() => expect(screen.queryByText('投影失败: stale yaml')).toBeNull())
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

    const sourceRow = screen.getByText('systematic-debugging').closest('.skill')
    expect(sourceRow).not.toBeNull()
    expect(within(sourceRow as HTMLElement).getByText('skills/systematic-debugging')).toBeDefined()
    expect(
      within(sourceRow as HTMLElement).queryByText('skills/systematic-debugging/SKILL.md'),
    ).toBeNull()
    expect(
      within(sourceRow as HTMLElement).getByText(
        'A disciplined debugging loop for bugs and regressions.',
      ),
    ).toBeDefined()
    const sourceFileLink = within(sourceRow as HTMLElement).getByRole('link', {
      name: '在 GitHub 打开 systematic-debugging 的 SKILL.md',
    })
    expect(sourceFileLink.getAttribute('href')).toBe(
      'https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md',
    )

    const localName = document.querySelector('.local-skills-group .skill .sname')
    const localRow = localName.closest('.skill')
    expect(localRow).not.toBeNull()
    const localGroupHead = document.querySelector('.local-skills-group .group-head') as HTMLElement
    expect(within(localGroupHead).getByText('assets/skills')).toBeDefined()
    expect(within(localRow as HTMLElement).getByText('ref')).toBeDefined()
    expect((localRow as HTMLElement).querySelector('.skill-source-path')?.textContent?.trim()).toBe(
      'test-qa-skill',
    )
    expect(within(localRow as HTMLElement).queryByText('assets/skills/test-qa-skill')).toBeNull()
    expect(
      within(localRow as HTMLElement).queryByText('assets/skills/test-qa-skill/SKILL.md'),
    ).toBeNull()
    expect(within(localRow as HTMLElement).queryByText('本地路径')).toBeNull()
    expect(within(localRow as HTMLElement).queryByText('projected')).toBeNull()

    expect(within(localRow as HTMLElement).queryByText('OC')).toBeNull()
    expect(within(localRow as HTMLElement).getByText('路径不存在')).toBeDefined()
    expect(
      within(localRow as HTMLElement).queryByRole('button', { name: 'test-qa-skill' }),
    ).toBeNull()

    const frontendRow = screen.getByRole('button', { name: 'frontend-design' }).closest('.skill')
    expect(frontendRow).not.toBeNull()
    expect(
      (frontendRow as HTMLElement).querySelector('.skill-source-path')?.textContent?.trim(),
    ).toBe('frontend-design')
    expect(
      within(frontendRow as HTMLElement).queryByText('assets/skills/frontend-design'),
    ).toBeNull()
    expect(
      within(frontendRow as HTMLElement).getByText('Design guidance for distinctive front-end UI.'),
    ).toBeDefined()
    expect(
      within(frontendRow as HTMLElement).queryByRole('button', {
        name: '打开 frontend-design 的文件夹',
      }),
    ).toBeNull()
    fireEvent.click(within(frontendRow as HTMLElement).getByRole('button', { name: 'CX' }))
    await waitFor(() =>
      expect(api.updateLocalSkillTargets).toHaveBeenCalledWith({
        repo: '/tmp/skills-layout',
        id: 'frontend-design',
        targets: ['codex'],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '折叠 superpowers' }))
    expect(screen.queryByText('systematic-debugging')).toBeNull()
    expect(document.querySelector('.local-skills-group .skill .sname')?.textContent).toBe(
      'test-qa-skill',
    )

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
    const frontendRow = screen.getByRole('button', { name: 'frontend-design' }).closest('.skill')
    expect(frontendRow).not.toBeNull()
    fireEvent.click(within(frontendRow as HTMLElement).getByRole('button', { name: 'CX' }))

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
      name: 'superpowers CX：部分已选择',
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
        { name: 'fresh', description: '', path: 'fresh/SKILL.md', installed: false },
        { name: 'installed', description: '', path: 'installed/SKILL.md', installed: true },
      ],
    } as never)

    render(<AddSkillModal open repoPath="/tmp/add-source-disabled" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://example.test/source.git' },
    })
    fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))

    await screen.findByText('fresh')
    const installed = screen.getByRole('checkbox', { name: 'installed' })
    expect((installed as HTMLInputElement).disabled).toBe(true)
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

      const dialog = await screen.findByRole('dialog', { name: 'Add Skill' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Source' }))
      fireEvent.change(within(dialog).getByPlaceholderText('https://github.com/org/repo'), {
        target: { value: 'https://example.test/skills.git' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Scan' }))
      expect(await within(dialog).findByText('alpha')).toBeDefined()

      fireEvent.click(within(dialog).getByRole('button', { name: '添加 Source' }))

      expect(await within(dialog).findByText(/members write failed/)).toBeDefined()
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(getManifestCallsBefore + 1))
      expect(api.getManifest).toHaveBeenCalledWith('/tmp/r')
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog', { name: 'Add Skill' })).toBeDefined()
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

    fireEvent.click(
      screen.getByRole('button', { name: 'frontend-design' }).closest('.skill') as HTMLElement,
    )

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
    await within(dialog).findByText('test-qa-skill')
    expect(within(dialog).queryByText(/name: test-qa-skill/)).toBeNull()
    expect(within(dialog).queryByText(/description: Preview description/)).toBeNull()
    expect(within(dialog).queryByText('metadata')).toBeNull()
    expect(within(dialog).getByText('name')).toBeDefined()
    expect(within(dialog).getByText('Preview description')).toBeDefined()
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
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑' }))
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: updated } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

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
                  members: [{ name: 'systematic-debugging', targets: ['codex'] }],
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
      targets: ['codex'],
    })
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

    const names = Array.from(document.querySelectorAll('.skill .sname')).map((el) =>
      el.textContent?.trim(),
    )
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
    fireEvent.click(expandLocal.closest('.group-head') as HTMLElement)
    expect(onToggleGroup).toHaveBeenLastCalledWith('local')

    const expand = screen.getByRole('button', { name: '展开 superpowers' })
    fireEvent.click(expand.closest('.group-head') as HTMLElement)
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
      expect(api.performUpdate).toHaveBeenCalledWith(expect.objectContaining({ newRef: 'v6.1.1' })),
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

    fireEvent.click(within(dialog).getByRole('button', { name: '全选' }))
    expect(within(dialog).getByText('已选 2 / 2')).toBeDefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '全不选' }))
    expect(within(dialog).getByText('已选 0 / 2')).toBeDefined()
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
      expect(api.setSourceMembers).toHaveBeenCalledWith({
        repo: '/tmp/edit-switch',
        url: 'https://example.test/alpha.git',
        members: ['alpha', 'beta'],
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
    expect(screen.getAllByText('RESULT').length).toBeGreaterThan(0)
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()
    expect(document.querySelectorAll('.merge-block-action[aria-label$="应用到结果"]')).toHaveLength(
      2,
    )
    expect(document.querySelectorAll('.merge-block-action[aria-label$="忽略变更"]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '保留两者' })).toBeDefined()
    expect(screen.getByRole('button', { name: '保留本地' })).toBeDefined()
    expect(screen.getByRole('button', { name: '保留远程' })).toBeDefined()
    expect(document.querySelectorAll('.merge-change-conflict').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.merge-change-stable').length).toBeGreaterThan(0)

    const localApply = document.querySelector(
      '.merge-block-action[aria-label="本地变更 1：应用到结果"]',
    ) as HTMLButtonElement
    expect(localApply).not.toBeNull()
    expect(localApply.closest('.cm-line')).toBeNull()
    expect(localApply.closest('.cm-gutters-after')).not.toBeNull()
    expect(localApply.closest('.merge-action-gutter')).not.toBeNull()
    expect(localApply.closest('.cm-lineNumbers')).toBeNull()
    expect(localApply.closest('.cm-gutterElement')).not.toBeNull()
    const localActionCellText = localApply.closest('.cm-gutterElement')?.textContent ?? ''
    expect(localActionCellText).toContain('→')
    expect(localActionCellText).toContain('×')
    expect(localActionCellText.indexOf('×')).toBeLessThan(localActionCellText.indexOf('→'))
    expect(localActionCellText).not.toMatch(/\d/)

    const remoteApply = document.querySelector(
      '.merge-block-action[aria-label="远程变更 1：应用到结果"]',
    ) as HTMLButtonElement
    expect(remoteApply).not.toBeNull()
    expect(remoteApply.closest('.cm-line')).toBeNull()
    expect(remoteApply.closest('.cm-gutters-before')).not.toBeNull()
    expect(remoteApply.closest('.merge-action-gutter')).not.toBeNull()
    expect(remoteApply.closest('.cm-lineNumbers')).toBeNull()
    const remoteActionCellText = remoteApply.closest('.cm-gutterElement')?.textContent ?? ''
    expect(remoteActionCellText).toContain('←')
    expect(remoteActionCellText).toContain('×')
    expect(remoteActionCellText).not.toMatch(/\d/)
    expect(document.querySelectorAll('.cm-line .merge-block-action')).toHaveLength(0)

    fireEvent.click(localApply)
    expect(
      Array.from(document.querySelectorAll('.merge-change-applied')).some((line) =>
        line.textContent?.includes('opencode'),
      ),
    ).toBe(true)
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()

    const undoLocalApply = document.querySelector(
      '.merge-block-action[aria-label="本地变更 1：撤回应用"]',
    ) as HTMLButtonElement
    expect(undoLocalApply).not.toBeNull()
    expect(undoLocalApply.disabled).toBe(false)
    fireEvent.click(undoLocalApply)
    expect(
      Array.from(document.querySelectorAll('.merge-change-conflict')).some((line) =>
        line.textContent?.includes('opencode'),
      ),
    ).toBe(true)
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '保留远程' }))
    expect(screen.queryByText('0 个待处理冲突')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '保留两者' }))
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()

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
