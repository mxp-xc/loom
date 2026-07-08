// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ToastHost from '../src/components/ToastHost'
import { dismissToast, showToast } from '../src/hooks/useToast'

describe('ToastHost', () => {
  afterEach(() => {
    act(() => dismissToast())
  })

  it('renders app-level feedback and replaces the current toast', () => {
    render(<ToastHost />)

    act(() => showToast('已创建'))
    expect(screen.getByText('已创建')).toBeDefined()

    act(() => showToast('已保存'))
    expect(screen.queryByText('已创建')).toBeNull()
    expect(screen.getByText('已保存')).toBeDefined()

    act(() => dismissToast())
    expect(screen.queryByText('已保存')).toBeNull()
  })
})
