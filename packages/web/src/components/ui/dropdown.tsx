import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import styles from './dropdown.module.css'

export interface DropdownOption<T extends string> {
  value: T
  label: ReactNode
  /** Plain text used by the search filter when the label is not a string. */
  searchText?: string
}

interface DropdownProps<T extends string> {
  ariaLabel: string
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  onOpen?: () => void
  disabled?: boolean
  loading?: boolean
  loadingLabel?: ReactNode
  placeholder?: string
  /** Render a text filter at the top of the menu; matching is fuzzy and case-insensitive. */
  searchable?: boolean
  searchPlaceholder?: string
}

function optionText<T extends string>(option: DropdownOption<T>): string {
  if (option.searchText !== undefined) return option.searchText
  return typeof option.label === 'string' ? option.label : option.value
}

function fuzzyMatches(query: string, label: string): boolean {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true
  if (label.toLowerCase().includes(trimmed)) return true
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const compactQuery = compact(trimmed)
  return compactQuery !== '' && compact(label).includes(compactQuery)
}

export function Dropdown<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  onOpen,
  disabled = false,
  loading = false,
  loadingLabel = 'Loading…',
  placeholder = '—',
  searchable = false,
  searchPlaceholder = '搜索…',
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const active = options.find((option) => option.value === value)
  const filteredOptions = query.trim()
    ? options.filter((option) => fuzzyMatches(query, optionText(option)))
    : options

  const closeMenu = () => {
    setOpen(false)
    setQuery('')
  }

  const openMenu = () => {
    if (open) return
    onOpen?.()
    setQuery('')
    setOpen(true)
  }

  useEffect(() => {
    if (!open || !searchable) return
    searchRef.current?.focus()
  }, [open, searchable])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
    }
  }, [open])

  const focusOption = (offset: number) => {
    requestAnimationFrame(() => {
      const items = Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
      )
      const selected = items.findIndex((item) => item.getAttribute('aria-selected') === 'true')
      items[Math.max(0, selected + offset)]?.focus()
    })
  }

  return (
    <div
      className={styles.root}
      ref={rootRef}
      data-dropdown-open={open}
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        triggerRef.current?.focus()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu()
          else openMenu()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenu()
          if (!searchable) focusOption(event.key === 'ArrowDown' ? 0 : options.length - 1)
        }}
      >
        <span>{active?.label ?? placeholder}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          className={styles.menu}
          role="listbox"
          aria-label={ariaLabel}
          aria-busy={loading || undefined}
        >
          {searchable && (
            <input
              ref={searchRef}
              type="search"
              role="searchbox"
              className={styles.search}
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') return
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                focusOption(event.key === 'ArrowDown' ? 0 : filteredOptions.length - 1)
              }}
            />
          )}
          {loading && (
            <div className={styles.menuStatus} role="status">
              <LoaderCircle className={styles.statusSpinner} size={13} aria-hidden="true" />
              {loadingLabel}
            </div>
          )}
          {filteredOptions.length === 0 && !loading && (
            <div className={styles.menuEmpty}>无匹配项</div>
          )}
          {filteredOptions.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                closeMenu()
                triggerRef.current?.focus()
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                const items = Array.from(
                  rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
                )
                items[
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                ]?.focus()
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
