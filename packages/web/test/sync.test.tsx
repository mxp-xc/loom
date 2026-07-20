// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost from '../src/components/ToastHost'
import { dismissToast } from '../src/hooks/useToast'
import Sync from '../src/views/Sync'
import type {
  SyncConflictSaveResponse,
  SyncPullResponse,
  SyncPushResponse,
  SyncSessionResponse,
} from '../src/lib/api'
import { deferred } from './deferred'

interface RequestOptions {
  signal?: AbortSignal
}

const api = vi.hoisted(() => ({
  getSyncRemote: vi.fn<(repo: string) => Promise<{ remoteUrl: string | null }>>(async () => ({
    remoteUrl: 'https://example.com/repo.git',
  })),
  getSyncSession: vi.fn<(repo: string) => Promise<SyncSessionResponse>>(async () => ({
    ok: true,
    active: false,
  })),
  syncPull: vi.fn<(repo: string, options?: RequestOptions) => Promise<SyncPullResponse>>(
    async () => ({
      ok: true,
      clean: true,
      conflicts: [],
    }),
  ),
  syncPush: vi.fn<(repo: string, options?: RequestOptions) => Promise<SyncPushResponse>>(
    async () => ({
      ok: true,
    }),
  ),
  syncForcePush: vi.fn<(repo: string) => Promise<SyncPushResponse>>(async () => ({ ok: true })),
  syncForcePull: vi.fn<(repo: string) => Promise<SyncPullResponse>>(async () => ({
    ok: true,
    clean: true,
    conflicts: [],
  })),
  saveSyncConflict: vi.fn<
    (body: { sessionId: string; path: string; result: string }) => Promise<SyncConflictSaveResponse>
  >(async () => ({ ok: true, clean: true, remaining: [] })),
  abortSyncMerge: vi.fn<
    (sessionId: string) => Promise<{ ok: boolean; error?: string; message?: string }>
  >(async () => ({ ok: true })),
  setSyncRemote: vi.fn<(body: { repo: string; remoteUrl: string }) => Promise<{ ok: boolean }>>(
    async () => ({ ok: true }),
  ),
}))

vi.mock('../src/lib/api', () => ({ api }))
vi.mock('../src/views/sync/ConflictEditor', () => ({
  default: ({ onAbort }: { onAbort: () => void }) => (
    <div>
      冲突编辑器<button onClick={onAbort}>放弃合并</button>
    </div>
  ),
}))

const conflictSession: SyncSessionResponse = {
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
}

function syncView(repoPath: string) {
  return (
    <>
      <ToastHost />
      <Sync repoPath={repoPath} />
    </>
  )
}

function renderSync(repoPath = '/repo') {
  return render(syncView(repoPath))
}

describe('Sync force operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dismissToast()
    api.getSyncRemote.mockResolvedValue({ remoteUrl: 'https://example.com/repo.git' })
    api.getSyncSession.mockResolvedValue({
      ok: true,
      active: false,
    })
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
    api.getSyncSession.mockImplementation(() => new Promise(() => {}))

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
    api.getSyncSession.mockResolvedValue(conflictSession)

    renderSync()
    await screen.findByText(/Git 检测到 1 个冲突文件/)

    expect(screen.getByRole('button', { name: '强制拉取' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '强制推送' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '更换 remote' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('请先解决或放弃本次合并，再更换 remote。')).toBeDefined()
  })

  it('explains that multiple conflict files are resolved one at a time', async () => {
    api.getSyncSession.mockResolvedValue({
      ...conflictSession,
      conflicts: [
        conflictSession.conflicts[0],
        { ...conflictSession.conflicts[0], path: 'agents.yaml' },
      ],
    })

    renderSync()

    expect(
      await screen.findByText('Git 检测到 2 个冲突文件，当前显示第 1/2 个，保存后继续下一个'),
    ).toBeDefined()
  })

  it('keeps the conflict visible when abort resolves with a failure response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    api.getSyncSession.mockResolvedValue(conflictSession)
    api.abortSyncMerge.mockResolvedValue({
      ok: false,
      error: 'cleanup_pending',
      message: '同步结果仍在清理',
    })

    renderSync()
    await screen.findByText('冲突编辑器')
    fireEvent.click(screen.getByRole('button', { name: '放弃合并' }))

    expect(await screen.findByText('同步操作失败')).toBeDefined()
    expect(screen.getByText('冲突编辑器')).toBeDefined()
    expect(screen.queryByText('已放弃本次合并')).toBeNull()
    expect(consoleError).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Sync merge abort failed')
    consoleError.mockRestore()
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

  it('shows an empty remote URL error next to the input', async () => {
    api.getSyncRemote.mockResolvedValueOnce({ remoteUrl: '' })
    renderSync()

    const input = await screen.findByLabelText('remote URL')
    fireEvent.click(screen.getByRole('button', { name: '保存 remote' }))

    expect(screen.getByText('remote URL 不能为空')).toBeDefined()
    expect(input.getAttribute('aria-describedby')).toBe('sync-remote-error')
  })

  it('shows upload failure details in the feedback dialog', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = { ok: false, error: '网络连接失败，请稍后重试' } as const
    api.syncPush.mockResolvedValue(result)

    renderSync()
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '上传' }))

    expect(await screen.findByRole('dialog', { name: '上传本地变更' })).toBeDefined()
    expect(screen.getAllByText('上传失败').length).toBeGreaterThan(0)
    expect(screen.getAllByText('网络连接失败，请稍后重试').length).toBeGreaterThan(0)
    expect(consoleError).toHaveBeenCalledWith({ result }, 'Sync push failed')
    consoleError.mockRestore()
  })

  it('explains non-fast-forward upload failures without showing raw git output', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = {
      ok: false,
      nonFastForward: true,
      message:
        'To https://github.com/mxp-xc/my-loom.git\n ! [rejected] HEAD -> main (fetch first)\nhint: Updates were rejected because the remote contains work that you do not have locally.',
    } as const
    api.syncPush.mockResolvedValue(result)

    renderSync()
    await screen.findByText('https://example.com/repo.git')

    fireEvent.click(screen.getByRole('button', { name: '上传' }))

    expect(await screen.findByRole('dialog', { name: '上传本地变更' })).toBeDefined()
    expect(screen.getAllByText('远端有本地没有的更新，上传被 Git 拒绝。').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText(
        '请先点“拉取”合并远端变更；如果有冲突，处理完成后再上传。只有确定要用本地覆盖远端时，才使用“强制推送”。',
      ).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(/fetch first/)).toBeNull()
    expect(consoleError).toHaveBeenCalledWith({ result }, 'Sync push failed')
    consoleError.mockRestore()
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

  it('ignores an old remote response after switching repositories', async () => {
    const repoA = deferred<{ remoteUrl: string | null }>()
    const repoB = deferred<{ remoteUrl: string | null }>()
    api.getSyncRemote.mockImplementation((repoPath) =>
      repoPath === '/repo-a' ? repoA.promise : repoB.promise,
    )
    const view = renderSync('/repo-a')

    view.rerender(syncView('/repo-b'))
    repoB.resolve({ remoteUrl: 'https://example.com/repo-b.git' })
    expect(await screen.findByText('https://example.com/repo-b.git')).toBeDefined()

    repoA.resolve({ remoteUrl: 'https://example.com/repo-a.git' })
    await waitFor(() => expect(screen.queryByText('https://example.com/repo-a.git')).toBeNull())
    expect(screen.getByText('https://example.com/repo-b.git')).toBeDefined()
  })

  it('clears conflicts when the next repository has no active session', async () => {
    api.getSyncRemote.mockImplementation(async (repoPath) => ({
      remoteUrl: `https://example.com${repoPath}.git`,
    }))
    api.getSyncSession.mockImplementation(async (repoPath) =>
      repoPath === '/repo-a' ? conflictSession : { ok: true, active: false },
    )
    const view = renderSync('/repo-a')
    await screen.findByText('冲突编辑器')

    view.rerender(syncView('/repo-b'))

    expect(await screen.findByText('https://example.com/repo-b.git')).toBeDefined()
    await waitFor(() => expect(screen.queryByText('冲突编辑器')).toBeNull())
    expect(screen.queryByText(/Git 检测到 1 个冲突文件/)).toBeNull()
  })

  it('ignores a pending operation result after switching repositories', async () => {
    const upload = deferred<SyncPushResponse>()
    api.getSyncRemote.mockImplementation(async (repoPath) => ({
      remoteUrl: `https://example.com${repoPath}.git`,
    }))
    api.syncPush.mockReturnValue(upload.promise)
    const view = renderSync('/repo-a')
    await screen.findByText('https://example.com/repo-a.git')

    fireEvent.click(screen.getByRole('button', { name: '上传' }))
    expect(await screen.findByRole('dialog', { name: '上传本地变更' })).toBeDefined()
    view.rerender(syncView('/repo-b'))
    expect(await screen.findByText('https://example.com/repo-b.git')).toBeDefined()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '上传本地变更' })).toBeNull())

    upload.resolve({ ok: true })
    await waitFor(() => expect(screen.queryByText('上传成功，远端已同步')).toBeNull())
    expect(screen.getByText('https://example.com/repo-b.git')).toBeDefined()
  })
})
