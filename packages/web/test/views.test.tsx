// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../src/lib/api'
import Skills from '../src/views/skills/Skills'
import SkillSourceList from '../src/views/skills/SkillSourceList'
import AddSkillModal from '../src/views/skills/AddSkillModal'
import Sync from '../src/views/Sync'

vi.mock('../src/lib/api', () => ({
  api: {
    init: vi.fn(async () => ({ ok: true, active_repo: 'default', repoPath: '/tmp/r' })),
    status: vi.fn(async () => ({ active_repo: 'default', repoPath: '/tmp/r' })),
    project: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => ({ updates: [] })),
    performUpdate: vi.fn(async () => ({ pinned_commit: 'bbb' })),
    syncPull: vi.fn(async () => ({ clean: true, files: [], textConflicts: [] })),
    syncPush: vi.fn(async () => ({ ok: true })),
    syncApply: vi.fn(async () => ({ ok: true })),
    getSyncRemote: vi.fn(async () => ({ remoteUrl: null })),
    setSyncRemote: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(async () => ({ effective: {}, repo: {}, local: {} })),
    scanLocalSkills: vi.fn(async () => ({ ok: true, skills: [] })),
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
  it('renders pull and push buttons', () => {
    render(
      <MemoryRouter>
        <Sync repoPath="/tmp/r" />
      </MemoryRouter>,
    )
    expect(screen.getByText('拉取', { exact: true })).toBeDefined()
    expect(screen.getByText('上传', { exact: true })).toBeDefined()
  })
})
