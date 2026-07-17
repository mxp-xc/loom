// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentChip } from '../src/components/ui/AgentChip'
import '../src/index.css'

describe('AgentChip', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
  ] as const)('renders the %s brand icon without an abbreviation', (agent, label) => {
    render(<AgentChip agent={agent} state="on" tooltip="已启用" />)

    const icon = screen.getByText('', {
      selector: `[data-agent="${agent}"] .agent-chip-icon`,
    })
    const chip = screen.getByLabelText(label)
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(chip.textContent).toBe('')
    expect(chip.getAttribute('data-tooltip')).toBe('已启用')
    expect(chip.getAttribute('data-tooltip')).not.toMatch(/\b(?:CC|CX|OC)\b/)
  })

  it('keeps mixed state semantics and count beside the icon', () => {
    render(
      <AgentChip
        agent="codex"
        state="mixed"
        label="Codex 部分启用"
        count="2/4"
        onClick={vi.fn()}
      />,
    )

    const chip = screen.getByRole('button', { name: 'Codex 部分启用' })
    expect(chip.getAttribute('aria-pressed')).toBe('mixed')
    expect(chip.getAttribute('data-has-count')).toBe('true')
    expect(chip.querySelector('.agent-chip-icon')).not.toBeNull()
    expect(chip.querySelector('.agent-chip-count')?.textContent).toBe('2/4')
  })
})
