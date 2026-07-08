// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SelectableList,
  nextSelectableSelection,
  selectableItemMatchesQuery,
  type SelectableListItem,
} from '../src/components/ui/selectable-list'

const items: SelectableListItem[] = [
  { id: 'alpha', label: 'alpha', searchText: 'alpha first' },
  { id: 'beta', label: 'beta', searchText: 'beta second' },
  {
    id: 'installed',
    label: 'installed',
    searchText: 'installed third',
    disabled: true,
    meta: '已安装',
  },
]

describe('SelectableList helpers', () => {
  it('matches search text case-insensitively after trimming', () => {
    expect(selectableItemMatchesQuery(items[0], '  FIRST  ')).toBe(true)
    expect(selectableItemMatchesQuery(items[0], 'missing')).toBe(false)
  })

  it('selects and clears only enabled list items while preserving external selected ids', () => {
    const current = new Set(['external', 'installed'])
    expect([...nextSelectableSelection(items, current, 'all')].sort()).toEqual([
      'alpha',
      'beta',
      'external',
      'installed',
    ])
    expect([...nextSelectableSelection(items, current, 'none')].sort()).toEqual([
      'external',
      'installed',
    ])
  })
})

describe('SelectableList', () => {
  it('filters rows and shows no-match empty state without dropping hidden selection', () => {
    const onChange = vi.fn()
    render(
      <SelectableList
        ariaLabel="skills"
        items={items}
        selectedIds={new Set(['beta'])}
        onSelectedIdsChange={onChange}
        searchPlaceholder="搜索 skill…"
        emptyMessage="没有成员"
        noMatchesMessage="无匹配"
      />,
    )

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'alpha' },
    })

    const list = screen.getByRole('list', { name: 'skills' })
    expect(within(list).getByText('alpha')).toBeDefined()
    expect(within(list).queryByText('beta')).toBeNull()

    fireEvent.click(within(list).getByRole('checkbox', { name: 'alpha' }))
    expect(onChange).toHaveBeenCalledWith(new Set(['alpha', 'beta']))

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('无匹配')).toBeDefined()
  })

  it('renders selection actions that select and clear enabled rows only', () => {
    const onChange = vi.fn()
    render(
      <SelectableList
        ariaLabel="members"
        items={items}
        selectedIds={new Set(['external'])}
        onSelectedIdsChange={onChange}
        showSearch={false}
        showSelectionActions
        emptyMessage="没有成员"
      />,
    )

    expect(screen.getByText('已选 0 / 2')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(onChange).toHaveBeenCalledWith(new Set(['external', 'alpha', 'beta']))
  })

  it('selects and clears hidden enabled rows after filtering', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <SelectableList
        ariaLabel="filtered members"
        items={items}
        selectedIds={new Set(['external'])}
        onSelectedIdsChange={onChange}
        showSelectionActions
      />,
    )

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索…' }), {
      target: { value: 'alpha' },
    })

    const list = screen.getByRole('list', { name: 'filtered members' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).queryByText('beta')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(onChange).toHaveBeenLastCalledWith(new Set(['external', 'alpha', 'beta']))

    rerender(
      <SelectableList
        ariaLabel="filtered members"
        items={items}
        selectedIds={new Set(['external', 'alpha', 'beta'])}
        onSelectedIdsChange={onChange}
        showSelectionActions
      />,
    )

    expect(within(list).queryByText('beta')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '全不选' }))
    expect(onChange).toHaveBeenLastCalledWith(new Set(['external']))
  })

  it('marks disabled rows and does not toggle them', () => {
    const onChange = vi.fn()
    render(
      <SelectableList
        ariaLabel="disabled demo"
        items={items}
        selectedIds={new Set()}
        onSelectedIdsChange={onChange}
      />,
    )

    const installed = screen.getByRole('checkbox', { name: 'installed' })
    expect((installed as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('已安装')).toBeDefined()
    fireEvent.click(installed)
    expect(onChange).not.toHaveBeenCalled()
  })
})
