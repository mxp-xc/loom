import { Bot } from 'lucide-react'
import { AgentChip, type AgentChipState } from '@/components/ui/AgentChip'
import { cn } from '@/lib/utils'

interface Props {
  state: AgentChipState
  label: string
  count?: string
  className?: string
  disabled?: boolean
  onClick?: () => void
}

export default function SharedSkillChip({
  state,
  label,
  count,
  className,
  disabled,
  onClick,
}: Props) {
  return (
    <AgentChip
      className={cn('shared-skill-chip', className)}
      state={state}
      label={label}
      tooltip="投影到 ~/.agents/skills"
      color="var(--signal)"
      count={count}
      disabled={disabled}
      onClick={onClick}
    >
      <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
    </AgentChip>
  )
}
