// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MonacoTextEditor, {
  MonacoRenderErrorBoundary,
} from '../src/components/monaco/MonacoTextEditor'
import { createMonacoEditorMock } from './monaco-test-utils'

const monacoEditorMock = createMonacoEditorMock()

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

describe('MonacoTextEditor', () => {
  beforeEach(() => {
    monacoEditorMock.reset()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute('data-theme')
  })

  it('renders a labelled Monaco textarea through the test mock', () => {
    render(
      <MonacoTextEditor ariaLabel="配置值" value="hello" onChange={vi.fn()} language="markdown" />,
    )

    expect(screen.getByRole('textbox', { name: '配置值' })).toMatchObject({ value: 'hello' })
  })

  it('keeps the Monaco theme synced with document data-theme', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')

    render(<MonacoTextEditor ariaLabel="配置值" value="" onChange={vi.fn()} />)

    expect(monacoEditorMock.props.at(-1)?.theme).toBe('vs-dark')

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light')
      await Promise.resolve()
    })

    expect(monacoEditorMock.props.at(-1)?.theme).toBe('vs')
  })

  it('forwards readOnly, language, height, value, and onChange', () => {
    const onChange = vi.fn()

    render(
      <MonacoTextEditor
        ariaLabel="配置值"
        value="before"
        onChange={onChange}
        readOnly
        language="json"
        height="240px"
      />,
    )

    const props = monacoEditorMock.props.at(-1)
    expect(props).toMatchObject({
      height: '240px',
      language: 'json',
      value: 'before',
    })
    expect(props?.options).toMatchObject({
      readOnly: true,
      domReadOnly: true,
    })

    fireEvent.change(screen.getByRole('textbox', { name: '配置值' }), {
      target: { value: 'after' },
    })

    expect(onChange).toHaveBeenCalledWith('after')
  })

  it('keeps readOnly enforced when options try to override it', () => {
    render(
      <MonacoTextEditor
        ariaLabel="配置值"
        value="locked"
        onChange={vi.fn()}
        readOnly
        options={{ readOnly: false, domReadOnly: false }}
      />,
    )

    expect(monacoEditorMock.props.at(-1)?.options).toMatchObject({
      readOnly: true,
      domReadOnly: true,
    })
  })

  it('disposes resources registered by onMount when the editor is disposed', () => {
    const disposable = { dispose: vi.fn() }

    render(
      <MonacoTextEditor
        ariaLabel="配置值"
        value=""
        onChange={vi.fn()}
        onEditorMount={() => disposable}
      />,
    )

    monacoEditorMock.disposeLast()

    expect(disposable.dispose).toHaveBeenCalledTimes(1)
  })

  it('shows a visible error and logs the full object when Monaco render fails', async () => {
    const err = new Error('render failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function BrokenEditor() {
      throw err
    }

    try {
      render(
        <MonacoRenderErrorBoundary fallback={<div role="alert">编辑器加载失败</div>}>
          <BrokenEditor />
        </MonacoRenderErrorBoundary>,
      )

      expect((await screen.findByRole('alert')).textContent).toContain('编辑器加载失败')
      expect(consoleError).toHaveBeenCalledWith({ err }, 'Failed to render Monaco editor')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('shows a visible error and logs the full object when Monaco mount fails', async () => {
    const err = new Error('mount failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      render(
        <MonacoTextEditor
          ariaLabel="配置值"
          value=""
          onChange={vi.fn()}
          onEditorMount={() => {
            throw err
          }}
        />,
      )

      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('编辑器加载失败'))
      expect(consoleError).toHaveBeenCalledWith({ err }, 'Failed to mount Monaco editor')
    } finally {
      consoleError.mockRestore()
    }
  })
})
