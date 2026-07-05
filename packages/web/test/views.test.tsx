// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../src/lib/api'
import Skills from '../src/views/skills/Skills'
import SkillSourceList from '../src/views/skills/SkillSourceList'
import AddSkillModal from '../src/views/skills/AddSkillModal'
import Sync from '../src/views/Sync'

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
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
    scanLocalSkills: vi.fn(async () => ({ ok: true, skills: [] })),
    updateLocalSkillTargets: vi.fn(async () => ({ ok: true })),
    getManifest: vi.fn(async (repoPath: string) =>
      repoPath === '/tmp/skills-layout'
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

describe('Skills view', () => {
  it('renders heading and project button', async () => {
    render(
      <MemoryRouter>
        <Skills repoPath="/tmp/r" />
      </MemoryRouter>,
    )
    expect(await screen.findByText('投影', { exact: false })).toBeDefined()
  })

  it('defaults every group to collapsed and supports bulk and individual toggles', async () => {
    render(
      <MemoryRouter>
        <Skills repoPath="/tmp/skills-layout" />
      </MemoryRouter>,
    )

    const expandAll = await screen.findByRole('button', { name: '全部展开' })
    expect(screen.queryByText('systematic-debugging')).toBeNull()
    expect(screen.queryByText('test-qa-skill')).toBeNull()

    fireEvent.click(expandAll)
    expect(screen.getByRole('button', { name: '全部收起' })).toBeDefined()
    expect(screen.getByText('systematic-debugging')).toBeDefined()

    const localName = screen.getByText('test-qa-skill')
    const localRow = localName.closest('.skill')
    expect(localRow).not.toBeNull()
    expect(within(localRow as HTMLElement).getByText('ref')).toBeDefined()
    expect(within(localRow as HTMLElement).getByText('本地路径')).toBeDefined()
    expect(within(localRow as HTMLElement).getByText('./assets/skills/test-qa-skill')).toBeDefined()
    expect(within(localRow as HTMLElement).queryByText('projected')).toBeNull()

    expect(within(localRow as HTMLElement).queryByText('OC')).toBeNull()
    expect(within(localRow as HTMLElement).getByText('路径不存在')).toBeDefined()
    expect(
      within(localRow as HTMLElement).queryByRole('button', { name: 'test-qa-skill' }),
    ).toBeNull()

    const frontendRow = screen.getByText('frontend-design').closest('.skill')
    expect(frontendRow).not.toBeNull()
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
    expect(screen.getByText('test-qa-skill')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '全部收起' }))
    expect(screen.getByRole('button', { name: '全部展开' })).toBeDefined()
    expect(screen.queryByText('test-qa-skill')).toBeNull()
  })
})

describe('Add Skill modal', () => {
  it('scans ~/.agents/skills when opened', async () => {
    render(<AddSkillModal open repoPath="/tmp/r" reload={vi.fn()} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(api.scanLocalSkills).toHaveBeenCalledWith('~/.agents/skills', '/tmp/r'),
    )
  })
})

describe('Skill source updates', () => {
  it('toggles from the group header but not from links or actions', () => {
    const onToggleGroup = vi.fn()
    const onOpenEdit = vi.fn()
    render(
      <SkillSourceList
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
        reload={vi.fn()}
        showToast={vi.fn()}
        setError={vi.fn()}
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
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
      <SkillSourceList
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
        reload={vi.fn()}
        showToast={vi.fn()}
        setError={vi.fn()}
        onOpenDetail={vi.fn()}
        onOpenScan={vi.fn()}
        onOpenEdit={vi.fn()}
        expandedGroups={new Set()}
        onToggleGroup={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))

    await waitFor(() =>
      expect(api.performUpdate).toHaveBeenCalledWith(expect.objectContaining({ newRef: 'v6.1.1' })),
    )
  })
})

describe('Sync view', () => {
  it('renders pull and push buttons', async () => {
    render(
      <MemoryRouter>
        <Sync repoPath="/tmp/r" />
      </MemoryRouter>,
    )
    expect(screen.getByText('拉取', { exact: true })).toBeDefined()
    expect(screen.getByText('上传', { exact: true })).toBeDefined()
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
      <MemoryRouter>
        <Sync repoPath="/tmp/restored" />
      </MemoryRouter>,
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
      <MemoryRouter>
        <Sync repoPath="/tmp/r" />
      </MemoryRouter>,
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
      <MemoryRouter>
        <Sync repoPath="/tmp/r" />
      </MemoryRouter>,
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
})
