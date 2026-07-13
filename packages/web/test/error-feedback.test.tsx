// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorDetails, ErrorDialog, ErrorState, FieldError } from '../src/components/ErrorFeedback'

describe('error feedback components', () => {
  it('associates a field error with its input', () => {
    render(
      <>
        <input aria-label="名称" aria-describedby="name-error" />
        <FieldError id="name-error">名称不能为空</FieldError>
      </>,
    )
    expect(screen.getByRole('alert').id).toBe('name-error')
  })

  it('keeps technical details collapsed by default', () => {
    render(<ErrorDetails code="failed" detail="upstream response" />)
    const disclosure = screen.getByText('技术详情').closest('details')!
    expect(disclosure.hasAttribute('open')).toBe(false)
    fireEvent.click(screen.getByText('技术详情'))
    expect(disclosure.hasAttribute('open')).toBe(true)
    expect(screen.getByText('错误码: failed')).toBeDefined()
  })

  it('runs an error-state recovery action', async () => {
    const retry = vi.fn()
    render(<ErrorState title="加载失败" message="请重试" action={{ label: '重试', run: retry }} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(retry).toHaveBeenCalledOnce())
  })

  it('logs a rejected recovery action and returns the button to idle', async () => {
    const err = new Error('retry failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorState
        title="加载失败"
        message="请重试"
        action={{ label: '重试', run: () => Promise.reject(err) }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeDefined())
    expect(consoleError).toHaveBeenCalledWith({ err }, 'Failed to run error recovery action')
    consoleError.mockRestore()
  })

  it('uses the shared modal foundation for blocking errors', () => {
    render(
      <ErrorDialog
        open
        onClose={() => undefined}
        feedback={{ title: '无法继续', message: '请返回后重试' }}
      />,
    )
    expect(screen.getByRole('dialog', { name: '无法继续' })).toBeDefined()
    expect(screen.getByText('请返回后重试')).toBeDefined()
  })
})
