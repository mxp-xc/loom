import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import styles from './dropdown.module.css'

export interface DropdownOption<T extends string> {
  value: T
  label: ReactNode
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
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const active = options.find((option) => option.value === value)

  const openMenu = () => {
    if (open) return
    onOpen?.()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
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
        setOpen(false)
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
          if (open) setOpen(false)
          else openMenu()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenu()
          focusOption(event.key === 'ArrowDown' ? 0 : options.length - 1)
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
          {loading && (
            <div className={styles.menuStatus} role="status">
              <LoaderCircle className={styles.statusSpinner} size={13} aria-hidden="true" />
              {loadingLabel}
            </div>
          )}
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
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
