// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
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

beforeEach(() => {
  vi.clearAllMocks()
  monacoEditorMock.reset()
  window.history.replaceState({}, '', '/mcp')
})

vi.mock('../src/lib/api', () => ({
  api: {
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
    cancelSourceUpdate: vi.fn(async () => ({ ok: true })),
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
    reorderSkillGroups: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true, ids })),
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

describe('Skills page', () => {
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
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(1))

      fireEvent.click(screen.getByRole('button', { name: '投影' }))

      expect(await screen.findByText('Skills 操作失败')).toBeDefined()
      expect(screen.getByText('投影失败: stale yaml')).toBeDefined()
      await waitFor(() => expect(api.project).toHaveBeenCalledTimes(1))

      fireEvent.click(screen.getByRole('button', { name: '关闭“Skills 操作失败”' }))

      fireEvent.click(screen.getByRole('button', { name: '投影' }))

      await waitFor(() => expect(api.project).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(2))
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
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(1))
    expect(api.project).toHaveBeenLastCalledWith({ repo: '/tmp/skills-layout', scope: 'skills' })
  })

  it('supports source-level bulk projection chips in the source header', async () => {
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

    await waitFor(() => expect(api.updateSourceSkillAgents).toHaveBeenCalledTimes(1))
    expect(api.updateSourceSkillAgents).toHaveBeenLastCalledWith({
      repo: '/tmp/skills-layout',
      sourceUrl: 'https://github.com/obra/superpowers.git',
      updates: [
        { memberEntry: 'brainstorming/SKILL.md', agents: ['codex'] },
        { memberEntry: 'executing-plans/SKILL.md', agents: ['codex'] },
        { memberEntry: 'disabled-skill/SKILL.md', agents: ['codex'] },
      ],
    })
    expect(api.updateSkillAgents).not.toHaveBeenCalled()
    expect(api.updateLocalSkillAgents).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-only' }),
    )
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(1))
    expect(api.project).toHaveBeenLastCalledWith({ repo: '/tmp/skills-layout', scope: 'skills' })
  })

  it('updates skill bulk agents one item at a time', async () => {
    let releaseFirst!: () => void
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

    await waitFor(() => expect(api.updateSkillAgents).toHaveBeenCalledTimes(1))
    expect(api.updateLocalSkillAgents).not.toHaveBeenCalled()

    releaseFirst()
    await waitFor(() => expect(api.updateLocalSkillAgents).toHaveBeenCalledTimes(2))
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
    const onClose = vi.fn()
    const rendered = render(
      <AddSkillModal open repoPath="/tmp/add-refs-reopen" onClose={onClose} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://example.test/pending.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Repository ref' }))
    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(1))

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

    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('option', { name: 'main' })).toBeDefined()
  })

  it('does not load refs when the Add Source URL loses focus', async () => {
    render(<AddSkillModal open repoPath="/tmp/add-refs-lazy" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    const url = screen.getByPlaceholderText('https://host.example/org/repo.git')
    fireEvent.change(url, { target: { value: 'https://example.test/lazy.git' } })
    fireEvent.blur(url)
    fireEvent.click(screen.getByRole('button', { name: 'branch' }))
    await act(async () => await Promise.resolve())

    expect(api.getSourceRefs).not.toHaveBeenCalled()
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ ok: false }),
        message: 'repository tree unavailable',
      }),
      'Manifest operation returned ok:false',
    )
    consoleError.mockRestore()
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
      expect(api.getManifest).not.toHaveBeenCalled()
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

    expect(await screen.findByRole('dialog', { name: '确认 skills 更新' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() =>
      expect(api.cancelSourceUpdate).toHaveBeenCalledWith({
        repo: '/tmp/tag-update',
        sessionId: 'update-1',
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认 skills 更新' })).toBeNull(),
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
    expect(api.getSourceRefs).not.toHaveBeenCalled()
    expect(api.scanSource).not.toHaveBeenCalled()
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
    expect(api.getSkillContent).toHaveBeenCalledWith('/tmp/skills-layout', {
      kind: 'source',
      sourceUrl: 'https://github.com/obra/superpowers.git',
      memberEntry: 'brainstorming/SKILL.md',
    })

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

    expect(api.getSourceRefs).not.toHaveBeenCalled()
    expect(api.scanSource).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'branch' }))
    expect(api.getSourceRefs).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Repository ref' }))
    await within(dialog).findByRole('option', { name: 'release' })
    expect(api.getSourceRefs).toHaveBeenCalledTimes(1)
    expect(api.scanSource).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('option', { name: 'main' }))
    expect(api.scanSource).not.toHaveBeenCalled()
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ ok: false }),
        message: 'repository tree unavailable',
      }),
      'Manifest operation returned ok:false',
    )
    consoleError.mockRestore()
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

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const firstDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    expect(api.getCachedSourceTree).toHaveBeenCalledTimes(1)
    expect(api.scanSource).not.toHaveBeenCalled()

    fireEvent.click(within(firstDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Source/ })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const secondDialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    await waitFor(() => expect(api.getCachedSourceTree).toHaveBeenCalledTimes(2))
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

    render(
      <StrictMode>
        <EditSourceSwitchHarness />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })

    await waitFor(() => expect(api.getCachedSourceTree).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveTree(sourceTreeResponse(['alpha']))
      await Promise.resolve()
    })

    expect(await within(dialog).findByRole('checkbox', { name: 'Select alpha' })).toBeDefined()
    expect(api.getCachedSourceTree).toHaveBeenCalledTimes(1)
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

    render(<EditSourceSwitchHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const firstDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(firstDialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Repository ref' }))
    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(1))

    fireEvent.click(within(firstDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Source/ })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
    const secondDialog = await screen.findByRole('dialog', { name: /Edit Source/ })
    await within(secondDialog).findByRole('checkbox', { name: 'Select alpha' })
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Repository ref' }))

    await waitFor(() => expect(api.getSourceRefs).toHaveBeenCalledTimes(2))
    expect(await within(secondDialog).findByRole('option', { name: 'main' })).toBeDefined()
  })
})
