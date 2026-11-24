// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Dropdown } from '../src/components/ui/dropdown'

const options = ['main', 'CTX7-1037', 'CTX7-2533/local-http-host-validation', 'release/6.1'].map(
  (value) => ({ value, label: value }),
)

function Harness() {
  const [value, setValue] = useState('main')
  return (
    <Dropdown
      ariaLabel="Repository ref"
      value={value}
      options={options}
      onChange={setValue}
      searchable
      searchPlaceholder="搜索 ref…"
    />
  )
}

describe('Dropdown search', () => {
  it('filters options by a case-insensitive fuzzy query', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Repository ref' }))
    const search = screen.getByRole('searchbox', { name: '搜索 ref…' })

    fireEvent.change(search, { target: { value: 'ctx7' } })
    expect(screen.getByRole('option', { name: 'CTX7-1037' })).toBeDefined()
    expect(
      screen.getByRole('option', { name: 'CTX7-2533/local-http-host-validation' }),
    ).toBeDefined()
    expect(screen.queryByRole('option', { name: 'main' })).toBeNull()

    fireEvent.change(search, { target: { value: 'ctx72533' } })
    expect(
      screen.getByRole('option', { name: 'CTX7-2533/local-http-host-validation' }),
    ).toBeDefined()
    expect(screen.queryByRole('option', { name: 'CTX7-1037' })).toBeNull()

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('无匹配项')).toBeDefined()
  })

  it('selects a filtered option and clears the query on close', () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Repository ref' })
    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 ref…' }), {
      target: { value: 'release' },
    })
    fireEvent.click(screen.getByRole('option', { name: 'release/6.1' }))

    expect(trigger.textContent).toContain('release/6.1')
    expect(screen.queryByRole('searchbox')).toBeNull()

    fireEvent.click(trigger)
    expect((screen.getByRole('searchbox', { name: '搜索 ref…' }) as HTMLInputElement).value).toBe(
      '',
    )
  })
})
