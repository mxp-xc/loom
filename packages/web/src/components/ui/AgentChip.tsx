import type { CSSProperties, MouseEvent, ReactNode } from 'react'
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
  const sharedProps = {
    className: cn('agent-chip', className),
    style,
    'data-agent-chip': agent ? 'true' : undefined,
    'data-agent': agent,
    'data-has-count': count != null ? 'true' : undefined,
    'data-state': state,
    'data-tooltip': tooltip,
    'aria-label': label ?? (agent ? agentName[agent] : undefined),
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
