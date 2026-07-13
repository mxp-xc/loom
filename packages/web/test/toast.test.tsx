// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
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
})
