import * as React from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type IconButtonTone = 'default' | 'danger' | 'warning' | 'success'

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'children'> {
  label: string
  tooltip?: string
  tone?: IconButtonTone
  pressed?: boolean
  children: React.ReactNode
}

const iconButtonSizes = {
  default: 32,
  sm: 32,
  xs: 28,
  lg: 32,
} satisfies Record<NonNullable<ButtonProps['size']>, number>

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      tooltip,
      tone = 'default',
      pressed,
      variant,
      size,
      type,
      className,
      style,
      children,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref,
  ) => {
    const resolvedSize = size ?? 'xs'
    const squareSize = iconButtonSizes[resolvedSize]
    const tooltipText = tooltip ?? label
    const buttonRef = React.useRef<HTMLButtonElement | null>(null)
    const floatingTooltipRef = React.useRef<HTMLSpanElement | null>(null)
    const cleanupViewportListenersRef = React.useRef<(() => void) | null>(null)
    const tooltipId = React.useId()

    const setRefs = React.useCallback(
      (node: HTMLButtonElement | null) => {
        buttonRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          ref.current = node
        }
      },
      [ref],
    )

    const restoreDescribedBy = React.useCallback(() => {
      if (!buttonRef.current) return
      if (ariaDescribedBy) {
        buttonRef.current.setAttribute('aria-describedby', ariaDescribedBy)
      } else {
        buttonRef.current.removeAttribute('aria-describedby')
      }
    }, [ariaDescribedBy])

    const cleanupViewportListeners = React.useCallback(() => {
      cleanupViewportListenersRef.current?.()
      cleanupViewportListenersRef.current = null
    }, [])

    const positionFloatingTooltip = React.useCallback(() => {
      if (typeof window === 'undefined') return

      const button = buttonRef.current
      const tooltipNode = floatingTooltipRef.current
      if (!button || !tooltipNode) return

      const buttonRect = button.getBoundingClientRect()
      const margin = 8
      const rawLeft = buttonRect.left + buttonRect.width / 2
      const rawTop = buttonRect.top - 7

      tooltipNode.style.left = rawLeft + 'px'
      tooltipNode.style.top = rawTop + 'px'

      const tooltipRect = tooltipNode.getBoundingClientRect()
      const halfWidth = tooltipRect.width / 2
      const minLeft = margin + halfWidth
      const maxLeft = window.innerWidth - margin - halfWidth
      const nextLeft =
        maxLeft > minLeft ? Math.min(Math.max(rawLeft, minLeft), maxLeft) : window.innerWidth / 2
      const nextTop = Math.max(margin + tooltipRect.height, rawTop)

      tooltipNode.style.left = nextLeft + 'px'
      tooltipNode.style.top = nextTop + 'px'
    }, [])

    const showTooltip = React.useCallback(() => {
      if (typeof document === 'undefined' || typeof window === 'undefined') return

      let tooltipNode = floatingTooltipRef.current
      if (!tooltipNode) {
        tooltipNode = document.createElement('span')
        floatingTooltipRef.current = tooltipNode
      }

      tooltipNode.id = tooltipId
      tooltipNode.setAttribute('role', 'tooltip')
      tooltipNode.className = 'icon-button-floating-tooltip'
      tooltipNode.textContent = tooltipText

      if (!tooltipNode.isConnected) {
        document.body.appendChild(tooltipNode)
      }

      const describedBy = [ariaDescribedBy, tooltipId].filter(Boolean).join(' ')
      buttonRef.current?.setAttribute('aria-describedby', describedBy)
      positionFloatingTooltip()

      cleanupViewportListeners()
      const handleViewportChange = () => positionFloatingTooltip()
      window.addEventListener('resize', handleViewportChange)
      window.addEventListener('scroll', handleViewportChange, true)
      cleanupViewportListenersRef.current = () => {
        window.removeEventListener('resize', handleViewportChange)
        window.removeEventListener('scroll', handleViewportChange, true)
      }
    }, [ariaDescribedBy, cleanupViewportListeners, positionFloatingTooltip, tooltipId, tooltipText])

    const hideTooltip = React.useCallback(() => {
      cleanupViewportListeners()
      floatingTooltipRef.current?.remove()
      restoreDescribedBy()
    }, [cleanupViewportListeners, restoreDescribedBy])

    const shouldShowFocusTooltip = React.useCallback(() => {
      try {
        return buttonRef.current?.matches(':focus-visible') ?? true
      } catch {
        return true
      }
    }, [])

    React.useEffect(() => {
      return () => {
        cleanupViewportListeners()
        floatingTooltipRef.current?.remove()
      }
    }, [cleanupViewportListeners])

    return (
      <Button
        {...props}
        ref={setRefs}
        variant={variant ?? 'ghost'}
        size={resolvedSize}
        type={type ?? 'button'}
        aria-label={label}
        aria-describedby={ariaDescribedBy}
        aria-pressed={pressed === undefined ? undefined : pressed}
        data-tooltip={tooltipText}
        data-tone={tone}
        className={cn('icon-button', className)}
        style={{ width: squareSize, minWidth: squareSize, paddingInline: 0, ...style }}
        onMouseEnter={(event) => {
          onMouseEnter?.(event)
          showTooltip()
        }}
        onMouseLeave={(event) => {
          onMouseLeave?.(event)
          hideTooltip()
        }}
        onFocus={(event) => {
          onFocus?.(event)
          if (event.nativeEvent.isTrusted && shouldShowFocusTooltip()) {
            showTooltip()
          }
        }}
        onBlur={(event) => {
          onBlur?.(event)
          hideTooltip()
        }}
      >
        {children}
      </Button>
    )
  },
)
IconButton.displayName = 'IconButton'
