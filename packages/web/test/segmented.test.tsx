// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Segmented } from '../src/views/skills/Segmented'

describe('Segmented', () => {
  it('announces and clearly colors the selected option', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        value="tag"
        options={[
          { value: 'branch', label: 'branch' },
          { value: 'tag', label: 'tag' },
        ]}
        onChange={onChange}
      />,
    )

    const branch = screen.getByRole('button', { name: 'branch' })
    const tag = screen.getByRole('button', { name: 'tag' })
    expect(branch.getAttribute('aria-pressed')).toBe('false')
    expect(tag.getAttribute('aria-pressed')).toBe('true')
    expect(tag.style.background).toContain('var(--primary)')
    expect(tag.style.borderColor).toContain('var(--primary)')

    fireEvent.click(branch)
    expect(onChange).toHaveBeenCalledWith('branch')
  })
})
