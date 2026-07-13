// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SkillReconciliationDialog from '../src/views/skills/SkillReconciliationDialog'

describe('SkillReconciliationDialog', () => {
  it('defaults removals to preserve and supports clear, select all, and do not preserve', () => {
    const onConfirm = vi.fn(async () => {})
    render(
      <SkillReconciliationDialog
        state={{
          sessionId: 'session-1',
          pinned_commit: 'abc',
          changes: {
            added: [{ name: 'added' }],
            updated: [{ name: 'updated' }],
            removed: [{ name: 'removed-a' }, { name: 'removed-b' }],
          },
        }}
        busy={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('added')).toBeTruthy()
    expect(screen.getByText('updated')).toBeTruthy()
    expect((screen.getByLabelText('保留 removed-a') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('保留 removed-b') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '取消全选' }))
    expect((screen.getByLabelText('保留 removed-a') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    fireEvent.click(screen.getByLabelText('保留 removed-b'))
    fireEvent.click(screen.getByRole('button', { name: '保留所选并继续' }))
    expect(onConfirm).toHaveBeenLastCalledWith(['removed-a'])

    fireEvent.click(screen.getByRole('button', { name: '不保留' }))
    expect(onConfirm).toHaveBeenLastCalledWith([])
  })
})
