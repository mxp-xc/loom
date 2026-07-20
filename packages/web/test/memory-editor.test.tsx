// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MemoryEditor from '../src/components/MemoryEditor'
import { ApiError, api } from '../src/lib/api'
import { createMonacoEditorMock } from './monaco-test-utils'

const monacoEditorMock = createMonacoEditorMock()

const editorMocks = vi.hoisted(() => ({
  monacoProviderDispose: vi.fn(),
}))

const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
}))

function monacoLineModel(line: string) {
  return {
    getValueInRange: ({ startColumn, endColumn }: { startColumn: number; endColumn: number }) =>
      line.slice(startColumn - 1, endColumn - 1),
  }
}

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  const monacoModule = createMonacoEditorMock().module()
  return {
    default: (props: any) =>
      monacoModule.default({
        ...props,
        onMount: (editor: any, monaco: any) => {
          const registerCompletionItemProvider =
            monaco.languages.registerCompletionItemProvider.bind(monaco.languages)
          monaco.languages.registerCompletionItemProvider = vi.fn(
            (language: string, provider: any) => {
              registerCompletionItemProvider(language, provider)
              return { dispose: editorMocks.monacoProviderDispose }
            },
          )
          props.onMount?.(editor, monaco)
        },
      }),
  }
})

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')
  return {
    ...actual,
    api: {
      getOpenPathPreference: vi.fn(() => new Promise(() => {})),
      setOpenPathPreference: vi.fn(),
      resolvePath: vi.fn(),
      openPath: vi.fn(),
      previewMemory: vi.fn(),
      vars: {
        getMatrix: vi.fn(async () => ({
          ok: true,
          agent: 'codex',
          builtinKeys: ['LOOM_REPO'],
          userKeys: ['API_URL', 'PORT'],
          snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
          resolution: {
            ok: true,
            values: {},
            sources: {},
            overrideChains: {},
            dependencies: {},
            diagnostics: [],
          },
        })),
      },
    },
  }
})

vi.mock('../src/hooks/useToast', () => ({
  useToast: () => toastMocks,
}))

describe('MemoryEditor', () => {
  beforeEach(() => {
    monacoEditorMock.reset()
    document.documentElement.setAttribute('data-theme', 'light')
    vi.clearAllMocks()
  })

  it('keeps editing available without agent preview when agents are empty', () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Default"
        agents={[]}
        onSave={async () => {}}
      />,
    )

    expect(screen.getByRole('tab', { name: '所见' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '源码' })).toBeDefined()
    expect(screen.queryByRole('tab', { name: '解析预览' })).toBeNull()
    expect(screen.queryByRole('button', { name: '复制路径' })).toBeNull()
    expect(api.vars.getMatrix).not.toHaveBeenCalled()
    expect(api.previewMemory).not.toHaveBeenCalled()
  })

  it('uses the standard Markdown preview and Monaco for source editing', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const content = '| 场景 | 规则 |\n|---|---|\n| Memory | 使用 rich editor |'
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content={content}
        agents={['codex']}
        onSave={onSave}
      />,
    )

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '所见',
      '源码',
      '解析',
    ])
    expect(screen.getByRole('tab', { name: '所见' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.queryByRole('listbox', { name: '变量引用建议' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    const source = screen.getByRole('textbox', { name: 'Memory 内容' }) as HTMLTextAreaElement
    expect(source.value).toBe(content)
    fireEvent.change(source, { target: { value: '## Source edit' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('## Source edit'))
  })

  it('keeps edited content dirty when saving fails', async () => {
    const error = new Error('save failed')
    const onSave = vi.fn().mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Original"
        agents={['codex']}
        onSave={onSave}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory 内容' }), {
      target: { value: '# Edited' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('# Edited'))
    expect(screen.getByRole('button', { name: '保存' })).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith({ err: error }, 'Failed to save Memory content')
    consoleError.mockRestore()
  })

  it('saves the current source with Ctrl+S and prevents the browser save dialog', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Original"
        agents={['codex']}
        onSave={onSave}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory 内容' }), {
      target: { value: '# Saved by shortcut' },
    })
    const saveEvent = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      window.dispatchEvent(saveEvent)
    })

    expect(saveEvent.defaultPrevented).toBe(true)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('# Saved by shortcut'))
  })

  it('closes the Memory actions menu with Escape and restores trigger focus', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Default"
        agents={['codex']}
        onSave={async () => {}}
        onRename={() => {}}
      />,
    )

    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))

    const trigger = screen.getByRole('button', { name: '管理 Memory' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('registers Monaco variable completion with disposable provider', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content=""
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
    expect(monacoEditorMock.providers.at(-1)).toBeTruthy()

    const result = monacoEditorMock.providers
      .at(-1)
      .provideCompletionItems(monacoLineModel('$' + '{AP'), {
        lineNumber: 1,
        column: 5,
      })
    expect(result.suggestions[0]).toMatchObject({
      label: 'API_URL',
      insertText: '$' + '{API_URL}',
      filterText: '$' + '{AP',
    })
    expect(result.suggestions[0].range.startColumn).toBe(1)
    expect(result.suggestions[0].range.endColumn).toBe(5)

    const autoClosed = monacoEditorMock.providers
      .at(-1)
      .provideCompletionItems(monacoLineModel('$' + '{AP}'), { lineNumber: 1, column: 5 })
    expect(autoClosed.suggestions[0]).toMatchObject({
      label: 'API_URL',
      insertText: '$' + '{API_URL}',
      filterText: '$' + '{AP',
    })
    expect(autoClosed.suggestions[0].range.startColumn).toBe(1)
    expect(autoClosed.suggestions[0].range.endColumn).toBe(6)

    expect(monacoEditorMock.disposeCallbacks.length).toBeGreaterThan(0)
    monacoEditorMock.disposeLast()
    expect(editorMocks.monacoProviderDispose).toHaveBeenCalledTimes(1)
  })

  it('keeps Monaco source editor on the built-in theme that matches the current UI', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')

    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content=""
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    expect(monacoEditorMock.props.at(-1)?.theme).toBe('vs-dark')

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light')
      await Promise.resolve()
    })

    expect(monacoEditorMock.props.at(-1)?.theme).toBe('vs')
  })

  it('keeps the standard preview read-only without variable completion', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Preview first"
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Preview first' })).toBeTruthy()
    expect(screen.queryByRole('listbox', { name: '变量引用建议' })).toBeNull()
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
  })

  it('keeps markdown comments visible in the standard preview', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="<!-- CODEGRAPH_START -->\n\nVisible notes\n\n<!-- CODEGRAPH_END -->"
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    const preview = document.querySelector('.md-preview')
    expect(preview?.textContent).toContain('<!-- CODEGRAPH_START -->')
    expect(preview?.textContent).toContain('<!-- CODEGRAPH_END -->')
    expect(preview?.textContent).toContain('Visible notes')
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
  })

  it('renders content after a CommonMark angle-bracket link destination', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content={'[My Report](</abs/path/My Project/My Report.md:3>)\n\nContent after the link'}
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    expect(screen.getByRole('link', { name: 'My Report' })).toBeTruthy()
    expect(screen.getByText('Content after the link')).toBeTruthy()
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
  })

  it('copies the current raw Markdown including unsaved source edits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Saved"
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory 内容' }), {
      target: { value: '# Unsaved raw Markdown' },
    })
    fireEvent.click(screen.getByRole('button', { name: '复制 Memory 原始内容' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Unsaved raw Markdown'))
    expect(toastMocks.showToast).toHaveBeenCalledWith('已复制')
    expect(screen.getByRole('button', { name: '已复制 Memory 原始内容' })).toBeTruthy()
  })

  it('logs and reports clipboard failures', async () => {
    const cause = new Error('clipboard denied')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(cause) },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      render(
        <MemoryEditor
          repo="/repo"
          name="default"
          content="raw"
          agents={['codex']}
          onSave={async () => {}}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: '复制 Memory 原始内容' }))

      await waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith({ err: cause }, 'Failed to copy memory content'),
      )
      expect(toastMocks.showErrorToast).toHaveBeenCalledWith(cause, {
        title: '复制失败',
        message: '请检查剪贴板权限后重试',
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('shows structured resolver diagnostics in the agent rendered preview', async () => {
    const missingMemory = 'Use ' + '$' + '{memory.rtk}'
    const cause = new ApiError('render failed', 400, 'render_failed', [
      {
        code: 'MISSING_REFERENCE',
        severity: 'error',
        message: '变量不存在: memory.rtk',
        key: 'memory.rtk',
        path: ['memory.rtk'],
      },
    ])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      vi.mocked(api.previewMemory).mockRejectedValue(cause)

      render(
        <MemoryEditor
          repo="/repo"
          name="default"
          content={missingMemory}
          agents={['codex']}
          onSave={async () => {}}
        />,
      )

      fireEvent.click(screen.getByRole('tab', { name: '解析' }))

      await waitFor(() =>
        expect(api.previewMemory).toHaveBeenCalledWith({
          repo: '/repo',
          content: missingMemory,
          agent: 'codex',
        }),
      )
      const diagnostics = await screen.findByLabelText('解析诊断')
      expect(diagnostics.textContent).toContain('MISSING_REFERENCE')
      expect(diagnostics.textContent).toContain('key=memory.rtk')
      expect(diagnostics.textContent).toContain('path=memory.rtk')
      expect(errorSpy).toHaveBeenCalledWith({ err: cause }, 'Failed to preview memory')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps markdown comments visible in the resolved preview', async () => {
    vi.mocked(api.previewMemory).mockResolvedValue({
      rendered: '<!-- CODEGRAPH_START -->\n\nResolved notes\n\n<!-- CODEGRAPH_END -->',
      diagnostics: [],
    } as never)

    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="Memory"
        agents={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '解析' }))

    const resolvedText = await screen.findByText('Resolved notes')
    const preview = resolvedText.closest('.md-preview')
    expect(preview?.textContent).toContain('<!-- CODEGRAPH_START -->')
    expect(preview?.textContent).toContain('<!-- CODEGRAPH_END -->')
  })

  it('clears the previous rendered preview when the current draft fails to resolve', async () => {
    const cause = new ApiError('render failed', 400, 'render_failed', [
      {
        code: 'MISSING_REFERENCE',
        severity: 'error',
        message: '变量不存在: missing',
        key: 'missing',
      },
    ])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      vi.mocked(api.previewMemory)
        .mockResolvedValueOnce({
          rendered: 'Rendered once',
          diagnostics: [],
        } as never)
        .mockRejectedValueOnce(cause)

      render(
        <MemoryEditor
          repo="/repo"
          name="default"
          content={'Use ' + '$' + '{ok}'}
          agents={['codex']}
          onSave={async () => {}}
        />,
      )

      fireEvent.click(screen.getByRole('tab', { name: '解析' }))
      expect(await screen.findByText('Rendered once')).toBeTruthy()

      fireEvent.click(screen.getByRole('tab', { name: '源码' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Memory 内容' }), {
        target: { value: 'Use ' + '$' + '{missing}' },
      })
      fireEvent.click(screen.getByRole('tab', { name: '解析' }))

      await screen.findByLabelText('解析诊断')
      expect(screen.queryByText('Rendered once')).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith({ err: cause }, 'Failed to preview memory')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
