// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SourceNamespaceCollisionDialog from '../src/views/skills/SourceNamespaceCollisionDialog'

const collision = {
  agent: 'codex' as const,
  sourceName: 'playwright-cli',
  sourceUrl: 'https://github.com/microsoft/playwright-cli.git',
}

describe('SourceNamespaceCollisionDialog', () => {
  it('offers a reversible GUI resolution without exposing shell instructions', () => {
    const onClose = vi.fn()
    const onResolve = vi.fn(async () => undefined)
    render(
      <SourceNamespaceCollisionDialog
        collision={collision}
        busy={false}
        onClose={onClose}
        onResolve={onResolve}
      />,
    )

    expect(screen.getByText('playwright-cli')).toBeTruthy()
    expect(screen.getByText(/skill-backups/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '备份并改由 Loom 管理' }))
    expect(onResolve).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '保留现有目录' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('locks both decisions while the backup transaction is running', () => {
    render(
      <SourceNamespaceCollisionDialog
        collision={collision}
        busy
        onClose={vi.fn()}
        onResolve={vi.fn(async () => undefined)}
      />,
    )

    expect(
      (screen.getByRole('button', { name: '保留现有目录' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: '处理中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
