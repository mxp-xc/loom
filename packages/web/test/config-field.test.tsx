// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigField, FIELD_SCHEMA } from '../src/components/ConfigField'

describe('ConfigField', () => {
  it('shows a placeholder for empty inherited input values before editing', () => {
    const proxyHttpField = FIELD_SCHEMA.find((field) => field.key === 'proxy.http')
    expect(proxyHttpField).toBeDefined()

    render(
      <ConfigField
        field={proxyHttpField!}
        level="local"
        value={undefined}
        effectiveValue=""
        inRepo
        inLocal={false}
        onCommit={vi.fn(async () => undefined)}
        draft={undefined}
        onDraftChange={vi.fn()}
      />,
    )

    expect(screen.getByText('— 未设置')).toBeDefined()
  })
})
