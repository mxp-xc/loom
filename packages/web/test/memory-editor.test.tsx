// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MemoryEditor from '../src/components/MemoryEditor'
import { ApiError, api } from '../src/lib/api'

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')
  return {
    ...actual,
    api: {
      previewMemory: vi.fn(),
    },
  }
})

describe('MemoryEditor', () => {
  it('shows structured resolver diagnostics in the agent rendered preview', async () => {
    vi.mocked(api.previewMemory).mockRejectedValue(
      new ApiError('render failed', 400, 'render_failed', [
        {
          code: 'MISSING_REFERENCE',
          severity: 'error',
          message: '变量不存在: memory.rtk',
          key: 'memory.rtk',
          path: ['memory.rtk'],
        },
      ]),
    )

    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="Use ${memory.rtk}"
        targets={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '解析预览' }))

    await waitFor(() =>
      expect(api.previewMemory).toHaveBeenCalledWith({
        repo: '/repo',
        content: 'Use ${memory.rtk}',
        agent: 'codex',
      }),
    )
    const diagnostics = await screen.findByLabelText('解析诊断')
    expect(diagnostics.textContent).toContain('MISSING_REFERENCE')
    expect(diagnostics.textContent).toContain('key=memory.rtk')
    expect(diagnostics.textContent).toContain('path=memory.rtk')
  })

  it('clears the previous rendered preview when the current draft fails to resolve', async () => {
    vi.mocked(api.previewMemory)
      .mockResolvedValueOnce({
        rendered: 'Rendered once',
        diagnostics: [],
      } as never)
      .mockRejectedValueOnce(
        new ApiError('render failed', 400, 'render_failed', [
          {
            code: 'MISSING_REFERENCE',
            severity: 'error',
            message: '变量不存在: missing',
            key: 'missing',
          },
        ]),
      )

    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content={'Use ' + '$' + '{ok}'}
        targets={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '解析预览' }))
    expect(await screen.findByText('Rendered once')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Use ' + '$' + '{missing}' },
    })
    fireEvent.click(screen.getByRole('button', { name: '解析预览' }))

    await screen.findByLabelText('解析诊断')
    expect(screen.queryByText('Rendered once')).toBeNull()
  })
})
