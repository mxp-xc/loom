// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, vi } from 'vitest'
import ToastHost from '../src/components/ToastHost'
import { dismissToast } from '../src/hooks/useToast'
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

function renderSync() {
  render(
    <>
      <ToastHost />
      <Sync repoPath="/repo" />
    </>,
  )
}

describe('Sync force operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dismissToast()
    api.getSyncRemote.mockResolvedValue({ remoteUrl: 'https://example.com/repo.git' })
    api.getSyncSession.mockResolvedValue({ ok: true, active: false })
    api.syncForcePush.mockResolvedValue({ ok: true })
    api.syncForcePull.mockResolvedValue({ ok: true, clean: true, conflicts: [] })
  })

  it('requires confirmation before force-pushing', async () => {
    renderSync()
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

  it('keeps the remote region mounted while the remote URL is loading', async () => {
    api.getSyncRemote.mockImplementation(() => new Promise(() => {}))

    renderSync()

    const remoteRegion = screen.getByRole('region', { name: '当前远程仓库' })
    expect(remoteRegion).toBeDefined()
    expect(within(remoteRegion).getByText('remote loading')).toBeDefined()
  })

  it('requires confirmation before force-pulling', async () => {
    renderSync()
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

    renderSync()
    await screen.findByText(/Git 检测到 1 个冲突文件/)

    expect(screen.getByRole('button', { name: '强制拉取' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '强制推送' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '更换 remote' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('请先解决或放弃本次合并，再更换 remote。')).toBeDefined()
  })

  it('switches an existing remote without pulling or pushing', async () => {
    renderSync()
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '更换 remote' }))
    expect((screen.getByLabelText('remote URL') as HTMLInputElement).value).toBe(
      'https://example.com/repo.git',
    )

    fireEvent.change(screen.getByLabelText('remote URL'), {
      target: { value: 'https://git.example.test/user/repo.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 remote' }))

    await waitFor(() =>
      expect(api.setSyncRemote).toHaveBeenCalledWith({
        repo: '/repo',
        remoteUrl: 'https://git.example.test/user/repo.git',
      }),
    )
    expect(api.syncPull).not.toHaveBeenCalled()
    expect(api.syncPush).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: '更换 remote' })
    expect(dialog).toBeDefined()
    expect(
      screen.getByText(
        'remote 已切换到 https://git.example.test/user/repo.git，不会自动拉取，也不会自动上传。需要同步时请手动点击拉取或上传。',
      ),
    ).toBeDefined()
    fireEvent.click(within(dialog).getByText('关闭'))
    expect(
      await screen.findByRole('link', { name: 'https://git.example.test/user/repo.git' }),
    ).toBeDefined()
  })

  it('shows upload failure details in the feedback dialog', async () => {
    api.syncPush.mockResolvedValue({ ok: false, error: '网络连接失败，请稍后重试' })

    renderSync()
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '上传' }))

    expect(await screen.findByRole('dialog', { name: '上传本地变更' })).toBeDefined()
    expect(screen.getAllByText('上传失败').length).toBeGreaterThan(0)
    expect(screen.getAllByText('网络连接失败，请稍后重试').length).toBeGreaterThan(0)
  })

  it('can stop waiting for a running upload from the feedback dialog', async () => {
    api.syncPush.mockImplementation(
      (_repo: string, options?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )

    renderSync()
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '上传' }))
    expect(await screen.findByRole('dialog', { name: '上传本地变更' })).toBeDefined()

    const options = api.syncPush.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
    expect(options?.signal).toBeDefined()

    fireEvent.click(screen.getByLabelText('关闭'))

    await waitFor(() => expect(options?.signal?.aborted).toBe(true))
    expect(await screen.findByText('已停止等待')).toBeDefined()
  })
})
