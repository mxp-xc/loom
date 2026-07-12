import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { agentColor, agentShort, type AgentId } from '@/lib/agents'
import { cn } from '@/lib/utils'

export type TargetChipState = 'on' | 'off' | 'mixed'

interface TargetChipProps {
  agent?: AgentId
  label?: string
  children?: ReactNode
  state: TargetChipState
  tooltip?: string
  color?: string
  count?: ReactNode
  className?: string
  disabled?: boolean
  stopPropagation?: boolean
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

export function TargetChip({
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
}: TargetChipProps) {
  const text = children ?? (agent ? agentShort[agent] : null)
  const style = {
    '--c': color ?? (agent ? agentColor[agent] : 'var(--primary)'),
  } as CSSProperties
  const sharedProps = {
    className: cn('target-chip', className),
    style,
    'data-agent-chip': agent && count == null ? 'true' : undefined,
    'data-state': state,
    'data-tooltip': tooltip,
    'aria-label': label,
  }
  const content = (
    <>
      {text}
      {count != null && <span className="target-chip-count">{count}</span>}
    </>
  )

  if (!onClick) {
    return <span {...sharedProps}>{content}</span>
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
      {content}
    </button>
  )
}
