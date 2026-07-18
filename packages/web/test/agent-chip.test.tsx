// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
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

  it('renders its tooltip in the document overlay layer to avoid ancestor clipping', () => {
    const { container } = render(
      <div data-testid="clipping-container" style={{ overflow: 'hidden' }}>
        <AgentChip agent="codex" state="on" tooltip="Codex 当前使用 v1" onClick={vi.fn()} />
      </div>,
    )
    const chip = screen.getByRole('button', { name: 'Codex' })
    vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue({
      x: 4,
      y: 2,
      top: 2,
      right: 28,
      bottom: 26,
      left: 4,
      width: 24,
      height: 24,
      toJSON: () => ({}),
    })

    fireEvent.mouseEnter(chip)

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.parentElement).toBe(document.body)
    expect(container.contains(tooltip)).toBe(false)
    expect(tooltip.getAttribute('data-placement')).toBe('bottom')
    expect(chip.getAttribute('aria-describedby')).toBe(tooltip.id)

    fireEvent.mouseLeave(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
