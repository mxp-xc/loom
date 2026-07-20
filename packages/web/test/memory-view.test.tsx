// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Memory from '../src/views/Memory'
import { api } from '../src/lib/api'

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

vi.mock('../src/lib/api', () => ({
  api: {
    getManifest: vi.fn(),
    getMemory: vi.fn(),
    getMemoryContent: vi.fn(),
    updateMemoryAgent: vi.fn(),
    setMemoryActive: vi.fn(),
    createMemory: vi.fn(),
    renameMemory: vi.fn(),
    deleteMemory: vi.fn(),
    saveMemoryContent: vi.fn(),
    reorderMemories: vi.fn(),
    project: vi.fn(),
    getOpenPathPreference: vi.fn(() => new Promise(() => {})),
    setOpenPathPreference: vi.fn(async () => ({ ok: true })),
    resolvePath: vi.fn(async () => ({ ok: true, path: '/repo/path' })),
    openPath: vi.fn(async () => ({ ok: true })),
    vars: { getMatrix: vi.fn() },
  },
}))

const manifest = {
  skills: { sources: [], skills: [] },
  mcp: [],
  vars: { default: {}, active: {} },
  config: { agents: ['codex', 'opencode'] },
  errors: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getManifest).mockResolvedValue(manifest as never)
  vi.mocked(api.getMemory).mockResolvedValue({
    memories: [],
    assignments: {},
    active: null,
    activeContent: '',
  })
  vi.mocked(api.getMemoryContent).mockImplementation(async (_repo, name) => ({
    content: `# ${name}`,
  }))
  vi.mocked(api.updateMemoryAgent).mockResolvedValue({ ok: true, assignments: {} })
  vi.mocked(api.deleteMemory).mockResolvedValue({ ok: true })
  vi.mocked(api.project).mockResolvedValue({ ok: true })
  vi.mocked(api.vars.getMatrix).mockResolvedValue({
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
  })
})

describe('Memory view', () => {
  it('uses the dropdown manager and preview-first workbench layout', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'review-rules', agents: ['opencode'] },
      ],
      assignments: { codex: 'v1', opencode: 'review-rules' },
      active: null,
      activeContent: '',
    })
    vi.mocked(api.getMemoryContent).mockResolvedValue({ content: '# Active memory' })

    render(<Memory repoPath="/tmp/memory-layout-approved" />)

    expect(await screen.findByTestId('memory-layout')).toBeDefined()
    expect(screen.getByRole('tab', { name: '所见' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'v1', level: 1 })).toBeDefined()
    expect(screen.getByLabelText('Memory 状态').textContent).toContain('1 个 Agent')
    expect(screen.getByRole('article').textContent).toContain('Active memory')

    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    const menu = screen.getByRole('menu', { name: 'Memory 列表' })
    expect(within(menu).getByRole('menuitem', { name: '新建 Memory' })).toBeDefined()
    expect(within(menu).getByRole('button', { name: '删除 v1' })).toBeDefined()
    expect(within(menu).getByRole('button', { name: 'v1 已投影到 Codex' })).toBeDefined()
  })

  it('closes the Memory selector with Escape and restores trigger focus', async () => {
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [{ name: 'v1', agents: ['codex'] }],
      assignments: { codex: 'v1' },
      active: null,
      activeContent: '',
    })

    render(<Memory repoPath="/tmp/memory-menu-escape" />)

    const trigger = await screen.findByRole('button', { name: /Memory.*v1/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu', { name: 'Memory 列表' })).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('menu', { name: 'Memory 列表' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('hides preserved assignments for agents outside the configured scope', async () => {
    vi.mocked(api.getManifest).mockResolvedValue({
      ...manifest,
      config: { agents: ['codex'] },
    } as never)
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [{ name: 'v1', agents: ['codex', 'opencode'] }],
      assignments: { codex: 'v1', opencode: 'v1' },
      active: null,
      activeContent: '',
    })

    render(<Memory repoPath="/tmp/memory-configured-scope" />)

    const status = await screen.findByLabelText('Memory 状态')
    expect(status.textContent).toContain('1 个 Agent')
    expect(document.querySelector('[data-agent="codex"]')).not.toBeNull()
    expect(document.querySelector('[data-agent="opencode"]')).toBeNull()
  })

  it('ignores stale content when selections resolve out of order', async () => {
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
    })
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
    })

    render(<Memory repoPath="/tmp/memory-unsaved-switch" />)
    await screen.findByRole('button', { name: /Memory.*v1/ })
    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    const source = screen.getByRole('textbox', { name: 'Memory 内容' })
    fireEvent.change(source, { target: { value: '# Edited draft' } })

    fireEvent.click(screen.getByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'v2' }))
    const dialog = await screen.findByRole('dialog', { name: '放弃未保存更改' })
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
    vi.mocked(api.getMemory)
      .mockResolvedValueOnce({
        memories: [{ name: 'v1', agents: ['codex'] }],
        assignments: { codex: 'v1' },
        active: null,
        activeContent: '',
      })
      .mockResolvedValueOnce({
        memories: [{ name: 'v1', agents: ['codex', 'opencode'] }],
        assignments: { codex: 'v1', opencode: 'v1' },
        active: null,
        activeContent: '',
      })

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
    vi.mocked(api.getMemory).mockResolvedValue({
      memories: [
        { name: 'v1', agents: ['codex'] },
        { name: 'v2', agents: ['opencode'] },
      ],
      assignments: { codex: 'v1', opencode: 'v2' },
      active: null,
      activeContent: '',
    })

    render(<Memory repoPath="/tmp/memory-conflict" />)
    fireEvent.click(await screen.findByRole('button', { name: 'v1 投影到 OpenCode' }))
    const dialog = await screen.findByRole('dialog', { name: '切换 OpenCode 的 Memory' })
    expect(dialog.textContent).toContain('v2')
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
    })

    render(<Memory repoPath="/tmp/memory-actions" />)
    fireEvent.click(await screen.findByRole('button', { name: /Memory.*v1/ }))
    fireEvent.click(screen.getByRole('button', { name: '删除 v2' }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: '删除 Memory' })).getByRole('button', {
        name: '删除',
      }),
    )
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith('/tmp/memory-actions', 'v2'))
  })
})
