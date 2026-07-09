// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DataTable, type DataTableColumn } from '../src/components/ui/data-table'

type DemoRow = {
  key: string
  value: string
  actions: string
}

describe('DataTable', () => {
  it('renders semantic column headers and aligned body cells', () => {
    const columns: DataTableColumn<DemoRow>[] = [
      {
        id: 'key',
        header: 'key',
        cell: (row) => <strong>{row.key}</strong>,
        className: 'demo-key',
      },
      {
        id: 'value',
        header: '当前值',
        cell: (row) => row.value,
        className: 'demo-value',
      },
      {
        id: 'actions',
        header: '操作',
        cell: (row) => <button type="button">{row.actions}</button>,
        className: 'demo-actions',
      },
    ]

    render(
      <DataTable
        ariaLabel="演示表格"
        columns={columns}
        rows={[{ key: 'agent_name', value: 'Codex', actions: '编辑' }]}
        getRowId={(row) => row.key}
      />,
    )

    const table = screen.getByRole('table', { name: '演示表格' })
    expect(table.getAttribute('data-slot')).toBe('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['key', '当前值', '操作'])
    expect(headers[0]?.classList.contains('demo-key')).toBe(true)
    expect(headers[1]?.classList.contains('demo-value')).toBe(true)
    expect(headers[2]?.classList.contains('demo-actions')).toBe(true)

    const row = within(table).getByRole('row', { name: 'agent_name' })
    expect(
      within(row).getByRole('cell', { name: 'agent_name' }).classList.contains('demo-key'),
    ).toBe(true)
    expect(within(row).getByRole('cell', { name: 'Codex' }).classList.contains('demo-value')).toBe(
      true,
    )
    expect(within(row).getByRole('cell', { name: '编辑' }).classList.contains('demo-actions')).toBe(
      true,
    )
  })

  it('renders an empty row across every column', () => {
    const columns: DataTableColumn<DemoRow>[] = [
      { id: 'key', header: 'key', cell: (row) => row.key },
      { id: 'value', header: '当前值', cell: (row) => row.value },
    ]

    render(
      <DataTable
        ariaLabel="空表格"
        columns={columns}
        rows={[]}
        getRowId={(row) => row.key}
        emptyMessage="没有数据"
      />,
    )

    const emptyCell = screen.getByRole('cell', { name: '没有数据' })
    expect(emptyCell.getAttribute('colspan')).toBe('2')
  })

  it('exposes a width resize handle for every column', () => {
    const columns: DataTableColumn<DemoRow>[] = [
      { id: 'key', header: 'key', cell: (row) => row.key, size: 180 },
      { id: 'value', header: '当前值', cell: (row) => row.value, size: 260 },
      { id: 'actions', header: '操作', cell: (row) => row.actions, size: 120 },
    ]

    render(
      <DataTable
        ariaLabel="可调整宽度表格"
        columns={columns}
        rows={[{ key: 'agent_name', value: 'Codex', actions: '编辑' }]}
        getRowId={(row) => row.key}
      />,
    )

    expect(screen.getByRole('separator', { name: '调整 key 列宽' })).toBeDefined()
    expect(screen.getByRole('separator', { name: '调整 当前值 列宽' })).toBeDefined()
    const actionsHandle = screen.getByRole('separator', { name: '调整 操作 列宽' })
    fireEvent.doubleClick(actionsHandle)
    expect(actionsHandle.getAttribute('aria-orientation')).toBe('vertical')
  })

  it('sets a content min width when columns provide explicit sizes', () => {
    const columns: DataTableColumn<DemoRow>[] = [
      { id: 'key', header: 'key', cell: (row) => row.key, size: 180 },
      { id: 'value', header: '当前值', cell: (row) => row.value, size: 260 },
      { id: 'actions', header: '操作', cell: (row) => row.actions, size: 120 },
    ]

    render(
      <DataTable
        ariaLabel="宽度表格"
        columns={columns}
        rows={[{ key: 'agent_name', value: 'Codex', actions: '编辑' }]}
        getRowId={(row) => row.key}
      />,
    )

    expect(screen.getByRole('table', { name: '宽度表格' }).style.minWidth).toBe('560px')
  })

  it('does not hide native scrollbars or let resize handles create fake overflow', () => {
    const css = readFileSync('packages/web/src/components/ui/data-table.css', 'utf8')

    expect(css).not.toMatch(/scrollbar-width:\s*none/)
    expect(css).not.toMatch(/::-webkit-scrollbar/)
    expect(css).not.toMatch(/right:\s*-/)
  })
})
