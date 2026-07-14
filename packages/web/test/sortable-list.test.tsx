// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SortableList } from '../src/components/ui/sortable-list'

const items = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
]

describe('SortableList', () => {
  it('moves the first item to the end with the keyboard sensor', async () => {
    const onReorder = vi.fn()
    render(
      <SortableList items={items} label={(item) => item.label} onReorder={onReorder}>
        {(item) => <div>{item.label}</div>}
      </SortableList>,
    )

    const sortableItems = ['Alpha', 'Beta', 'Gamma'].map((label, index) => {
      const element = screen.getByLabelText(`调整 ${label} 顺序`)
      element.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 40, width: 200, height: 32 })
      return element
    })
    const first = sortableItems[0]
    first.focus()
    fireEvent.keyDown(first, { key: ' ', code: 'Space' })
    await waitFor(() => expect(first.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('b'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('c'))
    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    await waitFor(() =>
      expect(onReorder).toHaveBeenCalledWith([
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
        { id: 'a', label: 'Alpha' },
      ]),
    )
  })

  it('disables sorting for a single item', () => {
    const { container } = render(
      <SortableList items={items.slice(0, 1)} label={(item) => item.label} onReorder={vi.fn()}>
        {(item) => <div>{item.label}</div>}
      </SortableList>,
    )

    expect(container.querySelector('[data-disabled="true"]')).not.toBeNull()
    const item = screen.getByLabelText('调整 Alpha 顺序')
    expect(item.getAttribute('aria-disabled')).toBe('true')
  })
})
