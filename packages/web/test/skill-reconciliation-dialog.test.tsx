// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SkillReconciliationDialog from '../src/views/skills/SkillReconciliationDialog'

describe('SkillReconciliationDialog', () => {
  it('always shows added, updated, and removed summaries', () => {
    render(
      <SkillReconciliationDialog
        state={{
          sessionId: 'session-empty',
          pinned_commit: 'abc',
          changes: { added: [], updated: [], removed: [] },
          resourceBoundaryChanges: [],
        }}
        busy={false}
        onClose={vi.fn()}
        onConfirm={vi.fn(async () => {})}
      />,
    )

    expect(screen.getByRole('heading', { name: '新增' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '更新' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '删除' })).toBeTruthy()
    expect(screen.getAllByText('无变化')).toHaveLength(3)
  })

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
          resourceBoundaryChanges: [],
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
    expect(onConfirm).toHaveBeenLastCalledWith(['removed-a'], [])

    fireEvent.click(screen.getByRole('button', { name: '不保留' }))
    expect(onConfirm).toHaveBeenLastCalledWith([], [])
  })

  it('chooses whether new resource boundaries stay excluded or become enabled bundles', () => {
    const onConfirm = vi.fn(async () => {})
    render(
      <SkillReconciliationDialog
        state={{
          sessionId: 'session-boundary',
          pinned_commit: 'def',
          changes: { added: [], updated: [], removed: [] },
          resourceBoundaryChanges: [
            {
              name: 'new-skill',
              entry: 'shared/new-skill/SKILL.md',
              path: 'shared/new-skill',
            },
          ],
        }}
        busy={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('新增 SkillBundle 边界')).toBeTruthy()
    expect(screen.getByText('new-skill')).toBeTruthy()
    expect(screen.getByText('shared/new-skill')).toBeTruthy()
    expect(screen.getByText(/不再作为普通资源投影/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('启用 new-skill'))
    fireEvent.click(screen.getByRole('button', { name: '应用更新' }))
    expect(onConfirm).toHaveBeenCalledWith(
      [],
      [{ entry: 'shared/new-skill/SKILL.md', action: 'enable' }],
    )
  })
})
