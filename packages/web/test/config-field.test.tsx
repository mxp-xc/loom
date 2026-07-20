// @vitest-environment jsdom
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigField, FIELD_SCHEMA, type ConfigLevel } from '../src/components/ConfigField'
import { deferred } from './deferred'

function field(key: string) {
  const result = FIELD_SCHEMA.find((candidate) => candidate.key === key)
  if (!result) throw new Error(`Missing field ${key}`)
  return result
}

function FieldHarness({
  fieldKey,
  level = 'local',
  value,
  effectiveValue = value,
  inRepo = false,
  inLocal = true,
  options,
  onCommit = vi.fn(async () => undefined),
}: {
  fieldKey: string
  level?: ConfigLevel
  value?: unknown
  effectiveValue?: unknown
  inRepo?: boolean
  inLocal?: boolean
  options?: string[]
  onCommit?: (key: string, value: unknown) => Promise<void>
}) {
  const [draft, setDraft] = useState<string>()
  return (
    <ConfigField
      field={field(fieldKey)}
      level={level}
      value={value}
      effectiveValue={effectiveValue}
      inRepo={inRepo}
      inLocal={inLocal}
      options={options}
      onCommit={onCommit}
      draft={draft}
      onDraftChange={(_key, nextDraft) => setDraft(nextDraft)}
    />
  )
}

describe('ConfigField', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a placeholder for empty inherited input values before editing', () => {
    render(
      <FieldHarness
        fieldKey="proxy.http"
        value={undefined}
        effectiveValue=""
        inRepo
        inLocal={false}
      />,
    )

    expect(screen.getByRole('button', { name: '编辑 HTTP' }).textContent).toBe('— 未设置')
  })

  it('uses native semantics for select, segmented, toggle, and inheritance actions', () => {
    const views = [
      render(<FieldHarness fieldKey="profile" value="work" options={['work', 'personal']} />),
      render(<FieldHarness fieldKey="projection.strategy" value="copy" />),
      render(<FieldHarness fieldKey="update_check.enabled" value />),
      render(
        <FieldHarness
          fieldKey="proxy.http"
          value={undefined}
          effectiveValue="http://proxy"
          inRepo
          inLocal={false}
        />,
      ),
    ]

    expect(screen.getByRole('combobox', { name: 'Profile' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'copy' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Auto check' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: '继承仓库级 · 点此覆盖' })).toBeDefined()
    views.forEach((view) => view.unmount())
  })

  it('allows only one save while a field mutation is pending', async () => {
    const request = deferred<void>()
    const onCommit = vi.fn(() => request.promise)
    render(<FieldHarness fieldKey="update_check.enabled" value={false} onCommit={onCommit} />)
    const toggle = screen.getByRole('switch', { name: 'Auto check' })

    fireEvent.click(toggle)
    fireEvent.click(toggle)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(toggle.hasAttribute('disabled')).toBe(true)
    await act(async () => {
      request.resolve()
      await request.promise
    })
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
  })

  it('shows the complete save failure and allows a retry', async () => {
    const cause = new Error('config write failed')
    const onCommit = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<FieldHarness fieldKey="update_check.enabled" value={false} onCommit={onCommit} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Auto check' }))
    expect((await screen.findByRole('alert')).textContent).toBe('config write failed')
    expect(consoleError).toHaveBeenCalledWith(
      { err: cause, field: 'update_check.enabled', level: 'local' },
      'Failed to save config field',
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Auto check' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('clears a configured value with the same mutation state machine', async () => {
    const onCommit = vi.fn(async () => undefined)
    render(<FieldHarness fieldKey="proxy.http" value="http://proxy" onCommit={onCommit} />)

    fireEvent.click(screen.getByRole('button', { name: '清空 HTTP' }))

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('proxy.http', null))
  })

  it('clears a selected profile instead of persisting an empty string', async () => {
    const onCommit = vi.fn(async () => undefined)
    render(<FieldHarness fieldKey="profile" value="work" options={['work']} onCommit={onCommit} />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Profile' }), {
      target: { value: '' },
    })

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('profile', null))
  })

  it('allows a stale profile to be cleared when no profiles are available', async () => {
    const onCommit = vi.fn(async () => undefined)
    render(<FieldHarness fieldKey="profile" value="stale" options={[]} onCommit={onCommit} />)
    const select = screen.getByRole('combobox', { name: 'Profile' })

    expect(select.hasAttribute('disabled')).toBe(false)
    fireEvent.change(select, { target: { value: '' } })

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('profile', null))
  })

  it('keeps active_repo disabled when repository options are unavailable', () => {
    render(<FieldHarness fieldKey="active_repo" value="default" />)

    expect(screen.getByRole('combobox', { name: 'Active repo' }).hasAttribute('disabled')).toBe(
      true,
    )
  })
})
