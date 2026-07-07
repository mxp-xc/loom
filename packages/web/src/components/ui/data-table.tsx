import * as React from 'react'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
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
  const columnDefs = React.useMemo<Array<ColumnDef<TData>>>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: () => column.header,
        cell: ({ row }) => column.cell(row.original),
        meta: column,
      })),
    [columns],
  )

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
  })

  return (
    <section className={cn('data-table-shell', className)} aria-label={ariaLabel}>
      <Table className={cn('data-table', tableClassName)} aria-label={ariaLabel}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta as DataTableColumn<TData> | undefined
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    className={cn(meta?.className, meta?.headerClassName)}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
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
                  return (
                    <TableCell key={cell.id} className={cn(meta?.className, meta?.cellClassName)}>
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
