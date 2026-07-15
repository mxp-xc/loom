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

  it('uses a native child button as the keyboard activator', async () => {
    const onReorder = vi.fn()
    render(
      <SortableList
        items={items}
        activator="child"
        label={(item) => item.label}
        onReorder={onReorder}
      >
        {(item, { activatorProps }) => (
          <div>
            <button type="button" {...activatorProps}>
              Move {item.label}
            </button>
            <span>{item.label}</span>
          </div>
        )}
      </SortableList>,
    )

    const handles = ['Alpha', 'Beta', 'Gamma'].map((label, index) => {
      const handle = screen.getByRole('button', { name: `调整 ${label} 顺序` })
      handle.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: index * 40, width: 32, height: 32 })
      const row = handle.parentElement?.parentElement
      if (row) {
        row.getBoundingClientRect = () =>
          DOMRect.fromRect({ x: 0, y: index * 40, width: 200, height: 32 })
      }
      return handle
    })

    handles[0].focus()
    fireEvent.keyDown(handles[0], { key: ' ', code: 'Space' })
    await waitFor(() => expect(handles[0].getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(document, { key: ' ', code: 'Space' })

    await waitFor(() =>
      expect(onReorder).toHaveBeenCalledWith([
        { id: 'b', label: 'Beta' },
        { id: 'a', label: 'Alpha' },
        { id: 'c', label: 'Gamma' },
      ]),
    )
  })

  it('starts mouse dragging from a native child button', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    )
    render(
      <SortableList
        items={items}
        activator="child"
        label={(item) => item.label}
        onReorder={vi.fn()}
      >
        {(item, { activatorProps }) => (
          <button type="button" {...activatorProps}>
            Move {item.label}
          </button>
        )}
      </SortableList>,
    )

    const handle = screen.getByRole('button', { name: '调整 Alpha 顺序' })
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 10, clientY: 20 })

    await waitFor(() => expect(handle.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.mouseUp(document)
    await waitFor(() => expect(handle.getAttribute('aria-pressed')).not.toBe('true'))
    vi.unstubAllGlobals()
  })

  it('does not start item dragging from an interactive descendant', () => {
    const onReorder = vi.fn()
    render(
      <SortableList items={items} label={(item) => item.label} onReorder={onReorder}>
        {(item) => <button type="button">Edit {item.label}</button>}
      </SortableList>,
    )

    const editButton = screen.getByRole('button', { name: 'Edit Alpha' })
    fireEvent.mouseDown(editButton, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 10, clientY: 20 })
    fireEvent.mouseUp(document)

    expect(screen.getByLabelText('调整 Alpha 顺序').getAttribute('aria-pressed')).not.toBe('true')
    expect(onReorder).not.toHaveBeenCalled()
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
