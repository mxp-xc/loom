// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VariableEditor from '../src/views/vars/VariableEditor'
import JsonValueEditor from '../src/views/vars/JsonValueEditor'
import type { VarEntryInput, VarsResolution } from '../src/lib/vars'
import { ApiError } from '../src/lib/api'
import { StrictMode } from 'react'

const resolution: VarsResolution = {
  ok: true,
  values: {
    API_URL: { type: 'string', value: 'https://example.test' },
    PORT: { type: 'number', value: 3000 },
    API_TOKEN: { type: 'secret', value: '••••••••', masked: true },
    MASKED_URL: { type: 'string', value: '••••••••', masked: true },
  },
  sources: { API_URL: 'base', PORT: 'base', API_TOKEN: 'prod', MASKED_URL: 'prod' },
  dependencies: {},
  diagnostics: [],
}

function editor(
  entry: VarEntryInput = { type: 'string', value: '' },
  onSave = vi.fn<(...args: [string, VarEntryInput]) => Promise<void>>().mockResolvedValue(),
  validateDraft = vi.fn().mockResolvedValue({ ok: true, resolution }),
) {
  return render(
    <VariableEditor
      initialKey="DEMO"
      entry={entry}
      resolution={resolution}
      pending={false}
      onSave={onSave}
      validateDraft={validateDraft}
    />,
  )
}

afterEach(() => vi.useRealTimers())

describe('variable editors', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }
  it.each([
    ['string', 'hello', { type: 'string', value: 'hello' }],
    ['number', '42.5', { type: 'number', value: 42.5 }],
    ['boolean', 'false', { type: 'boolean', value: false }],
    ['secret', 's3cr3t', { type: 'secret', value: 's3cr3t' }],
  ] as const)('parses and saves %s values', async (type, value, expected) => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    editor({ type: 'string', value: '' }, onSave)
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: type } })
    fireEvent.change(screen.getByLabelText('值'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('DEMO', expected))
  })

  it('saves a parsed JSON payload after validation', async () => {
    const order: string[] = []
    const validateDraft = vi.fn(async (_key: string, entry: VarEntryInput) => {
      order.push(`validate:${entry.type}`)
      return { ok: true as const, resolution }
    })
    const onSave = vi.fn(async (_key: string, entry: VarEntryInput) => {
      order.push(`save:${entry.type}`)
    })
    editor({ type: 'json', value: { enabled: true } }, onSave, validateDraft)
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('DEMO', { type: 'json', value: { enabled: true } }),
    )
    expect(order).toEqual(['validate:json', 'save:json'])
  })

  it('shows metadata completions and inserts the keyboard-selected token', () => {
    editor()
    const input = screen.getByLabelText('值')
    fireEvent.change(input, { target: { value: '${PO', selectionStart: 4 } })
    const listbox = screen.getByRole('listbox', { name: '变量引用建议' })
    expect(within(listbox).getByRole('option').textContent).toContain('PORT')
    expect(within(listbox).getByRole('option').textContent).toContain('number')
    expect(within(listbox).getByRole('option').textContent).toContain('base')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLTextAreaElement).value).toBe('${PORT}')
  })

  it('never reveals secret or transitively masked completion values and supports secret toggle', () => {
    editor({ type: 'secret', value: 'top-secret' })
    const input = screen.getByLabelText('值') as HTMLInputElement
    expect(input.type).toBe('password')
    const toggle = screen.getByRole('button', { name: '显示密钥' })
    fireEvent.click(toggle)
    expect(input.type).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'string' } })
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '${' } })
    const suggestions = screen.getByRole('listbox').textContent ?? ''
    expect(suggestions).toContain('API_TOKEN')
    expect(suggestions).toContain('MASKED_URL')
    expect(suggestions).not.toContain('top-secret')
    expect(suggestions.match(/••••••••/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('does not validate or save an untouched masked secret sentinel', () => {
    const validateDraft = vi.fn()
    const onSave = vi.fn()
    editor({ type: 'secret', value: '••••••••', masked: true }, onSave, validateDraft)
    const save = screen.getByRole('button', { name: '保存变量' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(save)
    expect(validateDraft).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves a newly typed secret instead of the mask sentinel', async () => {
    const validateDraft = vi.fn().mockResolvedValue({ ok: true, resolution })
    const onSave = vi.fn().mockResolvedValue(undefined)
    editor({ type: 'secret', value: '••••••••', masked: true }, onSave, validateDraft)
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'replacement' } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('DEMO', { type: 'secret', value: 'replacement' }),
    )
  })

  it('reveals and saves the real secret while hide only changes its input mode', async () => {
    const validateDraft = vi.fn().mockResolvedValue({ ok: true, resolution })
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onReveal = vi.fn().mockResolvedValue('real-secret')
    render(
      <VariableEditor
        initialKey="DEMO"
        entry={{ type: 'secret', value: '••••••••', masked: true }}
        resolution={resolution}
        pending={false}
        onSave={onSave}
        validateDraft={validateDraft}
        onReveal={onReveal}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }))
    await waitFor(() =>
      expect((screen.getByLabelText('值') as HTMLInputElement).value).toBe('real-secret'),
    )
    fireEvent.click(screen.getByRole('button', { name: '隐藏密钥' }))
    expect((screen.getByLabelText('值') as HTMLInputElement).type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('DEMO', { type: 'secret', value: 'real-secret' }),
    )
  })

  it('discards a deferred reveal after type, key, or mount changes', async () => {
    const reveal = deferred<string>()
    const onSave = vi.fn().mockResolvedValue(undefined)
    const props = {
      initialKey: 'SECRET',
      entry: { type: 'secret', value: '••••••••', masked: true } as const,
      resolution,
      pending: false,
      onSave,
      validateDraft: vi.fn().mockResolvedValue({ ok: true, resolution }),
      onReveal: vi.fn(() => reveal.promise),
    }
    const view = render(<VariableEditor {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }))
    expect((screen.getByLabelText('类型') as HTMLSelectElement).disabled).toBe(true)
    view.rerender(
      <VariableEditor {...props} initialKey="OTHER" entry={{ type: 'string', value: 'safe' }} />,
    )
    reveal.resolve('real-secret')
    await act(async () => reveal.promise)
    expect(document.body.textContent).not.toContain('real-secret')
    expect((screen.getByLabelText('值') as HTMLTextAreaElement).value).toBe('safe')
    view.unmount()
  })

  it('shows a field alert and logs the complete reveal error', async () => {
    const cause = new Error('reveal denied')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <VariableEditor
        initialKey="DEMO"
        entry={{ type: 'secret', value: '••••••••', masked: true }}
        resolution={resolution}
        pending={false}
        onSave={vi.fn()}
        validateDraft={vi.fn()}
        onReveal={vi.fn().mockRejectedValue(cause)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }))
    expect((await screen.findByRole('alert')).textContent).toContain('密钥显示失败')
    expect(errorSpy).toHaveBeenCalledWith('Failed to reveal secret variable', cause)
    errorSpy.mockRestore()
  })

  it('restores mounted state across StrictMode effect replay and applies the latest reveal', async () => {
    const reveal = deferred<string>()
    render(
      <StrictMode>
        <VariableEditor
          initialKey="DEMO"
          entry={{ type: 'secret', value: '••••••••', masked: true }}
          resolution={resolution}
          pending={false}
          onSave={vi.fn()}
          validateDraft={vi.fn().mockResolvedValue({ ok: true, resolution })}
          onReveal={() => reveal.promise}
        />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }))
    reveal.resolve('strict-secret')
    await act(async () => reveal.promise)
    await waitFor(() =>
      expect((screen.getByLabelText('值') as HTMLInputElement).value).toBe('strict-secret'),
    )
    expect((screen.getByRole('button', { name: '保存变量' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('clears reveal busy state on props switch without letting old finally affect the new generation', async () => {
    const oldReveal = deferred<string>()
    const props = {
      initialKey: 'OLD',
      entry: { type: 'secret', value: '••••••••', masked: true } as const,
      resolution,
      pending: false,
      onSave: vi.fn(),
      validateDraft: vi.fn().mockResolvedValue({ ok: true, resolution }),
      onReveal: () => oldReveal.promise,
    }
    const view = render(<VariableEditor {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }))
    view.rerender(
      <VariableEditor {...props} initialKey="NEW" entry={{ type: 'string', value: 'new-value' }} />,
    )
    await waitFor(() =>
      expect((screen.getByLabelText('类型') as HTMLSelectElement).disabled).toBe(false),
    )
    oldReveal.resolve('old-secret')
    await act(async () => oldReveal.promise)
    expect((screen.getByLabelText('值') as HTMLTextAreaElement).value).toBe('new-value')
    expect(document.body.textContent).not.toContain('old-secret')
  })

  it('rejects empty and whitespace number drafts instead of coercing them to zero', async () => {
    const validateDraft = vi.fn()
    const onSave = vi.fn()
    editor({ type: 'number', value: 1 }, onSave, validateDraft)
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    expect((await screen.findByRole('alert')).textContent).toContain('有限数字')
    expect(validateDraft).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('aborts save if draft revision changes while validation is pending', async () => {
    const validation = deferred<{ ok: true; resolution: VarsResolution }>()
    const onSave = vi.fn()
    editor(
      { type: 'string', value: 'old' },
      onSave,
      vi.fn(() => validation.promise),
    )
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    expect((screen.getByLabelText('值') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'new' } })
    validation.resolve({ ok: true, resolution })
    await act(async () => validation.promise)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('formats JSON and blocks invalid JSON saves with a field-local alert', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onChange = vi.fn()
    const onError = vi.fn()
    const view = render(
      <JsonValueEditor value={'{"a":1}'} onChange={onChange} error={null} onError={onError} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '格式化 JSON' }))
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1\n}')
    view.rerender(
      <JsonValueEditor
        value="{broken"
        onChange={onChange}
        error="JSON 语法错误"
        onError={onError}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('JSON')
    fireEvent.click(screen.getByRole('button', { name: '格式化 JSON' }))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('JSON 语法错误'))
    expect(errorSpy).toHaveBeenCalledWith('JSON format failed', { cause: expect.any(SyntaxError) })
    errorSpy.mockRestore()
  })

  it('blocks invalid JSON before validation or save', async () => {
    const validateDraft = vi.fn()
    const onSave = vi.fn()
    editor({ type: 'string', value: '' }, onSave, validateDraft)
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'json' } })
    const jsonInput = screen.getByRole('textbox', { name: 'JSON 值' })
    fireEvent.input(jsonInput, { target: { textContent: '{broken' } })
    await waitFor(() => expect(jsonInput.textContent).toContain('{broken'))
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(validateDraft).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('validates before save and does not PUT when server validation fails', async () => {
    const order: string[] = []
    const diagnosticError = new ApiError('invalid', 422, 'validation_failed', [
      {
        code: 'MISSING_REFERENCE',
        severity: 'error',
        key: 'DEMO',
        path: ['DEMO', 'MISSING'],
        message: '引用缺失',
      },
    ])
    const validateDraft = vi.fn(async () => {
      order.push('validate')
      throw diagnosticError
    })
    const onSave = vi.fn(async () => {
      order.push('save')
    })
    editor({ type: 'string', value: '${MISSING}' }, onSave, validateDraft)
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    expect((await screen.findByRole('alert')).textContent).toContain('MISSING_REFERENCE')
    expect(screen.getByRole('alert').textContent).toContain('DEMO → MISSING')
    expect(order).toEqual(['validate'])
    expect(onSave).not.toHaveBeenCalled()
  })

  it('debounces server preview, ignores stale responses, and cancels updates after unmount', async () => {
    vi.useFakeTimers()
    const pending: Array<{
      value: string
      resolve: (value: { ok: true; resolution: VarsResolution }) => void
    }> = []
    const validateDraft = vi.fn(
      (_key: string, entry: VarEntryInput) =>
        new Promise<{ ok: true; resolution: VarsResolution }>((resolve) =>
          pending.push({ value: String(entry.value), resolve }),
        ),
    )
    const view = editor({ type: 'string', value: '' }, undefined, validateDraft)
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '${API_URL}/v1' } })
    expect(screen.getByLabelText('解析预览').textContent).not.toContain('example.test')
    act(() => vi.advanceTimersByTime(200))
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'newer' } })
    act(() => vi.advanceTimersByTime(200))
    await act(async () =>
      pending[0].resolve({
        ok: true,
        resolution: {
          ...resolution,
          values: { ...resolution.values, DEMO: { type: 'string', value: 'stale' } },
        },
      }),
    )
    expect(screen.getByLabelText('解析预览').textContent).not.toContain('stale')
    await act(async () =>
      pending[1].resolve({
        ok: true,
        resolution: {
          ...resolution,
          values: { ...resolution.values, DEMO: { type: 'string', value: 'fresh' } },
        },
      }),
    )
    expect(screen.getByLabelText('解析预览').textContent).toContain('fresh')
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'unmounted' } })
    act(() => vi.advanceTimersByTime(200))
    view.unmount()
    await act(async () =>
      pending[2].resolve({
        ok: true,
        resolution: {
          ...resolution,
          values: { ...resolution.values, DEMO: { type: 'string', value: 'ignored' } },
        },
      }),
    )
  })

  it('does not revalidate preview when parent pending rerenders around save', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const validateDraft = vi.fn(async () => {
      calls.push('validate')
      return { ok: true as const, resolution }
    })
    const onSave = vi.fn(async () => {
      calls.push('save')
    })
    const view = render(
      <VariableEditor
        initialKey="DEMO"
        entry={{ type: 'string', value: 'draft' }}
        resolution={resolution}
        pending={false}
        onSave={onSave}
        validateDraft={validateDraft}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await act(async () => undefined)
    view.rerender(
      <VariableEditor
        initialKey="DEMO"
        entry={{ type: 'string', value: 'draft' }}
        resolution={resolution}
        pending={true}
        onSave={onSave}
        validateDraft={validateDraft}
      />,
    )
    view.rerender(
      <VariableEditor
        initialKey="DEMO"
        entry={{ type: 'string', value: 'draft' }}
        resolution={resolution}
        pending={false}
        onSave={onSave}
        validateDraft={validateDraft}
      />,
    )
    act(() => vi.advanceTimersByTime(250))
    expect(calls).toEqual(['validate', 'save'])
  })

  it('maps structured API diagnostics to the field and logs the complete error', async () => {
    const cause = new ApiError('invalid', 400, 'INVALID_VARIABLE', [
      { code: 'INVALID', severity: 'error', key: 'DEMO', message: '服务端拒绝该值' },
    ])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    editor({ type: 'string', value: 'bad' }, vi.fn().mockRejectedValue(cause))
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    expect((await screen.findByRole('alert')).textContent).toContain('服务端拒绝该值')
    expect(errorSpy).toHaveBeenCalledWith('Failed to save variable', cause)
    errorSpy.mockRestore()
  })
})
