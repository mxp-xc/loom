import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { IconButton } from '@/components/ui/IconButton'
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
  const contentRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  const openerRef = useRef<HTMLElement | null>(null)
  const focusTimerRef = useRef<number | null>(null)
  const closeGuardTimerRef = useRef<number | null>(null)
  const closeRequestedRef = useRef(false)
  const wasOpenRef = useRef(false)

  if (open && !wasOpenRef.current && openerRef.current === null) {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    wasOpenRef.current = open
    if (open) closeRequestedRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current)
      }
      if (closeGuardTimerRef.current !== null) {
        window.clearTimeout(closeGuardTimerRef.current)
      }
    }
  }, [])

  const focusPreferredElement = useCallback(() => {
    const modal = contentRef.current
    if (!modal) return
    const preferred =
      modal.querySelector<HTMLElement>(
        '[data-autofocus]:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ??
      modal.querySelector<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )
    ;(preferred ?? modal).focus()
  }, [])

  const restoreOpenerFocus = useCallback((clear = true) => {
    const opener = openerRef.current
    if (opener?.isConnected) opener.focus()
    if (clear) openerRef.current = null
  }, [])

  const requestClose = useCallback(() => {
    if (busyRef.current || closeRequestedRef.current) return
    closeRequestedRef.current = true
    flushSync(() => {
      onCloseRef.current()
    })
    restoreOpenerFocus(false)
    if (closeGuardTimerRef.current !== null) {
      window.clearTimeout(closeGuardTimerRef.current)
    }
    closeGuardTimerRef.current = window.setTimeout(() => {
      closeGuardTimerRef.current = null
      closeRequestedRef.current = false
    }, 0)
  }, [restoreOpenerFocus])

  useEffect(() => {
    if (!open) return

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) {
          event.preventDefault()
          return
        }
        requestClose()
        return
      }

      if (event.key !== 'Tab') return
      const modal = contentRef.current
      if (!modal) return
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) {
        event.preventDefault()
        modal.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === modal || !modal.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (active === last || active === modal || !modal.contains(active))
      ) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [open, requestClose])

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
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
          onClick={(event) => {
            if (event.target === event.currentTarget) requestClose()
          }}
        >
          <DialogPrimitive.Content
            ref={contentRef}
            aria-modal="true"
            aria-busy={busy}
            onClick={(event) => event.stopPropagation()}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              if (focusTimerRef.current !== null) {
                window.clearTimeout(focusTimerRef.current)
              }
              focusTimerRef.current = window.setTimeout(() => {
                focusTimerRef.current = null
                focusPreferredElement()
              }, 0)
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (focusTimerRef.current !== null) {
                window.clearTimeout(focusTimerRef.current)
                focusTimerRef.current = null
              }
              restoreOpenerFocus()
            }}
            onEscapeKeyDown={(event) => {
              if (busyRef.current) event.preventDefault()
            }}
            onPointerDownOutside={(event) => {
              if (busyRef.current) event.preventDefault()
            }}
            onInteractOutside={(event) => {
              if (busyRef.current) event.preventDefault()
            }}
            style={{
              width: 'min(' + width + 'px, calc(100vw - 32px))',
              minHeight: minHeight || undefined,
              maxHeight: '92vh',
              overflow: 'auto',
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-popover)',
              outline: 'none',
            }}
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
              <DialogPrimitive.Title asChild>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--bright)',
                  }}
                >
                  {title}
                </span>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <IconButton label="关闭" tooltip="关闭" disabled={busy}>
                  <X className="h-4 w-4" />
                </IconButton>
              </DialogPrimitive.Close>
            </div>
            <div style={{ padding: '18px 20px' }}>{children}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
