import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SelectableListItem {
  id: string
  label: React.ReactNode
  searchText: string
  meta?: React.ReactNode
  disabled?: boolean
  disabledReason?: string
}

export function selectableItemMatchesQuery(
  item: Pick<SelectableListItem, 'searchText'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return item.searchText.toLowerCase().includes(needle)
}

export function nextSelectableSelection(
  items: SelectableListItem[],
  current: ReadonlySet<string>,
  mode: 'all' | 'none',
): Set<string> {
  const next = new Set(current)
  for (const item of items) {
    if (item.disabled) continue
    if (mode === 'all') next.add(item.id)
    else next.delete(item.id)
  }
  return next
}

export interface SelectableListProps {
  ariaLabel: string
  items: SelectableListItem[]
  selectedIds: ReadonlySet<string>
  onSelectedIdsChange: (next: Set<string>) => void
  searchPlaceholder?: string
  showSearch?: boolean
  showSelectionActions?: boolean
  emptyMessage?: string
  noMatchesMessage?: string
  className?: string
}

export function SelectableList({
  ariaLabel,
  items,
  selectedIds,
  onSelectedIdsChange,
  searchPlaceholder = '搜索…',
  showSearch = true,
  showSelectionActions = false,
  emptyMessage = '没有数据',
  noMatchesMessage = '无匹配',
  className,
}: SelectableListProps) {
  const [query, setQuery] = React.useState('')
  const visibleItems = React.useMemo(
    () => items.filter((item) => selectableItemMatchesQuery(item, query)),
    [items, query],
  )
  const enabledCount = items.filter((item) => !item.disabled).length
  const selectedEnabledCount = items.filter(
    (item) => !item.disabled && selectedIds.has(item.id),
  ).length
  const allEnabledSelected = enabledCount > 0 && selectedEnabledCount === enabledCount
  const selectionButtonLabel = allEnabledSelected ? '全不选' : '全选'

  const toggleItem = (item: SelectableListItem, checked: boolean) => {
    if (item.disabled) return
    const next = new Set(selectedIds)
    if (checked) next.add(item.id)
    else next.delete(item.id)
    onSelectedIdsChange(next)
  }

  const toggleAll = () => {
    onSelectedIdsChange(
      nextSelectableSelection(items, selectedIds, allEnabledSelected ? 'none' : 'all'),
    )
  }

  return (
    <section className={cn('selectable-list', className)} aria-label={ariaLabel}>
      {showSearch && (
        <label className="selectable-list-search">
          <span className="sr-only">{searchPlaceholder}</span>
          <input
            type="search"
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {showSelectionActions && items.length > 0 && (
        <div className="selectable-list-actions">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={toggleAll}
            disabled={enabledCount === 0}
          >
            {selectionButtonLabel}
          </Button>
          <span>
            已选 {selectedEnabledCount} / {enabledCount}
          </span>
        </div>
      )}
      <div className="selectable-list-rows" role="list" aria-label={ariaLabel}>
        {items.length === 0 ? (
          <div className="selectable-list-empty">{emptyMessage}</div>
        ) : visibleItems.length === 0 ? (
          <div className="selectable-list-empty">{noMatchesMessage}</div>
        ) : (
          visibleItems.map((item) => (
            <label
              key={item.id}
              role="listitem"
              className={cn('selectable-list-row', item.disabled && 'is-disabled')}
              title={item.disabledReason}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(item.id)}
                disabled={item.disabled}
                aria-label={typeof item.label === 'string' ? item.label : undefined}
                onChange={(event) => toggleItem(item, event.target.checked)}
              />
              <span className="selectable-list-label">{item.label}</span>
              {item.meta && <span className="selectable-list-meta">{item.meta}</span>}
            </label>
          ))
        )}
      </div>
    </section>
  )
}
