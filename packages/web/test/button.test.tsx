// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from '../src/components/ui/button'
import { IconButton } from '../src/components/ui/IconButton'
import { Trash2 } from 'lucide-react'
import '../src/index.css'

describe('Button', () => {
  it('keeps compact buttons padded after the global reset', () => {
    render(<Button size="sm">保存</Button>)

    const styles = getComputedStyle(screen.getByRole('button', { name: '保存' }))
    expect(styles.paddingInline).toBe('12px')
    expect(styles.height).toBe('32px')
  })
})

describe('IconButton', () => {
  it('uses its label for accessible name and tooltip while keeping dense icon styling', () => {
    render(
      <IconButton label="删除变量 foo" tooltip="删除" tone="danger" pressed disabled>
        <Trash2 size={14} />
      </IconButton>,
    )

    const button = screen.getByRole('button', { name: '删除变量 foo' })
    expect(button.getAttribute('data-tooltip')).toBe('删除')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('data-tone')).toBe('danger')
    expect(button.classList.contains('icon-button')).toBe(true)
    expect((button as HTMLButtonElement).type).toBe('button')
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders the tooltip in a body-level floating layer on hover', () => {
    render(
      <IconButton label="删除变量 foo" tooltip="删除">
        <Trash2 size={14} />
      </IconButton>,
    )

    const button = screen.getByRole('button', { name: '删除变量 foo' })
    fireEvent.mouseEnter(button)

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toBe('删除')
    expect(tooltip.classList.contains('icon-button-floating-tooltip')).toBe(true)
    expect(tooltip.parentElement).toBe(document.body)

    fireEvent.mouseLeave(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
