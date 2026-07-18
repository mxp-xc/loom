import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { agentColor, agentName, type AgentId } from '@/lib/agents'
import { resolveAgentIcon } from '@/lib/agent-icons'
import { getAgent } from '@loom/core'
import { cn } from '@/lib/utils'

export type AgentChipState = 'on' | 'off' | 'mixed'

interface AgentChipProps {
  agent?: AgentId
  label?: string
  children?: ReactNode
  state: AgentChipState
  tooltip?: string
  color?: string
  count?: ReactNode
  className?: string
  disabled?: boolean
  stopPropagation?: boolean
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

export function AgentChip({
  agent,
  label,
  children,
  state,
  tooltip,
  color,
  count,
  className,
  disabled,
  stopPropagation,
  onClick,
}: AgentChipProps) {
  const chipRef = useRef<HTMLElement | null>(null)
  const floatingTooltipRef = useRef<HTMLSpanElement | null>(null)
  const cleanupViewportListenersRef = useRef<(() => void) | null>(null)
  const tooltipId = useId()
  const icon = agent ? resolveAgentIcon(getAgent(agent).display.icon) : null
  const content =
    children ??
    (icon?.kind === 'asset' ? (
      <span className="agent-chip-icon" aria-hidden="true" />
    ) : icon?.kind === 'text' ? (
      <span className="agent-chip-text" aria-hidden="true">
        {icon.text}
      </span>
    ) : null)
  const style = {
    '--c': color ?? (agent ? agentColor[agent] : 'var(--primary)'),
    ...(icon?.kind === 'asset' ? { '--agent-icon': `url("${icon.url}")` } : {}),
  } as CSSProperties
  const cleanupViewportListeners = useCallback(() => {
    cleanupViewportListenersRef.current?.()
    cleanupViewportListenersRef.current = null
  }, [])
  const positionFloatingTooltip = useCallback(() => {
    if (typeof window === 'undefined') return
    const chip = chipRef.current
    const tooltipNode = floatingTooltipRef.current
    if (!chip || !tooltipNode) return

    const chipRect = chip.getBoundingClientRect()
    const margin = 8
    const gap = 7
    const rawLeft = chipRect.left + chipRect.width / 2
    tooltipNode.style.left = rawLeft + 'px'
    tooltipNode.style.top = chipRect.top - gap + 'px'
    tooltipNode.dataset.placement = 'top'

    const tooltipRect = tooltipNode.getBoundingClientRect()
    const halfWidth = tooltipRect.width / 2
    const minLeft = margin + halfWidth
    const maxLeft = window.innerWidth - margin - halfWidth
    tooltipNode.style.left =
      (maxLeft > minLeft ? Math.min(Math.max(rawLeft, minLeft), maxLeft) : window.innerWidth / 2) +
      'px'
    if (chipRect.top - gap - tooltipRect.height < margin) {
      tooltipNode.style.top = chipRect.bottom + gap + 'px'
      tooltipNode.dataset.placement = 'bottom'
    }
  }, [])
  const showTooltip = useCallback(() => {
    if (!tooltip || typeof document === 'undefined') return
    let tooltipNode = floatingTooltipRef.current
    if (!tooltipNode) {
      tooltipNode = document.createElement('span')
      floatingTooltipRef.current = tooltipNode
    }
    tooltipNode.id = tooltipId
    tooltipNode.className = 'agent-chip-floating-tooltip'
    tooltipNode.setAttribute('role', 'tooltip')
    tooltipNode.textContent = tooltip
    if (!tooltipNode.isConnected) document.body.appendChild(tooltipNode)
    chipRef.current?.setAttribute('aria-describedby', tooltipId)
    positionFloatingTooltip()

    cleanupViewportListeners()
    const handleViewportChange = () => positionFloatingTooltip()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    cleanupViewportListenersRef.current = () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [cleanupViewportListeners, positionFloatingTooltip, tooltip, tooltipId])
  const hideTooltip = useCallback(() => {
    cleanupViewportListeners()
    floatingTooltipRef.current?.remove()
    chipRef.current?.removeAttribute('aria-describedby')
  }, [cleanupViewportListeners])

  useEffect(
    () => () => {
      cleanupViewportListeners()
      floatingTooltipRef.current?.remove()
    },
    [cleanupViewportListeners],
  )

  const sharedProps = {
    ref: (node: HTMLElement | null) => {
      chipRef.current = node
    },
    className: cn('agent-chip', className),
    style,
    'data-agent-chip': agent ? 'true' : undefined,
    'data-agent': agent,
    'data-has-count': count != null ? 'true' : undefined,
    'data-state': state,
    'data-tooltip': tooltip,
    'aria-label': label ?? (agent ? agentName[agent] : undefined),
    onMouseEnter: showTooltip,
    onMouseLeave: hideTooltip,
    onFocus: showTooltip,
    onBlur: hideTooltip,
  }
  const renderedContent = (
    <>
      {content}
      {count != null && <span className="agent-chip-count">{count}</span>}
    </>
  )

  if (!onClick) {
    return <span {...sharedProps}>{renderedContent}</span>
  }

  return (
    <button
      {...sharedProps}
      type="button"
      data-interactive="true"
      aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
      disabled={disabled}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        onClick(event)
      }}
    >
      {renderedContent}
    </button>
  )
}
