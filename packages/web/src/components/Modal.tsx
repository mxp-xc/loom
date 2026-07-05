import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  minHeight?: number
  busy?: boolean
  children: ReactNode
}

export default function Modal({
  open,
  onClose,
  title,
  width = 480,
  minHeight = 0,
  busy = false,
  children,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  const openerRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    if (!open) return
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onCloseRef.current()
      if (e.key === 'Tab' && ref.current) {
        const focusable = ref.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) {
          e.preventDefault()
          ref.current.focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement
        if (
          e.shiftKey &&
          (active === first || active === ref.current || !ref.current.contains(active))
        ) {
          e.preventDefault()
          last.focus()
        } else if (
          !e.shiftKey &&
          (active === last || active === ref.current || !ref.current.contains(active))
        ) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handler)
    const focusTimer = window.setTimeout(() => {
      const modal = ref.current
      if (!modal) return
      const preferred =
        modal.querySelector<HTMLElement>(
          '[data-autofocus]:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
        ) ??
        modal.querySelector<HTMLElement>(
          'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        )
      ;(preferred ?? modal).focus()
    }, 0)
    return () => {
      window.removeEventListener('keydown', handler)
      window.clearTimeout(focusTimer)
      const opener = openerRef.current
      if (opener?.isConnected) opener.focus()
      openerRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) onCloseRef.current()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        style={{
          width: `min(${width}px, calc(100vw - 32px))`,
          minHeight: minHeight || undefined,
          maxHeight: '92vh',
          overflow: 'auto',
          background: 'var(--popover)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-popover)',
          outline: 'none',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg)',
          }}
        >
          <span
            id={titleId}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--bright)',
            }}
          >
            {title}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => onCloseRef.current()}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div style={{ padding: '18px 20px' }}>{children}</div>
      </div>
    </div>
  )
}
