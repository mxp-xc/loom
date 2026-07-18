import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Copy, LoaderCircle } from 'lucide-react'
import finderIcon from '@/assets/apps/finder.png'
import vscodeIcon from '@/assets/apps/vscode.svg'
import windowsExplorerIcon from '@/assets/apps/windows-explorer.svg'
import zedIcon from '@/assets/apps/zed.png'
import { api, type ExternalApplication } from '@/lib/api'
import styles from './OpenWith.module.css'

interface OpenWithProps {
  repo: string
  path: string
  disabled?: boolean
  onOpened?: (application: ExternalApplication) => void
  onError?: (error: unknown, application: ExternalApplication) => void
  onPathCopied?: (absolutePath: string) => void
  onPathCopyError?: (error: unknown) => void
}

interface ApplicationOption {
  value: ExternalApplication
  label: string
  icon: string
}

function systemApplication(): Pick<ApplicationOption, 'label' | 'icon'> {
  if (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)) {
    return { label: 'Explorer', icon: windowsExplorerIcon }
  }
  return { label: 'Finder', icon: finderIcon }
}

export function OpenWith({
  repo,
  path,
  disabled = false,
  onOpened,
  onError,
  onPathCopied,
  onPathCopyError,
}: OpenWithProps) {
  const [application, setApplication] = useState<ExternalApplication | null>(null)
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState<ExternalApplication | null>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const applicationChangedRef = useRef(false)

  const system = systemApplication()
  const options: ApplicationOption[] = [
    {
      value: 'vscode',
      label: 'VS Code',
      icon: vscodeIcon,
    },
    {
      value: 'zed',
      label: 'Zed',
      icon: zedIcon,
    },
    {
      value: 'system',
      ...system,
    },
  ]
  const selected = application
    ? (options.find((option) => option.value === application) ?? options[0])
    : undefined

  useEffect(() => {
    let active = true
    void api
      .getOpenPathPreference()
      .then(({ application: savedApplication }) => {
        if (active && !applicationChangedRef.current) setApplication(savedApplication)
      })
      .catch((error) => {
        console.error({ err: error }, 'Failed to load open path preference')
        if (active && !applicationChangedRef.current) setApplication('vscode')
      })
    return () => {
      active = false
    }
  }, [])

  const positionMenu = useCallback(() => {
    const trigger = rootRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return

    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const margin = 8
    const gap = 6
    const left = Math.min(
      Math.max(margin, triggerRect.right - menuRect.width),
      Math.max(margin, window.innerWidth - menuRect.width - margin),
    )
    const below = triggerRect.bottom + gap
    const top =
      below + menuRect.height <= window.innerHeight - margin
        ? below
        : Math.max(margin, triggerRect.top - menuRect.height - gap)
    setMenuStyle({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    positionMenu()
    const reposition = () => positionMenu()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, positionMenu])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      menuTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeWithEscape)
    }
  }, [open])

  const openTarget = async (nextApplication: ExternalApplication) => {
    setOpening(nextApplication)
    try {
      await api.openPath({ repo, path, application: nextApplication })
      onOpened?.(nextApplication)
    } catch (error) {
      console.error({ err: error, application: nextApplication, path }, 'Failed to open path')
      onError?.(error, nextApplication)
    } finally {
      setOpening(null)
    }
  }

  const copyTargetPath = async () => {
    try {
      const result = await api.resolvePath({ repo, path })
      if (!navigator.clipboard) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(result.path)
      onPathCopied?.(result.path)
    } catch (error) {
      console.error({ err: error, repo, path }, 'Failed to copy path')
      onPathCopyError?.(error)
    }
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    )
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const offset = event.key === 'ArrowDown' ? 1 : -1
    items[(currentIndex + offset + items.length) % items.length]?.focus()
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.primary}
        aria-label={selected ? `使用 ${selected.label} 打开` : '正在加载打开方式'}
        disabled={disabled || opening !== null || selected === undefined}
        onClick={() => {
          if (application) void openTarget(application)
        }}
      >
        <span className={styles.appIcon}>
          {opening === application ? (
            <LoaderCircle className={styles.spinner} />
          ) : selected ? (
            <img src={selected.icon} alt="" draggable={false} />
          ) : null}
        </span>
      </button>
      <button
        ref={menuTriggerRef}
        type="button"
        className={styles.trigger}
        aria-label="选择打开方式"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || opening !== null || selected === undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
          requestAnimationFrame(() => {
            const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
            items?.[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus()
          })
        }}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            role="menu"
            aria-label="使用其他应用打开"
            style={menuStyle}
            onKeyDown={handleMenuKeyDown}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                disabled={opening !== null}
                onClick={() => {
                  applicationChangedRef.current = true
                  setApplication(option.value)
                  setOpen(false)
                  menuTriggerRef.current?.focus()
                  void api.setOpenPathPreference(option.value).catch((error) => {
                    console.error(
                      { err: error, application: option.value },
                      'Failed to save open path preference',
                    )
                  })
                  void openTarget(option.value)
                }}
              >
                <span className={styles.appIcon}>
                  {opening === option.value ? (
                    <LoaderCircle className={styles.spinner} />
                  ) : (
                    <img src={option.icon} alt="" draggable={false} />
                  )}
                </span>
                <span>{option.label}</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                menuTriggerRef.current?.focus()
                void copyTargetPath()
              }}
            >
              <span className={styles.appIcon}>
                <Copy aria-hidden="true" />
              </span>
              <span>复制路径</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
