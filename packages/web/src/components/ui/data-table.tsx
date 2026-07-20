import * as React from 'react'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import './data-table.css'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export type DataTableColumn<TData> = {
  id: string
  header: React.ReactNode
  cell: (row: TData) => React.ReactNode
  className?: string
  headerClassName?: string
  cellClassName?: string
  size?: number
  minSize?: number
  maxSize?: number
}

type DataTableProps<TData> = {
  ariaLabel: string
  columns: DataTableColumn<TData>[]
  rows: TData[]
  getRowId: (row: TData, index: number) => string
  className?: string
  tableClassName?: string
  rowClassName?: (row: TData) => string | undefined
  emptyMessage?: string
  emptyClassName?: string
}

export function DataTable<TData>({
  ariaLabel,
  columns,
  rows,
  getRowId,
  className,
  tableClassName,
  rowClassName,
  emptyMessage = '没有数据。',
  emptyClassName,
}: DataTableProps<TData>) {
  const [columnSizing, setColumnSizing] = React.useState<Record<string, number>>({})
  const columnDefs = React.useMemo<Array<ColumnDef<TData>>>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: () => column.header,
        cell: ({ row }) => column.cell(row.original),
        size: column.size,
        minSize: column.minSize ?? 72,
        maxSize: column.maxSize,
        meta: column,
      })),
    [columns],
  )

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    columnResizeMode: 'onChange',
    enableColumnResizing: true,
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
  })
  const hasMeasuredWidth = columns.some(
    (column) => column.size !== undefined || columnSizing[column.id] !== undefined,
  )
  const tableMinWidth = hasMeasuredWidth ? table.getCenterTotalSize() : undefined

  return (
    <section className={cn('data-table-shell', className)} aria-label={ariaLabel}>
      <Table
        className={cn('data-table', tableClassName)}
        aria-label={ariaLabel}
        style={tableMinWidth === undefined ? undefined : { minWidth: tableMinWidth }}
      >
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta as DataTableColumn<TData> | undefined
                const headerLabel =
                  typeof meta?.header === 'string' ? meta.header : (meta?.id ?? header.id)
                const width =
                  meta && (meta.size !== undefined || columnSizing[meta.id] !== undefined)
                    ? header.getSize()
                    : undefined
                const minSize = meta?.minSize ?? 72
                const maxSize = meta?.maxSize ?? Number.MAX_SAFE_INTEGER
                const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLSpanElement>) => {
                  let nextSize: number | undefined
                  if (event.key === 'ArrowLeft') nextSize = header.getSize() - 12
                  if (event.key === 'ArrowRight') nextSize = header.getSize() + 12
                  if (event.key === 'Home') nextSize = minSize
                  if (event.key === 'End' && meta?.maxSize !== undefined) nextSize = maxSize
                  if (nextSize === undefined) return
                  event.preventDefault()
                  setColumnSizing((current) => ({
                    ...current,
                    [header.column.id]: Math.min(maxSize, Math.max(minSize, nextSize)),
                  }))
                }
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    className={cn(meta?.className, meta?.headerClassName)}
                    style={width === undefined ? undefined : { width }}
                  >
                    <span className="data-table-head-content">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
                    {header.column.getCanResize() && (
                      <span
                        role="separator"
                        aria-label={'调整 ' + headerLabel + ' 列宽'}
                        aria-orientation="vertical"
                        aria-valuemin={minSize}
                        aria-valuemax={meta?.maxSize}
                        aria-valuenow={header.getSize()}
                        tabIndex={0}
                        className={cn(
                          'data-table-resizer',
                          header.column.getIsResizing() && 'is-resizing',
                        )}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => header.column.resetSize()}
                        onKeyDown={resizeWithKeyboard}
                      />
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                className={cn('data-table-empty', emptyClassName)}
                colSpan={table.getAllLeafColumns().length}
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className={rowClassName?.(row.original)} aria-label={row.id}>
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as DataTableColumn<TData> | undefined
                  const width =
                    meta && (meta.size !== undefined || columnSizing[meta.id] !== undefined)
                      ? cell.column.getSize()
                      : undefined
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(meta?.className, meta?.cellClassName)}
                      style={width === undefined ? undefined : { width }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
