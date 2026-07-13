import { useMemo, useState } from 'react'
import { GitFork, Search } from 'lucide-react'
import styles from './SkillSelectionList.module.css'

export interface SkillSelectionItem {
  id: string
  description?: string
  path?: string
  installed?: boolean
}

interface Props {
  ariaLabel: string
  items: SkillSelectionItem[]
  selectedIds: ReadonlySet<string>
  onSelectedIdsChange: (next: Set<string>) => void
  repositoryLabel: string
  mode?: 'add' | 'edit'
  baselineIds?: ReadonlySet<string>
  emptyMessage?: string
  className?: string
}

export default function SkillSelectionList({
  ariaLabel,
  items,
  selectedIds,
  onSelectedIdsChange,
  repositoryLabel,
  mode = 'add',
  baselineIds = new Set<string>(),
  emptyMessage = 'No skills found',
  className = '',
}: Props) {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      `${item.id} ${item.description ?? ''} ${item.path ?? ''}`.toLowerCase().includes(needle),
    )
  }, [items, query])
  const selectable = items.filter((item) => !(mode === 'add' && item.installed))
  const allSelected = selectable.length > 0 && selectable.every((item) => selectedIds.has(item.id))

  const toggleAll = () => {
    const next = new Set(selectedIds)
    for (const item of selectable) {
      if (allSelected) next.delete(item.id)
      else next.add(item.id)
    }
    onSelectedIdsChange(next)
  }

  const toggle = (item: SkillSelectionItem, checked: boolean) => {
    if (mode === 'add' && item.installed) return
    const next = new Set(selectedIds)
    if (checked) next.add(item.id)
    else next.delete(item.id)
    onSelectedIdsChange(next)
  }

  return (
    <div className={`${styles.stack} ${className}`}>
      <div className={styles.summary}>
        <div>
          <span>{mode === 'edit' ? 'Source members' : 'Discovered skills'}</span>
          <strong data-testid="skill-selection-summary">
            {items.length} found <i>·</i> {selectedIds.size} selected
          </strong>
        </div>
        {items.length > 0 && (
          <button type="button" aria-label={allSelected ? '全不选' : '全选'} onClick={toggleAll}>
            {allSelected ? 'Clear all' : mode === 'edit' ? 'Select all' : 'Select available'}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>{emptyMessage}</div>
      ) : (
        <>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">搜索 skill…</span>
            <input
              type="search"
              aria-label="搜索 skill…"
              placeholder="Search skills…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className={styles.repository}>
            <GitFork size={14} aria-hidden="true" />
            <code>{repositoryLabel}</code>
            <span>{visible.length}</span>
          </div>
          <div className={styles.list} role="list" aria-label={ariaLabel}>
            {visible.length === 0 ? (
              <div className={styles.noMatches}>No matching skills</div>
            ) : (
              visible.map((item) => {
                const active = selectedIds.has(item.id)
                const wasActive = baselineIds.has(item.id)
                const change =
                  mode === 'edit' && wasActive !== active ? (active ? 'added' : 'removed') : null
                const status =
                  change ?? (wasActive ? 'configured' : item.installed ? 'installed' : 'new')
                const disabled = mode === 'add' && item.installed
                return (
                  <label
                    key={item.id}
                    className={styles.row}
                    data-active={active}
                    data-testid={`skill-result-${item.id}`}
                    aria-disabled={disabled}
                    role="listitem"
                  >
                    <span className={styles.branch} aria-hidden="true" />
                    <input
                      type="checkbox"
                      aria-label={item.id}
                      checked={active}
                      disabled={disabled}
                      onChange={(event) => toggle(item, event.target.checked)}
                    />
                    <span className={styles.copy}>
                      <strong>{item.id}</strong>
                      {item.description && <small>{item.description}</small>}
                      {item.path && <code>{item.path}</code>}
                    </span>
                    <span className={styles.status} data-status={status}>
                      {status}
                    </span>
                  </label>
                )
              })
            )}
          </div>
        </>
      )}
    </div>
  )
}
