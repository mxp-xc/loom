// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, vi } from 'vitest'
import Sync from '../src/views/Sync'

const api = vi.hoisted(() => ({
  getSyncRemote: vi.fn(async () => ({ remoteUrl: 'https://example.com/repo.git' })),
  getSyncSession: vi.fn(async () => ({ ok: true, active: false })),
  syncPull: vi.fn(async () => ({ ok: true, clean: true, conflicts: [] })),
  syncPush: vi.fn(async () => ({ ok: true })),
  syncForcePush: vi.fn(async () => ({ ok: true })),
  syncForcePull: vi.fn(async () => ({ ok: true, clean: true, conflicts: [] })),
  saveSyncConflict: vi.fn(),
  abortSyncMerge: vi.fn(),
  setSyncRemote: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../src/lib/api', () => ({ api }))
vi.mock('../src/views/sync/ConflictEditor', () => ({
  default: () => <div>冲突编辑器</div>,
}))

describe('Sync force operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getSyncRemote.mockResolvedValue({ remoteUrl: 'https://example.com/repo.git' })
    api.getSyncSession.mockResolvedValue({ ok: true, active: false })
    api.syncForcePush.mockResolvedValue({ ok: true })
    api.syncForcePull.mockResolvedValue({ ok: true, clean: true, conflicts: [] })
  })

  it('requires confirmation before force-pushing', async () => {
    render(<Sync repoPath="/repo" />)
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '强制推送' }))
    expect(screen.getByRole('dialog', { name: '确认强制推送' })).toBeDefined()
    expect(
      screen.getByText('远端内容会被本地配置覆盖。其他设备已推送但本地没有的内容可能丢失。'),
    ).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认强制推送' })).toBeNull())
    expect(api.syncForcePush).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '强制推送' }))
    fireEvent.click(screen.getByRole('button', { name: '确认强制推送' }))

    await waitFor(() => expect(api.syncForcePush).toHaveBeenCalledWith('/repo'))
    expect(await screen.findByText('强制推送完成')).toBeDefined()
  })

  it('requires confirmation before force-pulling', async () => {
    render(<Sync repoPath="/repo" />)
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '强制拉取' }))
    expect(screen.getByRole('dialog', { name: '确认强制拉取' })).toBeDefined()
    expect(
      screen.getByText('本地未提交修改、本地提交、未跟踪文件和目录都会被远端覆盖或删除。'),
    ).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认强制拉取' })).toBeNull())
    expect(api.syncForcePull).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '强制拉取' }))
    fireEvent.click(screen.getByRole('button', { name: '确认强制拉取' }))

    await waitFor(() => expect(api.syncForcePull).toHaveBeenCalledWith('/repo'))
    expect(await screen.findByText('强制拉取完成')).toBeDefined()
  })

  it('disables force operations while conflicts are active', async () => {
    api.getSyncSession.mockResolvedValue({
      ok: true,
      active: true,
      clean: false,
      sessionId: 'session-1',
      conflicts: [
        {
          path: 'skills.yaml',
          base: 'base',
          ours: 'local',
          theirs: 'remote',
          result: '<<<<<<< HEAD\n',
          binary: false,
        },
      ],
    })

    render(<Sync repoPath="/repo" />)
    await screen.findByText(/Git 检测到 1 个冲突文件/)

    expect(screen.getByRole('button', { name: '强制拉取' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '强制推送' }).hasAttribute('disabled')).toBe(true)
  })
})
