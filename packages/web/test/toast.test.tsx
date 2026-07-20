// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToastHost from '../src/components/ToastHost'
import { clearToasts, dismissToast, showErrorToast, showToast } from '../src/hooks/useToast'

describe('ToastHost', () => {
  afterEach(() => {
    act(() => clearToasts())
    vi.useRealTimers()
  })

  it('queues app-level feedback and dismisses a specific toast', () => {
    render(<ToastHost />)

    let first = ''
    act(() => {
      first = showToast('已创建')
      showToast('已保存')
    })
    expect(screen.getByText('已创建')).toBeDefined()
    expect(screen.getByText('已保存')).toBeDefined()

    act(() => dismissToast(first))
    expect(screen.queryByText('已创建')).toBeNull()
    expect(screen.getByText('已保存')).toBeDefined()
  })

  it('keeps at most four toasts and dismisses success feedback after its duration', () => {
    vi.useFakeTimers()
    render(<ToastHost />)

    act(() => {
      for (let index = 1; index <= 5; index += 1) showToast(`通知 ${index}`)
    })
    expect(screen.queryByText('通知 1')).toBeNull()
    expect(screen.getAllByRole('article')).toHaveLength(4)

    act(() => vi.advanceTimersByTime(2_999))
    expect(screen.getByText('通知 5')).toBeDefined()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByLabelText('通知')).toBeNull()
  })

  it('pauses the remaining duration while hovered and resumes from that point', () => {
    vi.useFakeTimers()
    render(<ToastHost />)
    act(() => showToast('可暂停'))

    const toast = screen.getByText('可暂停').closest('article')!
    act(() => vi.advanceTimersByTime(1_000))
    fireEvent.mouseEnter(toast)
    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getByText('可暂停')).toBeDefined()

    fireEvent.mouseLeave(toast)
    act(() => vi.advanceTimersByTime(1_999))
    expect(screen.getByText('可暂停')).toBeDefined()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByText('可暂停')).toBeNull()
  })

  it('merges repeated errors and keeps technical details collapsed', () => {
    render(<ToastHost />)
    act(() => {
      showErrorToast(new Error('upstream failed'), {
        title: '保存失败',
        message: '请稍后重试',
      })
      showErrorToast(new Error('upstream failed'), {
        title: '保存失败',
        message: '请稍后重试',
      })
    })

    expect(screen.getByText('发生 2 次')).toBeDefined()
    expect(screen.getByText('技术详情').closest('details')?.hasAttribute('open')).toBe(false)
  })

  it('does not auto-dismiss an actionable error', () => {
    vi.useFakeTimers()
    render(<ToastHost />)
    act(() => {
      showErrorToast(new Error('offline'), {
        title: '加载失败',
        message: '请重试',
        action: { label: '重试', run: () => undefined },
      })
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('加载失败')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '关闭“加载失败”' }))
    expect(screen.queryByText('加载失败')).toBeNull()
  })

  it('dismisses a toast after its recovery action resolves', async () => {
    render(<ToastHost />)
    const run = vi.fn().mockResolvedValue(undefined)
    act(() => {
      showErrorToast(new Error('offline'), {
        title: '加载失败',
        message: '请重试',
        action: { label: '重试', run },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByRole('button', { name: '正在重试' })).toBeDefined()
    await waitFor(() => expect(screen.queryByText('加载失败')).toBeNull())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps a toast actionable and logs the full error after recovery rejects', async () => {
    const err = new Error('still offline')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<ToastHost />)
    act(() => {
      showErrorToast(new Error('offline'), {
        title: '加载失败',
        message: '请重试',
        action: { label: '重试', run: () => Promise.reject(err) },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeDefined())
    expect(screen.getByText('加载失败')).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      { err, toastId: expect.stringMatching(/^toast-/) },
      'Failed to run toast recovery action',
    )
    consoleError.mockRestore()
  })
})
